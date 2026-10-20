//! Replays the test vectors of the TypeScript `upto` package
//! (`packages/upto/test/fixtures/upto-stellar-vectors.json`) against the contract: the terms, the
//! payer's tree, both signature payloads and the settle arguments encode the same bytes as the
//! contract's own types, and the contract-account payer's signed entry settles on the host with
//! real signature checks.
use ed25519_dalek::{Signer as _, SigningKey, Verifier as _};
use serde_json::Value;
use soroban_env_host::Env as _;
use soroban_sdk::{
    auth::{Context, CustomAccountInterface},
    contract, contracterror, contractimpl,
    crypto::Hash,
    symbol_short,
    testutils::{EnvTestConfig, Ledger as _},
    xdr::{
        self, HashIdPreimage, HashIdPreimageSorobanAuthorization,
        HashIdPreimageSorobanAuthorizationWithAddress, InvokeContractArgs, Limits, ReadXdr,
        ScAddress, ScErrorCode, ScErrorType, ScSymbol, ScVal, SorobanAddressCredentials,
        SorobanAuthorizationEntry, SorobanAuthorizedFunction, SorobanAuthorizedInvocation,
        SorobanCredentials, VecM, WriteXdr,
    },
    Address, BytesN, Env, Error, IntoVal, String, Symbol, TryFromVal, Val, Vec,
};
use x402_upto_stellar::{UptoSettlement, UptoTerms};

mod test_token {
    soroban_sdk::contractimport!(file = "../../../packages/testkit/fixtures/test_token.wasm");
}

const VECTORS: &str =
    include_str!("../../../../packages/upto/test/fixtures/upto-stellar-vectors.json");

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum AccountError {
    NotInitialized = 1,
}

/// The vectors' contract-account payer: one ed25519 key, the raw 64-byte signature.
#[contract]
pub struct Ed25519Account;

#[contractimpl]
impl Ed25519Account {
    pub fn __constructor(env: Env, public_key: BytesN<32>) {
        env.storage()
            .instance()
            .set(&symbol_short!("pk"), &public_key);
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
        _auth_contexts: Vec<Context>,
    ) -> Result<(), AccountError> {
        let public_key: BytesN<32> = env
            .storage()
            .instance()
            .get(&symbol_short!("pk"))
            .ok_or(AccountError::NotInitialized)?;
        env.crypto()
            .ed25519_verify(&public_key, &signature_payload.into(), &signature);
        Ok(())
    }
}

struct Vectors {
    json: Value,
    env: Env,
}

