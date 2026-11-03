extern crate std;

use ed25519_dalek::{Signer as _, SigningKey};
use soroban_sdk::{
    testutils::{Address as _, EnvTestConfig, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    vec,
    xdr::{
        self, HashIdPreimage, HashIdPreimageSorobanAuthorization, InvokeContractArgs, Limits,
        ScAddress, ScSymbol, ScVal, SorobanAddressCredentials, SorobanAuthorizationEntry,
        SorobanAuthorizedFunction, SorobanAuthorizedInvocation, SorobanCredentials, VecM, WriteXdr,
    },
    Address, Bytes, BytesN, Env, Error, IntoVal, Symbol, TryFromVal, Val,
};

use crate::{AccountError, Ed25519Account, OWNER};

const FUNDED: i128 = 5_000_000;
const OWNER_SEED: [u8; 32] = [1; 32];
const STRANGER_SEED: [u8; 32] = [2; 32];

fn public_key(env: &Env, key: &SigningKey) -> BytesN<32> {
    BytesN::from_array(env, &key.verifying_key().to_bytes())
}

fn sc<T: IntoVal<Env, Val>>(env: &Env, value: T) -> ScVal {
    ScVal::try_from_val(env, &value.into_val(env)).unwrap()
}

/// An account owned by `OWNER_SEED` holding `FUNDED` units of a Stellar Asset Contract.
struct Setup {
    env: Env,
    owner: SigningKey,
    stranger: SigningKey,
    account: Address,
    token: Address,
}

impl Setup {
    fn new() -> Self {
        let env = Env::new_with_config(EnvTestConfig {
            capture_snapshot_at_drop: false,
        });
        env.ledger().set_sequence_number(1_000);
        let owner = SigningKey::from_bytes(&OWNER_SEED);
        let account = env.register(Ed25519Account, (public_key(&env, &owner),));
        let token = env
            .register_stellar_asset_contract_v2(Address::generate(&env))
            .address();
        env.mock_all_auths();
        StellarAssetClient::new(&env, &token).mint(&account, &FUNDED);
        // Replace the blanket mock with an empty, enforcing authorization list.
        env.set_auths(&[]);
        Self {
            env,
            owner,
            stranger: SigningKey::from_bytes(&STRANGER_SEED),
            account,
            token,
        }
    }

    fn balance(&self, address: &Address) -> i128 {
        TokenClient::new(&self.env, &self.token).balance(address)
    }

    fn stored_owner(&self) -> Option<BytesN<32>> {
        self.env
            .as_contract(&self.account, || self.env.storage().instance().get(&OWNER))
    }

    /// The account's authorization of `transfer(account, to, amount)`, signed by `key` the way a
    /// wallet signs it: ed25519 over sha256 of the SorobanAuthorization preimage.
    fn signed_transfer(
        &self,
        key: &SigningKey,
        to: &Address,
        amount: i128,
        nonce: i64,
    ) -> SorobanAuthorizationEntry {
        let env = &self.env;
        let expiration = env.ledger().sequence() + 20;
        let invocation = SorobanAuthorizedInvocation {
            function: SorobanAuthorizedFunction::ContractFn(InvokeContractArgs {
                contract_address: ScAddress::from(&self.token),
                function_name: ScSymbol("transfer".try_into().unwrap()),
                args: std::vec![sc(env, &self.account), sc(env, to), sc(env, amount)]
                    .try_into()
                    .unwrap(),
            }),
            sub_invocations: VecM::default(),
        };
        let preimage = HashIdPreimage::SorobanAuthorization(HashIdPreimageSorobanAuthorization {
            network_id: xdr::Hash(env.ledger().network_id().to_array()),
            nonce,
            signature_expiration_ledger: expiration,
            invocation: invocation.clone(),
        });
        let payload = env
            .crypto()
            .sha256(&Bytes::from_slice(
                env,
                &preimage.to_xdr(Limits::none()).unwrap(),
            ))
            .to_array();
        let signature = BytesN::<64>::from_array(env, &key.sign(&payload).to_bytes());
        SorobanAuthorizationEntry {
            credentials: SorobanCredentials::Address(SorobanAddressCredentials {
                address: ScAddress::from(&self.account),
                nonce,
                signature_expiration_ledger: expiration,
                signature: sc(env, signature),
            }),
            root_invocation: invocation,
        }
    }

    /// Transfers `amount` from the account to `to` with an authorization signed by `key`; true when
    /// the transfer happened.
    fn transfer_signed_by(&self, key: &SigningKey, to: &Address, amount: i128, nonce: i64) -> bool {
        let env = &self.env;
        env.set_auths(&[self.signed_transfer(key, to, amount, nonce)]);
        let result = env.try_invoke_contract::<(), Error>(
            &self.token,
            &Symbol::new(env, "transfer"),
            vec![
                env,
                self.account.into_val(env),
                to.into_val(env),
                amount.into_val(env),
            ],
        );
        env.set_auths(&[]);
        matches!(result, Ok(Ok(())))
    }
}

#[test]
fn the_constructor_binds_the_owner() {
    let setup = Setup::new();
    assert_eq!(
        setup.stored_owner(),
        Some(public_key(&setup.env, &setup.owner))
    );
}

#[test]
fn the_owner_key_authorizes_a_transfer() {
    let setup = Setup::new();
    let recipient = Address::generate(&setup.env);
    assert!(setup.transfer_signed_by(&setup.owner, &recipient, 1_000, 1));
    assert_eq!(setup.balance(&recipient), 1_000);
    assert_eq!(setup.balance(&setup.account), FUNDED - 1_000);
}

#[test]
fn another_key_authorizes_nothing() {
    let setup = Setup::new();
    let recipient = Address::generate(&setup.env);
    assert!(!setup.transfer_signed_by(&setup.stranger, &recipient, 1_000, 1));
    assert_eq!(setup.balance(&setup.account), FUNDED);
}

#[test]
fn no_call_replaces_the_owner() {
    let setup = Setup::new();
    let env = &setup.env;
    let stranger_key = public_key(env, &setup.stranger);
    // Even with every authorization granted, nothing reachable after creation sets the owner: the
    // functions do not exist and the host runs the constructor only while it creates the contract.
    env.mock_all_auths();
    for function in ["init", "set_owner", "__constructor"] {
        let result = env.try_invoke_contract::<(), Error>(
            &setup.account,
            &Symbol::new(env, function),
            vec![env, stranger_key.into_val(env)],
        );
        assert!(result.is_err(), "{function} was accepted");
    }
    env.set_auths(&[]);
    assert_eq!(setup.stored_owner(), Some(public_key(env, &setup.owner)));

    // The stranger still cannot move the balance, and the owner can move all of it.
    let stranger = Address::generate(env);
    let treasury = Address::generate(env);
    assert!(!setup.transfer_signed_by(&setup.stranger, &stranger, FUNDED, 1));
    assert!(setup.transfer_signed_by(&setup.owner, &treasury, FUNDED, 2));
    assert_eq!(setup.balance(&treasury), FUNDED);
    assert_eq!(setup.balance(&setup.account), 0);
}

#[test]
fn a_signature_counts_only_for_the_payload_it_signs() {
    let setup = Setup::new();
    let env = &setup.env;
    let signed = BytesN::<32>::from_array(env, &[7; 32]);
    let other = BytesN::<32>::from_array(env, &[8; 32]);
    let signature = BytesN::<64>::from_array(env, &setup.owner.sign(&signed.to_array()).to_bytes());
    let contexts = vec![env];
    let check = |payload: &BytesN<32>| {
        env.try_invoke_contract_check_auth::<AccountError>(
            &setup.account,
            payload,
            signature.clone().into_val(env),
            &contexts,
        )
    };
    assert_eq!(check(&signed), Ok(()));
    assert!(check(&other).is_err());
}
