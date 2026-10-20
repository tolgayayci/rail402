//! Several live authorizations of one payer for one token. The contract sets the allowance to the
//! cap of the authorization being settled, so allowances never add up.
use soroban_sdk::xdr::ScErrorCode;

use super::{auth_error, contract_error, Credentials, Signed, UptoError, FUNDED, MAX};

#[test]
fn a_second_authorization_is_bounded_by_its_own_cap_not_the_leftover() {
    let t = Signed::new();
    let a = t.s.terms(10_000);
    let mut b = t.s.terms(5_000);
    b.expiration_ledger += 5;
    let ea = t.payer_entry(&a, 100, Credentials::V1);
    let eb = t.payer_entry(&b, 101, Credentials::V1);

    assert_eq!(
        t.settle(&[ea.clone(), t.authority_entry(&a, 3_000)], &a, 3_000),
        Ok(3_000)
    );
    assert_eq!(t.s.allowance(), 7_000);
    // A's leftover allowance is 7000, but B may only take up to its own cap.
    assert_eq!(
        t.settle(&[eb.clone(), t.authority_entry(&b, 6_000)], &b, 6_000),
        Err(contract_error(UptoError::AmountExceedsMax))
    );
    // B overwrites the allowance with its own cap and takes all of it.
    assert_eq!(
        t.settle(&[eb, t.authority_entry(&b, 5_000)], &b, 5_000),
        Ok(5_000)
    );
    assert_eq!(t.s.allowance(), 0);
    // A cannot be used again to take its leftover.
    assert_eq!(
        t.settle(&[ea, t.authority_entry(&a, 7_000)], &a, 7_000),
        Err(auth_error(ScErrorCode::ExistingValue))
    );
    assert_eq!(t.payer_balance(), FUNDED - 8_000);
}

#[test]
fn in_the_other_order_the_total_stays_within_the_sum_of_the_caps() {
    let t = Signed::new();
    let a = t.s.terms(10_000);
    let mut b = t.s.terms(5_000);
    b.expiration_ledger += 5;
    let ea = t.payer_entry(&a, 200, Credentials::V1);
    let eb = t.payer_entry(&b, 201, Credentials::V1);

    assert_eq!(t.settle(&[eb, t.authority_entry(&b, 1)], &b, 1), Ok(1));
    assert_eq!(t.s.allowance(), 4_999);
    // A replaces B's leftover with its own cap and expiration.
    assert_eq!(
        t.settle(&[ea, t.authority_entry(&a, 10_000)], &a, 10_000),
        Ok(10_000)
    );
    assert_eq!(t.s.allowance(), 0);
    assert_eq!(t.payer_balance(), FUNDED - 10_001);
}

#[test]
fn an_entry_for_other_terms_cannot_authorize_a_settlement() {
    let t = Signed::new();
    let a = t.s.terms(10_000);
    let mut b = t.s.terms(5_000);
    b.expiration_ledger += 5;
    let ea = t.payer_entry(&a, 300, Credentials::V1);
    let eb = t.payer_entry(&b, 301, Credentials::V1);

    assert_eq!(
        t.settle(&[eb.clone(), t.authority_entry(&a, 10)], &a, 10),
        Err(auth_error(ScErrorCode::InvalidAction))
    );
    assert_eq!(t.payer_balance(), FUNDED);
    // With both entries present, only A's is consumed; B still settles afterwards.
    assert_eq!(
        t.settle(&[ea, eb.clone(), t.authority_entry(&a, 10)], &a, 10),
        Ok(10)
    );
    assert_eq!(t.settle(&[eb, t.authority_entry(&b, 20)], &b, 20), Ok(20));
    assert_eq!(t.payer_balance(), FUNDED - 30);
}

#[test]
fn the_same_terms_signed_under_two_nonces_are_two_payments() {
    // Terms carry no request id: each signed entry is its own payment, settled at most once.
    let t = Signed::new();
    let a = t.s.terms(MAX);
    let e1 = t.payer_entry(&a, 400, Credentials::V1);
    let e2 = t.payer_entry(&a, 401, Credentials::V1);
    assert_eq!(
        t.settle(&[e1.clone(), t.authority_entry(&a, MAX)], &a, MAX),
        Ok(MAX)
    );
    assert_eq!(
        t.settle(&[e2.clone(), t.authority_entry(&a, MAX)], &a, MAX),
        Ok(MAX)
    );
    for entry in [e1, e2] {
        assert_eq!(
            t.settle(&[entry, t.authority_entry(&a, 1)], &a, 1),
            Err(auth_error(ScErrorCode::ExistingValue))
        );
    }
    assert_eq!(t.payer_balance(), FUNDED - 2 * MAX);
}

#[test]
fn an_allowance_the_payer_set_beforehand_is_overwritten_not_added() {
    let t = Signed::new();
    t.s.env.mock_all_auths();
    t.s.token()
        .approve(&t.s.payer, &t.s.upto, &FUNDED, &(super::EXPIRATION + 100));
    assert_eq!(t.s.allowance(), FUNDED);

    let a = t.s.terms(1_000);
    let e = t.payer_entry(&a, 500, Credentials::V1);
    assert_eq!(
        t.settle(&[e.clone(), t.authority_entry(&a, 1_001)], &a, 1_001),
        Err(contract_error(UptoError::AmountExceedsMax))
    );
    assert_eq!(t.settle(&[e, t.authority_entry(&a, 400)], &a, 400), Ok(400));
    assert_eq!(t.s.allowance(), 600);
    assert_eq!(t.payer_balance(), FUNDED - 400);
}