impl Vectors {
    fn load() -> Self {
        let json: Value = serde_json::from_str(VECTORS).unwrap();
        let env = Env::new_with_config(EnvTestConfig {
            capture_snapshot_at_drop: false,
        });
        let network_id: [u8; 32] = hex::decode(json["networkId"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        env.ledger().with_mut(|ledger| {
            ledger.network_id = network_id;
            ledger.sequence_number = json["check"]["currentLedger"].as_u64().unwrap() as u32;
        });
        Self { json, env }
    }

    fn str(&self, pointer: &str) -> &str {
        self.json
            .pointer(pointer)
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("{pointer} is not a string"))
    }

    fn address(&self, pointer: &str) -> Address {
        Address::from_str(&self.env, self.str(pointer))
    }

    fn key(&self, seed: &str) -> SigningKey {
        let bytes: [u8; 32] = hex::decode(self.str(&std::format!("/seeds/{seed}")))
            .unwrap()
            .try_into()
            .unwrap();
        SigningKey::from_bytes(&bytes)
    }

    fn terms(&self) -> UptoTerms {
        UptoTerms {
            expiration_ledger: self.json["terms"]["expirationLedger"].as_u64().unwrap() as u32,
            facilitator: self.address("/terms/facilitator"),
            max_amount: self.str("/terms/maxAmount").parse().unwrap(),
            recipient: self.address("/terms/recipient"),
            token: self.address("/terms/token"),
            valid_after_ledger: self.json["terms"]["validAfterLedger"].as_u64().unwrap() as u32,
        }
    }

    fn sc<T: IntoVal<Env, Val>>(&self, value: T) -> ScVal {
        ScVal::try_from_val(&self.env, &value.into_val(&self.env)).unwrap()
    }

    fn payer_root(&self, payer: &Address) -> SorobanAuthorizedInvocation {
        let terms = self.terms();
        let upto = self.address("/contract");
        let approve = invocation(
            &terms.token,
            "approve",
            std::vec![
                self.sc(payer),
                self.sc(&upto),
                self.sc(terms.max_amount),
                self.sc(terms.expiration_ledger),
            ],
            std::vec![],
        );
        invocation(
            &upto,
            "settle",
            std::vec![self.sc(terms)],
            std::vec![approve],
        )
    }

    fn settle_args(&self, payer: &Address, amount: i128) -> InvokeContractArgs {
        InvokeContractArgs {
            contract_address: ScAddress::from(&self.address("/contract")),
            function_name: ScSymbol("settle".try_into().unwrap()),
            args: std::vec![self.sc(payer), self.sc(self.terms()), self.sc(amount)]
                .try_into()
                .unwrap(),
        }
    }
}

fn invocation(
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

fn b64<T: WriteXdr>(value: &T) -> std::string::String {
    value.to_xdr_base64(Limits::none()).unwrap()
}

fn entry(base64: &str) -> SorobanAuthorizationEntry {
    SorobanAuthorizationEntry::from_xdr_base64(base64, Limits::none()).unwrap()
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    use sha2::Digest as _;
    sha2::Sha256::digest(bytes).into()
}

#[test]
fn the_terms_encode_like_the_contract_type() {
    let v = Vectors::load();
    assert_eq!(b64(&v.sc(v.terms())), v.str("/termsXdr"));
}

#[test]
fn the_payer_tree_and_both_signature_payloads_match() {
    let v = Vectors::load();
    let payer = v.address("/payer");
    let root = v.payer_root(&payer);
    assert_eq!(b64(&root), v.str("/rootInvocationXdr"));
    assert_eq!(
        b64(&root.sub_invocations[0]),
        v.str("/approveInvocationXdr")
    );

    let key = v.key("payer");
    let network_id = xdr::Hash(v.env.ledger().network_id().to_array());
    let nonce: i64 = v.str("/nonce").parse().unwrap();
    let expiration = v.terms().expiration_ledger;
    for arm in ["address", "address_v2"] {
        let signed = entry(v.str(&std::format!("/credentials/{arm}/authorization")));
        assert_eq!(signed.root_invocation, root);
        let credentials = match &signed.credentials {
            SorobanCredentials::Address(c) if arm == "address" => c,
            SorobanCredentials::AddressV2(c) if arm == "address_v2" => c,
            _ => panic!("unexpected credentials for {arm}"),
        };
        assert_eq!(credentials.nonce, nonce);
        assert_eq!(credentials.signature_expiration_ledger, expiration);
        assert_eq!(credentials.address, ScAddress::from(&payer));

        let preimage = if arm == "address" {
            HashIdPreimage::SorobanAuthorization(HashIdPreimageSorobanAuthorization {
                network_id: network_id.clone(),
                nonce,
                signature_expiration_ledger: expiration,
                invocation: root.clone(),
            })
        } else {
            HashIdPreimage::SorobanAuthorizationWithAddress(
                HashIdPreimageSorobanAuthorizationWithAddress {
                    network_id: network_id.clone(),
                    nonce,
                    signature_expiration_ledger: expiration,
                    address: ScAddress::from(&payer),
                    invocation: root.clone(),
                },
            )
        };
        assert_eq!(
            b64(&preimage),
            v.str(&std::format!("/credentials/{arm}/preimageXdr"))
        );
        let payload = sha256(&preimage.to_xdr(Limits::none()).unwrap());
        assert_eq!(
            hex::encode(payload),
            v.str(&std::format!("/credentials/{arm}/payloadSha256"))
        );
        let signature = key.sign(&payload);
        assert_eq!(
            hex::encode(signature.to_bytes()),
            v.str(&std::format!("/credentials/{arm}/signature"))
        );
        key.verifying_key().verify(&payload, &signature).unwrap();
    }
}

#[test]
fn the_settle_arguments_and_authority_entry_match() {
    let v = Vectors::load();
    for payer_pointer in ["/payer", "/contractPayer/address"] {
        let payer = v.address(payer_pointer);
        let settles = if payer_pointer == "/payer" {
            v.json["settle"].as_array().unwrap().clone()
        } else {
            v.json["contractPayer"]["settle"]
                .as_array()
                .unwrap()
                .clone()
        };
        for settle in settles {
            let amount: i128 = settle["amount"].as_str().unwrap().parse().unwrap();
            let args = v.settle_args(&payer, amount);
            assert_eq!(
                b64(&args),
                settle["invokeContractArgsXdr"].as_str().unwrap()
            );
            let authority = SorobanAuthorizationEntry {
                credentials: SorobanCredentials::SourceAccount,
                root_invocation: SorobanAuthorizedInvocation {
                    function: SorobanAuthorizedFunction::ContractFn(args),
                    sub_invocations: VecM::default(),
                },
            };
            assert_eq!(
                b64(&authority),
                settle["authorityEntryXdr"].as_str().unwrap()
            );
        }
    }
}

/// The vectors' parties on a host: the upto contract, the test token at the vectors' token
/// address, and the contract-account payer, all at the addresses the vectors name.
struct Replay {
    v: Vectors,
    upto: Address,
    token: Address,
    payer: Address,
    recipient: Address,
}

const FUNDED: i128 = 10_000_000;

impl Replay {
    fn new() -> Self {
        let v = Vectors::load();
        let env = &v.env;
        let upto = v.address("/contract");
        let token = v.address("/token");
        let payer = v.address("/contractPayer/address");
        let recipient = v.address("/recipient");
        env.register_at(&upto, UptoSettlement, ());
        env.register_at(
            &token,
            test_token::WASM,
            (
                String::from_str(env, "USD Coin (test)"),
                String::from_str(env, "USDC"),
                7u32,
            ),
        );
        let public_key: [u8; 32] = hex::decode(v.str("/contractPayer/publicKey"))
            .unwrap()
            .try_into()
            .unwrap();
        env.register_at(
            &payer,
            Ed25519Account,
            (BytesN::from_array(env, &public_key),),
        );
        test_token::Client::new(env, &token).mint_test(&payer, &FUNDED);
        env.set_auths(&[]);
        let authority = v.key("authority");
        env.host()
            .set_source_account(xdr::AccountId(xdr::PublicKey::PublicKeyTypeEd25519(
                xdr::Uint256(authority.verifying_key().to_bytes()),
            )))
            .unwrap();
        Self {
            v,
            upto,
            token,
            payer,
            recipient,
        }
    }

    /// The `contractPayer.settle` vector that settles `amount`.
    fn settle_vector(&self, amount: i128) -> &Value {
        self.v.json["contractPayer"]["settle"]
            .as_array()
            .unwrap()
            .iter()
            .find(|settle| {
                settle["amount"].as_str().and_then(|text| text.parse().ok()) == Some(amount)
            })
            .unwrap_or_else(|| panic!("no contract payer settle vector for {amount}"))
    }

    /// Settles `amount` with the vectors' payer entry and the matching authority entry of
    /// `contractPayer.settle`, through the host so that granular errors are visible.
    fn settle(&self, amount: i128) -> Result<i128, Error> {
        let env = &self.v.env;
        let settle = self.settle_vector(amount);
        env.set_auths(&[
            entry(self.v.str("/contractPayer/authorization")),
            entry(settle["authorityEntryXdr"].as_str().unwrap()),
        ]);
        let call = InvokeContractArgs::from_xdr_base64(
            settle["invokeContractArgsXdr"].as_str().unwrap(),
            Limits::none(),
        )
        .unwrap();
        let mut args: Vec<Val> = Vec::new(env);
        for arg in call.args.iter() {
            args.push_back(Val::try_from_val(env, arg).unwrap());
        }
        env.host()
            .call(
                self.upto.to_object(),
                Symbol::new(env, "settle").to_symbol_val(),
                args.to_object(),
            )
            .map(|value| i128::try_from_val(env, &value).unwrap())
            .map_err(|error| error.error)
    }

    fn balance(&self, address: &Address) -> i128 {
        test_token::Client::new(&self.v.env, &self.token).balance(address)
    }
}

#[test]
fn the_contract_payer_entry_settles_once() {
    let r = Replay::new();
    assert_eq!(r.settle(300_000), Ok(300_000));
    assert_eq!(r.balance(&r.payer), FUNDED - 300_000);
    assert_eq!(r.balance(&r.recipient), 300_000);
    assert_eq!(r.balance(&r.upto), 0);
    assert_eq!(
        r.settle(300_000),
        Err(Error::from_type_and_code(
            ScErrorType::Auth,
            ScErrorCode::ExistingValue
        ))
    );
    assert_eq!(r.balance(&r.payer), FUNDED - 300_000);
}

#[test]
fn the_contract_payer_entry_settles_the_whole_cap() {
    let r = Replay::new();
    assert_eq!(r.settle(1_000_000), Ok(1_000_000));
    assert_eq!(r.balance(&r.payer), FUNDED - 1_000_000);
    assert_eq!(r.balance(&r.recipient), 1_000_000);
}

#[test]
fn the_contract_payer_entry_settles_zero() {
    let r = Replay::new();
    assert_eq!(r.settle(0), Ok(0));
    assert_eq!(r.balance(&r.payer), FUNDED);
    assert_eq!(r.balance(&r.recipient), 0);
}

#[test]
fn a_changed_signature_does_not_settle() {
    let r = Replay::new();
    let mut signed = entry(r.v.str("/contractPayer/authorization"));
    let SorobanCredentials::Address(SorobanAddressCredentials { signature, .. }) =
        &mut signed.credentials
    else {
        panic!("expected address credentials");
    };
    let ScVal::Bytes(bytes) = signature else {
        panic!("expected a raw signature");
    };
    let mut raw = bytes.to_vec();
    raw[0] ^= 0xff;
    *signature = ScVal::Bytes(raw.try_into().unwrap());
    let env = &r.v.env;
    let settle = r.settle_vector(300_000);
    env.set_auths(&[signed, entry(settle["authorityEntryXdr"].as_str().unwrap())]);
    let args: Vec<Val> = (r.payer.clone(), r.v.terms(), 300_000i128).into_val(env);
    let result = env.host().call(
        r.upto.to_object(),
        Symbol::new(env, "settle").to_symbol_val(),
        args.to_object(),
    );
    assert!(result.is_err());
    assert_eq!(r.balance(&r.payer), FUNDED);
}
