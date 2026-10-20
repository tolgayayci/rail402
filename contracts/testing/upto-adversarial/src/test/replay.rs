//! An authorization is bound to its network, to this deployment and to the named authority.
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Ledger as _, MockAuth, MockAuthInvoke},
    xdr::ScErrorCode,
    Address, Env, IntoVal,
};

use super::{
    auth_error, authority_entry, invoke_settle, upto, Credentials, Setup, Signed, UptoTerms,
    EXPIRATION, FUNDED, MAX,
};

/// A contract that tries to settle a payment it was handed, without the authority.
#[contract]
pub struct Wrapper;

#[contractimpl]
impl Wrapper {
    pub fn go(env: Env, upto: Address, payer: Address, terms: UptoTerms, amount: i128) -> i128 {
        upto::Client::new(&env, &upto).settle(&payer, &terms, &amount)
    }
}

#[test]
fn a_wrapper_contract_cannot_settle_without_the_authority() {
    let s = Setup::new();
    let wrapper = s.env.register(Wrapper, ());
    let terms = s.terms(MAX);
    let approve = [MockAuthInvoke {
        contract: &s.token,
        fn_name: "approve",
        args: (&s.payer, &s.upto, MAX, EXPIRATION).into_val(&s.env),
        sub_invokes: &[],
    }];
    let root = MockAuthInvoke {
        contract: &s.upto,
        fn_name: "settle",
        args: (terms.clone(),).into_val(&s.env),
        sub_invokes: &approve,
    };
    // Only the payer's authorization: the facilitator named in the terms never signed.
    s.env.mock_auths(&[MockAuth {
        address: &s.payer,
        invoke: &root,
    }]);
    let result = WrapperClient::new(&s.env, &wrapper).try_go(&s.upto, &s.payer, &terms, &10);
    assert!(result.is_err());
    assert_eq!(s.balance(&s.payer), FUNDED);
}

#[test]
fn a_signature_for_another_network_fails() {
    let t = Signed::new();
    let terms = t.s.terms(MAX);
    let real = t.s.env.ledger().network_id();
    t.s.env.ledger().with_mut(|l| l.network_id = [7u8; 32]);
    let entry = t.payer_entry(&terms, 900, Credentials::V1);
    t.s.env
        .ledger()
        .with_mut(|l| l.network_id = real.to_array());
    assert_eq!(
        t.settle(&[entry, t.authority_entry(&terms, 10)], &terms, 10),
        Err(auth_error(ScErrorCode::InvalidAction))
    );
    assert_eq!(t.payer_balance(), FUNDED);
}

#[test]
fn an_entry_for_one_deployment_fails_on_another() {
    let t = Signed::new();
    let terms = t.s.terms(MAX);
    let entry = t.payer_entry(&terms, 901, Credentials::V1);
    let other = t.s.env.register(upto::WASM, ());
    t.s.env.set_auths(&[
        entry.clone(),
        authority_entry(&t.s.env, &other, &t.s.payer, &terms, 10),
    ]);
    assert_eq!(
        invoke_settle(&t.s.env, &other, &t.s.payer, &terms, 10),
        Err(auth_error(ScErrorCode::InvalidAction))
    );
    assert_eq!(t.payer_balance(), FUNDED);
    // The entry is still good on the deployment it was signed for.
    assert_eq!(
        t.settle(&[entry, t.authority_entry(&terms, 10)], &terms, 10),
        Ok(10)
    );
}
