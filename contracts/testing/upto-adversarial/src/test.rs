//! Shared setup. Payer authorizations are either mocked (`Setup::authorize`) or really signed
//! (`Signed`), in which case the host checks signatures, nonces and expirations itself.
mod boundaries;
mod classic;
mod contexts;
mod hostile_token;
mod overlap;
mod replay;

use ed25519_dalek::{Signer as _, SigningKey};
use soroban_env_host::Env as _;
use soroban_sdk::{
    auth::{Context, CustomAccountInterface},
    contract, contracterror, contractimpl,
    crypto::Hash,
    symbol_short,
    testutils::{Address as _, EnvTestConfig, Ledger as _, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    xdr::{
        self, AccountId, HashIdPreimage, HashIdPreimageSorobanAuthorization,
        HashIdPreimageSorobanAuthorizationWithAddress, InvokeContractArgs, Limits, PublicKey,
        ScAddress, ScErrorCode, ScErrorType, ScSymbol, ScVal, SorobanAddressCredentials,
        SorobanAuthorizationEntry, SorobanAuthorizedFunction, SorobanAuthorizedInvocation,
        SorobanCredentials, Uint256, VecM, WriteXdr,
    },
    Address, Bytes, BytesN, Env, Error, IntoVal, Symbol, TryFromVal, Val, Vec,
};

pub(crate) mod upto {
    soroban_sdk::contractimport!(
        file = "../../../packages/testkit/fixtures/x402_upto_stellar.wasm"
    );
}

pub(crate) use upto::{UptoError, UptoTerms};

pub(crate) const START: u32 = 1_000;
pub(crate) const EXPIRATION: u32 = START + 60;
pub(crate) const MAX: i128 = 1_000_000;
pub(crate) const FUNDED: i128 = 10_000_000;

pub(crate) const PAYER_SEED: [u8; 32] = [1; 32];
pub(crate) const AUTHORITY_SEED: [u8; 32] = [2; 32];

pub(crate) fn test_env() -> Env {
    let env = Env::new_with_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    env.ledger().set_sequence_number(START);
    env
}

/// The deployed contract, a Stellar Asset Contract, and a funded payer.
pub(crate) struct Setup {
    pub env: Env,
    pub upto: Address,
    pub token: Address,
    pub payer: Address,
    pub facilitator: Address,
    pub recipient: Address,
}

impl Setup {
    pub fn new() -> Self {
        let env = test_env();
        let payer = Address::generate(&env);
        Self::with_payer(env, payer)
    }

    pub fn with_payer(env: Env, payer: Address) -> Self {
        let upto = env.register(upto::WASM, ());
        let issuer = Address::generate(&env);
        let token = env.register_stellar_asset_contract_v2(issuer).address();
        env.mock_all_auths();
        StellarAssetClient::new(&env, &token).mint(&payer, &FUNDED);
        let facilitator = Address::generate(&env);
        let recipient = Address::generate(&env);
        // Replace the blanket mock with an empty, enforcing authorization list.
        env.set_auths(&[]);
        Self {
            env,
            upto,
            token,
            payer,
            facilitator,
            recipient,
        }
    }

    pub fn token(&self) -> TokenClient<'_> {
        TokenClient::new(&self.env, &self.token)
    }

    pub fn terms(&self, max_amount: i128) -> UptoTerms {
        UptoTerms {
            expiration_ledger: EXPIRATION,
            facilitator: self.facilitator.clone(),
            max_amount,
            recipient: self.recipient.clone(),
            token: self.token.clone(),
            valid_after_ledger: 0,
        }
    }

    pub fn balance(&self, address: &Address) -> i128 {
        self.token().balance(address)
    }

    pub fn allowance(&self) -> i128 {
        self.token().allowance(&self.payer, &self.upto)
    }

    /// Mocks the payer's `settle(terms)` tree with its exact `approve` child and, when
    /// `facilitator_amount` is set, the authority's `settle(payer, terms, amount)` entry.
    pub fn authorize(&self, terms: &UptoTerms, facilitator_amount: Option<i128>) {
        let env = &self.env;
        let approve = [MockAuthInvoke {
            contract: &terms.token,
            fn_name: "approve",
            args: (
                &self.payer,
                &self.upto,
                terms.max_amount,
                terms.expiration_ledger,
            )
                .into_val(env),
            sub_invokes: &[],
        }];
        let payer_root = MockAuthInvoke {
            contract: &self.upto,
            fn_name: "settle",
            args: (terms.clone(),).into_val(env),
            sub_invokes: &approve,
        };
        let facilitator_root = facilitator_amount.map(|amount| MockAuthInvoke {
            contract: &self.upto,
            fn_name: "settle",
            args: (&self.payer, terms.clone(), amount).into_val(env),
            sub_invokes: &[],
        });
        let mut auths = std::vec![MockAuth {
            address: &self.payer,
            invoke: &payer_root,
        }];
        if let Some(invoke) = &facilitator_root {
            auths.push(MockAuth {
                address: &terms.facilitator,
                invoke,
            });
        }
        env.mock_auths(&auths);
    }

    pub fn try_settle(&self, terms: &UptoTerms, amount: i128) -> Result<i128, Error> {
        invoke_settle(&self.env, &self.upto, &self.payer, terms, amount)
    }
}

