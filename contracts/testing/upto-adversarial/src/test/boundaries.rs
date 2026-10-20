//! Degenerate parties and extreme values.
use soroban_sdk::{
    testutils::{Ledger as _, MockAuth, MockAuthInvoke},
    xdr::ScErrorCode,
    IntoVal,
};

use super::{auth_error, contract_error, Setup, UptoError, EXPIRATION, FUNDED, MAX};

#[test]
fn the_authority_as_payer_still_needs_both_authorizations() {
    let s = Setup::new();
    let mut terms = s.terms(MAX);
    terms.facilitator = s.payer.clone();
    // Only the payer's `settle(terms)` tree: the second `settle(payer, terms, amount)` is missing.
    s.authorize(&terms, None);
    assert_eq!(
        s.try_settle(&terms, 10),
        Err(auth_error(ScErrorCode::InvalidAction))
    );
    assert_eq!(s.balance(&s.payer), FUNDED);
    s.authorize(&terms, Some(10));
    assert_eq!(s.try_settle(&terms, 10), Ok(10));
    assert_eq!(s.balance(&s.payer), FUNDED - 10);
}

#[test]
fn paying_oneself_moves_nothing() {
    let s = Setup::new();
    let mut terms = s.terms(MAX);
    terms.recipient = s.payer.clone();
    s.authorize(&terms, Some(500));
    assert_eq!(s.try_settle(&terms, 500), Ok(500));
    assert_eq!(s.balance(&s.payer), FUNDED);
}

#[test]
fn paying_the_token_contract_sends_the_amount_there() {
    // Nothing stops a payer from signing the asset contract as recipient; the amount then sits in
    // the contract's balance. Only the signed amount moves.
    let s = Setup::new();
    let mut terms = s.terms(MAX);
    terms.recipient = s.token.clone();
    s.authorize(&terms, Some(500));
    assert_eq!(s.try_settle(&terms, 500), Ok(500));
    assert_eq!(s.balance(&s.payer), FUNDED - 500);
    assert_eq!(s.balance(&s.token), 500);
}

/// The last ledger an entry written now may live until.
fn max_live_until(s: &Setup) -> u32 {
    s.env.ledger().sequence() + s.env.ledger().get().max_entry_ttl - 1
}

#[test]
fn an_expiration_at_the_maximum_ttl_settles() {
    let s = Setup::new();
    let mut terms = s.terms(MAX);
    terms.expiration_ledger = max_live_until(&s);
    s.authorize(&terms, Some(10));
    assert_eq!(s.try_settle(&terms, 10), Ok(10));
    assert_eq!(s.allowance(), MAX - 10);
}

#[test]
fn an_expiration_past_the_maximum_ttl_cannot_take_funds() {
    let s = Setup::new();
    let mut terms = s.terms(MAX);
    terms.expiration_ledger = max_live_until(&s) + 1;
    s.authorize(&terms, Some(10));
    // The token refuses an allowance that would outlive the maximum TTL.
    assert!(s.try_settle(&terms, 10).is_err());
    assert_eq!(s.balance(&s.payer), FUNDED);
    // A zero settlement never calls `approve`, so it still records the payment.
    s.authorize(&terms, Some(0));
    assert_eq!(s.try_settle(&terms, 0), Ok(0));
    assert_eq!(s.balance(&s.payer), FUNDED);
}

#[test]
fn a_u32_max_expiration_cannot_take_funds() {
    let s = Setup::new();
    let mut terms = s.terms(MAX);
    terms.expiration_ledger = u32::MAX;
    s.authorize(&terms, Some(10));
    assert!(s.try_settle(&terms, 10).is_err());
    assert_eq!(s.balance(&s.payer), FUNDED);
    assert_eq!(s.allowance(), 0);
}

#[test]
fn an_inverted_window_is_never_valid() {
    let s = Setup::new();
    let mut terms = s.terms(MAX);
    terms.valid_after_ledger = EXPIRATION + 1;
    s.authorize(&terms, Some(10));
    assert_eq!(
        s.try_settle(&terms, 10),
        Err(contract_error(UptoError::NotYetValid))
    );
    s.env.ledger().set_sequence_number(EXPIRATION + 1);
    s.authorize(&terms, Some(10));
    assert_eq!(
        s.try_settle(&terms, 10),
        Err(contract_error(UptoError::Expired))
    );
    assert_eq!(s.balance(&s.payer), FUNDED);
}

#[test]
fn an_i128_max_cap_takes_only_the_amount() {
    let s = Setup::new();
    let terms = s.terms(i128::MAX);
    s.authorize(&terms, Some(5));
    assert_eq!(s.try_settle(&terms, 5), Ok(5));
    assert_eq!(s.allowance(), i128::MAX - 5);
    assert_eq!(s.balance(&s.payer), FUNDED - 5);

    let mut all = s.terms(i128::MAX);
    all.expiration_ledger += 1;
    s.authorize(&all, Some(i128::MAX));
    // More than the balance: the token refuses and nothing moves.
    assert!(s.try_settle(&all, i128::MAX).is_err());
    assert_eq!(s.balance(&s.payer), FUNDED - 5);
}

#[test]
fn an_approve_for_another_spender_does_not_authorize_the_settlement() {
    // The payer's tree must name the upto contract as spender; a tree approving someone else is
    // not the payer's consent to this settlement.
    let s = Setup::new();
    let terms = s.terms(MAX);
    let approve = [MockAuthInvoke {
        contract: &s.token,
        fn_name: "approve",
        args: (&s.payer, &s.recipient, MAX, EXPIRATION).into_val(&s.env),
        sub_invokes: &[],
    }];
    let payer_root = MockAuthInvoke {
        contract: &s.upto,
        fn_name: "settle",
        args: (terms.clone(),).into_val(&s.env),
        sub_invokes: &approve,
    };
    let authority_root = MockAuthInvoke {
        contract: &s.upto,
        fn_name: "settle",
        args: (&s.payer, terms.clone(), 10i128).into_val(&s.env),
        sub_invokes: &[],
    };
    s.env.mock_auths(&[
        MockAuth {
            address: &s.payer,
            invoke: &payer_root,
        },
        MockAuth {
            address: &s.facilitator,
            invoke: &authority_root,
        },
    ]);
    assert_eq!(
        s.try_settle(&terms, 10),
        Err(auth_error(ScErrorCode::InvalidAction))
    );
    assert_eq!(s.balance(&s.payer), FUNDED);
}
