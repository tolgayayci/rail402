//! A token the seller controls. `terms.token` is chosen by the seller and signed by the payer, so
//! the contract can only be as honest as that token: it may claim a payment it never made. What it
//! must not be able to do is re-enter `settle` or spend the payer's other assets.
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, testutils::Address as _,
    testutils::Events as _, token::TokenClient, Address, Env,
};

use super::{upto, Credentials, Signed, UptoTerms, FUNDED, MAX};

// A contract type cannot box its fields; the size of a test value does not matter.
#[allow(clippy::large_enum_variant)]
#[contracttype]
#[derive(Clone)]
pub enum Mode {
    /// `transfer_from` returns without moving anything.
    Lie,
    /// `transfer_from` calls `settle(payer, terms, amount)` on the upto contract.
    Reenter(Address, Address, UptoTerms, i128),
    /// `approve` calls `transfer(from, thief, 1)` on a real token, riding the payer's authorization.
    DrainOnApprove(Address, Address),
}

/// Outcome of the token's side action: 0 none, 1 failed (expected), 2 succeeded.
const NONE: u32 = 0;
const FAILED: u32 = 1;

#[contract]
pub struct HostileToken;

#[contractimpl]
impl HostileToken {
    pub fn set_mode(env: Env, mode: Mode) {
        env.storage().instance().set(&symbol_short!("mode"), &mode);
    }

    pub fn outcome(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&symbol_short!("out"))
            .unwrap_or(NONE)
    }

    pub fn approve(env: Env, from: Address, _spender: Address, _amount: i128, _live_until: u32) {
        from.require_auth();
        let mode: Mode = env
            .storage()
            .instance()
            .get(&symbol_short!("mode"))
            .unwrap();
        if let Mode::DrainOnApprove(real, thief) = mode {
            let result = TokenClient::new(&env, &real).try_transfer(&from, &thief, &1);
            record(&env, matches!(result, Ok(Ok(()))));
        }
    }

    pub fn transfer_from(env: Env, _spender: Address, _from: Address, _to: Address, _amount: i128) {
        let mode: Mode = env
            .storage()
            .instance()
            .get(&symbol_short!("mode"))
            .unwrap();
        if let Mode::Reenter(upto, payer, terms, amount) = mode {
            let result = upto::Client::new(&env, &upto).try_settle(&payer, &terms, &amount);
            record(&env, matches!(result, Ok(Ok(_))));
        }
    }
}

fn record(env: &Env, succeeded: bool) {
    let outcome = if succeeded { 2 } else { FAILED };
    env.storage()
        .instance()
        .set(&symbol_short!("out"), &outcome);
}

fn hostile(t: &Signed, mode: Mode) -> Address {
    let token = t.s.env.register(HostileToken, ());
    HostileTokenClient::new(&t.s.env, &token).set_mode(&mode);
    token
}

#[test]
fn a_lying_token_settles_without_moving_value() {
    let t = Signed::new();
    let token = hostile(&t, Mode::Lie);
    let mut terms = t.s.terms(MAX);
    terms.token = token;
    let entry = t.payer_entry(&terms, 600, Credentials::V1);
    assert_eq!(
        t.settle(&[entry, t.authority_entry(&terms, 77)], &terms, 77),
        Ok(77)
    );
    // `upto_settled` still reports 77: events are only as trustworthy as `terms.token`.
    let events = t.s.env.events().all().filter_by_contract(&t.s.upto);
    assert_eq!(events.events().len(), 1);
    // No real asset moved.
    assert_eq!(t.payer_balance(), FUNDED);
    assert_eq!(t.s.balance(&t.s.recipient), 0);
}

#[test]
fn a_token_cannot_reenter_settle_even_with_a_second_valid_authorization() {
    let t = Signed::new();
    // B: a real, signed authorization over the real asset, offered to the hostile token.
    let mut b = t.s.terms(5_000);
    b.expiration_ledger += 3;
    let token = hostile(
        &t,
        Mode::Reenter(t.s.upto.clone(), t.s.payer.clone(), b.clone(), 5_000),
    );
    let mut a = t.s.terms(MAX);
    a.token = token.clone();
    let ea = t.payer_entry(&a, 700, Credentials::V1);
    let eb = t.payer_entry(&b, 701, Credentials::V1);
    let entries = [
        ea,
        eb.clone(),
        t.authority_entry(&a, 10),
        t.authority_entry(&b, 5_000),
    ];
    assert_eq!(t.settle(&entries, &a, 10), Ok(10));
    assert_eq!(HostileTokenClient::new(&t.s.env, &token).outcome(), FAILED);
    assert_eq!(t.payer_balance(), FUNDED);
    // The failed re-entry rolled back, so B is still unused and settles on its own.
    assert_eq!(
        t.settle(&[eb, t.authority_entry(&b, 5_000)], &b, 5_000),
        Ok(5_000)
    );
    assert_eq!(t.payer_balance(), FUNDED - 5_000);
}

#[test]
fn a_token_cannot_use_the_payers_approve_authorization_on_another_asset() {
    let t = Signed::new();
    let thief = Address::generate(&t.s.env);
    let token = hostile(&t, Mode::DrainOnApprove(t.s.token.clone(), thief.clone()));
    let mut terms = t.s.terms(MAX);
    terms.token = token.clone();
    let entry = t.payer_entry(&terms, 800, Credentials::V1);
    assert_eq!(
        t.settle(&[entry, t.authority_entry(&terms, 10)], &terms, 10),
        Ok(10)
    );
    assert_eq!(HostileTokenClient::new(&t.s.env, &token).outcome(), FAILED);
    assert_eq!(t.s.balance(&thief), 0);
    assert_eq!(t.payer_balance(), FUNDED);
}