/// Calls `settle` through the host directly, so the granular host error (for example
/// `Error(Auth, InvalidAction)`) is visible instead of the narrowed `try_` client error.
pub(crate) fn invoke_settle(
    env: &Env,
    upto: &Address,
    payer: &Address,
    terms: &UptoTerms,
    amount: i128,
) -> Result<i128, Error> {
    let args: Vec<Val> = (payer.clone(), terms.clone(), amount).into_val(env);
    let symbol = Symbol::new(env, "settle");
    let result = env
        .host()
        .call(upto.to_object(), symbol.to_symbol_val(), args.to_object());
    match result {
        Ok(value) => Ok(i128::try_from_val(env, &value).expect("settle returns an i128")),
        Err(error) => Err(error.error),
    }
}

pub(crate) fn auth_error(code: ScErrorCode) -> Error {
    Error::from_type_and_code(ScErrorType::Auth, code)
}

pub(crate) fn contract_error(error: UptoError) -> Error {
    Error::from_contract_error(error as u32)
}

pub(crate) fn sc<T: IntoVal<Env, Val>>(env: &Env, value: T) -> ScVal {
    ScVal::try_from_val(env, &value.into_val(env)).unwrap()
}

pub(crate) fn account_id(key: &SigningKey) -> AccountId {
    AccountId(PublicKey::PublicKeyTypeEd25519(Uint256(
        key.verifying_key().to_bytes(),
    )))
}

pub(crate) fn g_address(env: &Env, key: &SigningKey) -> Address {
    Address::try_from_val(env, &ScVal::Address(ScAddress::Account(account_id(key)))).unwrap()
}

pub(crate) fn invocation(
    contract: &Address,
    function: &str,
    args: std::vec::Vec<ScVal>,
    children: std::vec::Vec<SorobanAuthorizedInvocation>,
) -> SorobanAuthorizedInvocation {
    SorobanAuthorizedInvocation {
        function: SorobanAuthorizedFunction::ContractFn(InvokeContractArgs {
            contract_address: ScAddress::from(contract),
            function_name: ScSymbol(function.try_into().unwrap()),
            args: args.try_into().unwrap(),
        }),
        sub_invocations: children.try_into().unwrap_or_else(|_| VecM::default()),
    }
}

