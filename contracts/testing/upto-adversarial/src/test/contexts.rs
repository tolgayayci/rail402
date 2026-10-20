//! What a contract-account payer's `__check_auth` is asked to approve. A wallet policy sees the
//! upto contract as the `approve` spender; the recipient is only in the `settle` context's terms.
use soroban_sdk::{vec, xdr::ScErrorCode, Symbol};

use super::{auth_error, Credentials, Ed25519AccountClient, Signed, FUNDED, MAX};

#[test]
fn the_account_sees_settle_and_approve_even_for_a_zero_settlement() {
    let t = Signed::new();
    let terms = t.s.terms(MAX);
    let entry = t.payer_entry(&terms, 55, Credentials::V1);
    assert_eq!(
        t.settle(&[entry, t.authority_entry(&terms, 0)], &terms, 0),
        Ok(0)
    );
    let env = &t.s.env;
    assert_eq!(
        Ed25519AccountClient::new(env, &t.s.payer).seen(),
        vec![env, Symbol::new(env, "settle"), Symbol::new(env, "approve")]
    );
    assert_eq!(t.payer_balance(), FUNDED);
    assert_eq!(t.s.allowance(), 0);
}

#[test]
fn the_account_sees_the_same_contexts_for_a_payment() {
    let t = Signed::new();
    let terms = t.s.terms(MAX);
    let entry = t.payer_entry(&terms, 56, Credentials::V2);
    assert_eq!(
        t.settle(&[entry, t.authority_entry(&terms, 300)], &terms, 300),
        Ok(300)
    );
    let env = &t.s.env;
    assert_eq!(
        Ed25519AccountClient::new(env, &t.s.payer).seen(),
        vec![env, Symbol::new(env, "settle"), Symbol::new(env, "approve")]
    );
}

#[test]
fn a_contract_account_signature_by_another_key_fails() {
    let t = Signed::new();
    let terms = t.s.terms(MAX);
    let stranger = ed25519_dalek::SigningKey::from_bytes(&[9; 32]);
    let env = &t.s.env;
    let entry = super::sign_contract_entry(
        env,
        &t.s.payer,
        &stranger,
        super::payer_root(env, &t.s.upto, &t.s.payer, &terms),
        57,
        terms.expiration_ledger,
        Credentials::V1,
    );
    assert_eq!(
        t.settle(&[entry, t.authority_entry(&terms, 10)], &terms, 10),
        Err(auth_error(ScErrorCode::InvalidAction))
    );
    assert_eq!(t.payer_balance(), FUNDED);
}