/// The payer's tree: `settle(terms)` with the `approve(payer, upto, max, expiration)` child.
pub(crate) fn payer_root(
    env: &Env,
    upto: &Address,
    payer: &Address,
    terms: &UptoTerms,
) -> SorobanAuthorizedInvocation {
    let approve = invocation(
        &terms.token,
        "approve",
        std::vec![
            sc(env, payer),
            sc(env, upto),
            sc(env, terms.max_amount),
            sc(env, terms.expiration_ledger),
        ],
        std::vec![],
    );
    invocation(
        upto,
        "settle",
        std::vec![sc(env, terms.clone())],
        std::vec![approve],
    )
}

/// The authority's entry with `SOURCE_ACCOUNT` credentials: no signature and no nonce.
pub(crate) fn authority_entry(
    env: &Env,
    upto: &Address,
    payer: &Address,
    terms: &UptoTerms,
    amount: i128,
) -> SorobanAuthorizationEntry {
    SorobanAuthorizationEntry {
        credentials: SorobanCredentials::SourceAccount,
        root_invocation: invocation(
            upto,
            "settle",
            std::vec![sc(env, payer), sc(env, terms.clone()), sc(env, amount)],
            std::vec![],
        ),
    }
}

#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Credentials {
    V1,
    V2,
}

/// The sha256 signature payload of an authorization entry over the ledger's current network.
pub(crate) fn signature_payload(
    env: &Env,
    address: &Address,
    root: &SorobanAuthorizedInvocation,
    nonce: i64,
    expiration: u32,
    credentials: Credentials,
) -> [u8; 32] {
    let network_id = xdr::Hash(env.ledger().network_id().to_array());
    let preimage = match credentials {
        Credentials::V1 => {
            HashIdPreimage::SorobanAuthorization(HashIdPreimageSorobanAuthorization {
                network_id,
                nonce,
                signature_expiration_ledger: expiration,
                invocation: root.clone(),
            })
        }
        Credentials::V2 => HashIdPreimage::SorobanAuthorizationWithAddress(
            HashIdPreimageSorobanAuthorizationWithAddress {
                network_id,
                nonce,
                signature_expiration_ledger: expiration,
                address: ScAddress::from(address),
                invocation: root.clone(),
            },
        ),
    };
    let payload = preimage.to_xdr(Limits::none()).unwrap();
    env.crypto()
        .sha256(&Bytes::from_slice(env, &payload))
        .to_array()
}

pub(crate) fn address_entry(
    address: &Address,
    root: SorobanAuthorizedInvocation,
    nonce: i64,
    expiration: u32,
    signature: ScVal,
    credentials: Credentials,
) -> SorobanAuthorizationEntry {
    let address_credentials = SorobanAddressCredentials {
        address: ScAddress::from(address),
        nonce,
        signature_expiration_ledger: expiration,
        signature,
    };
    SorobanAuthorizationEntry {
        credentials: match credentials {
            Credentials::V1 => SorobanCredentials::Address(address_credentials),
            Credentials::V2 => SorobanCredentials::AddressV2(address_credentials),
        },
        root_invocation: root,
    }
}

/// Signs `root` for the ed25519 contract account `address` with `key`.
pub(crate) fn sign_contract_entry(
    env: &Env,
    address: &Address,
    key: &SigningKey,
    root: SorobanAuthorizedInvocation,
    nonce: i64,
    expiration: u32,
    credentials: Credentials,
) -> SorobanAuthorizationEntry {
    let digest = signature_payload(env, address, &root, nonce, expiration, credentials);
    let signature = sc(env, BytesN::from_array(env, &key.sign(&digest).to_bytes()));
    address_entry(address, root, nonce, expiration, signature, credentials)
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum AccountError {
    NotInitialized = 1,
}

/// Minimal ed25519 contract account: one key, any context. It records the function names of the
/// contexts it was asked to authorize, so tests can see what a wallet's policy would see.
#[contract]
pub struct Ed25519Account;

#[contractimpl]
impl Ed25519Account {
    pub fn __constructor(env: Env, public_key: BytesN<32>) {
        env.storage()
            .instance()
            .set(&symbol_short!("pk"), &public_key);
    }

    pub fn seen(env: Env) -> Vec<Symbol> {
        env.storage()
            .instance()
            .get(&symbol_short!("seen"))
            .unwrap_or_else(|| Vec::new(&env))
    }
}

#[contractimpl]
impl CustomAccountInterface for Ed25519Account {
    type Signature = BytesN<64>;
    type Error = AccountError;

    fn __check_auth(
        env: Env,
        signature_payload: Hash<32>,
        signature: BytesN<64>,
        auth_contexts: Vec<Context>,
    ) -> Result<(), AccountError> {
        let public_key: BytesN<32> = env
            .storage()
            .instance()
            .get(&symbol_short!("pk"))
            .ok_or(AccountError::NotInitialized)?;
        env.crypto()
            .ed25519_verify(&public_key, &signature_payload.into(), &signature);
        let mut seen = Vec::new(&env);
        for context in auth_contexts.iter() {
            if let Context::Contract(call) = context {
                seen.push_back(call.fn_name);
            }
        }
        env.storage().instance().set(&symbol_short!("seen"), &seen);
        Ok(())
    }
}

/// A contract-account payer with a real key, and a `G…` authority that is the transaction's
/// source account.
pub(crate) struct Signed {
    pub s: Setup,
    pub payer_key: SigningKey,
}

impl Signed {
    pub fn new() -> Self {
        let env = test_env();
        let payer_key = SigningKey::from_bytes(&PAYER_SEED);
        let authority_key = SigningKey::from_bytes(&AUTHORITY_SEED);
        let payer = env.register(
            Ed25519Account,
            (BytesN::from_array(
                &env,
                &payer_key.verifying_key().to_bytes(),
            ),),
        );
        let mut s = Setup::with_payer(env, payer);
        s.facilitator = g_address(&s.env, &authority_key);
        s.env
            .host()
            .set_source_account(account_id(&authority_key))
            .unwrap();
        Self { s, payer_key }
    }

    pub fn payer_entry(
        &self,
        terms: &UptoTerms,
        nonce: i64,
        credentials: Credentials,
    ) -> SorobanAuthorizationEntry {
        let env = &self.s.env;
        sign_contract_entry(
            env,
            &self.s.payer,
            &self.payer_key,
            payer_root(env, &self.s.upto, &self.s.payer, terms),
            nonce,
            terms.expiration_ledger,
            credentials,
        )
    }

    pub fn authority_entry(&self, terms: &UptoTerms, amount: i128) -> SorobanAuthorizationEntry {
        authority_entry(&self.s.env, &self.s.upto, &self.s.payer, terms, amount)
    }

    pub fn settle(
        &self,
        entries: &[SorobanAuthorizationEntry],
        terms: &UptoTerms,
        amount: i128,
    ) -> Result<i128, Error> {
        self.s.env.set_auths(entries);
        invoke_settle(&self.s.env, &self.s.upto, &self.s.payer, terms, amount)
    }

    pub fn payer_balance(&self) -> i128 {
        self.s.balance(&self.s.payer)
    }
}

/// sha256 of the wasm deployed on testnet (`contracts/stellar/deployments/testnet.json`).
const DEPLOYED_WASM_SHA256: &str =
    "cc2d2fefe77d1a470abe88be8563679a9d40f49c127683947784c0cb2d0ca797";

#[test]
fn the_wasm_under_test_is_the_deployed_build() {
    let s = Setup::new();
    let digest = s
        .env
        .crypto()
        .sha256(&Bytes::from_slice(&s.env, upto::WASM))
        .to_array();
    let hex: std::string::String = digest.iter().map(|b| std::format!("{b:02x}")).collect();
    assert_eq!(hex, DEPLOYED_WASM_SHA256);
    assert_eq!(upto::Client::new(&s.env, &s.upto).version(), 1);
}
