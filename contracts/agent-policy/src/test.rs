#![cfg(test)]

use soroban_sdk::{
    auth::{Context, ContractContext},
    contract,
    testutils::{Address as _, Ledger as _},
    vec, Address, BytesN, Env, IntoVal, String, Symbol, Vec,
};
use stellar_accounts::{
    policies::Policy,
    smart_account::{ContextRule, ContextRuleType},
};

use crate::{Error, X402AgentPolicy, X402PolicyParams};

/// Host for the policy under test. A policy is a standalone contract, so it needs somewhere to run.
#[contract]
struct Host;

const LIMIT: i128 = 1_000_000;
const PERIOD: u32 = 100;

struct F {
    e: Env,
    host: Address,
    account: Address,
    rule: ContextRule,
}

fn rule_for(e: &Env, id: u32) -> ContextRule {
    ContextRule {
        id,
        context_type: ContextRuleType::CallContract(Address::generate(e)),
        name: String::from_str(e, "agent"),
        signers: Vec::new(e),
        signer_ids: Vec::new(e),
        policies: Vec::new(e),
        policy_ids: Vec::new(e),
        valid_until: None,
    }
}

fn setup() -> F {
    let e = Env::default();
    e.ledger().set_sequence_number(1_000);
    let host = e.register(Host, ());
    let account = Address::generate(&e);
    let rule = rule_for(&e, 1);
    e.mock_all_auths();
    let f = F { e, host, account, rule };
    f.e.as_contract(&f.host, || {
        X402AgentPolicy::install(
            &f.e,
            X402PolicyParams { spending_limit: LIMIT, period_ledgers: PERIOD },
            f.rule.clone(),
            f.account.clone(),
        );
    });
    f
}

/// `transfer(from, to, amount)` — the full contract-call arguments, which is what Soroban puts in
/// `Context::Contract(..).args`. Established against a live settlement, not assumed.
fn transfer_ctx(e: &Env, amount: i128) -> Context {
    Context::Contract(ContractContext {
        contract: Address::generate(e),
        fn_name: Symbol::new(e, "transfer"),
        args: (Address::generate(e), Address::generate(e), amount).into_val(e),
    })
}

/// The AUTHORIZED arguments of `settle`, which is what an auth context carries:
/// `(token, to, max_amount, expiration_ledger, nonce)`. Five, not the function's seven —
/// `upto` leaves `actual_amount` unsigned on purpose, so it never appears here. Decoded from a live
/// simulation; an earlier seven-argument fixture hid a real index bug.
fn settle_ctx(e: &Env, max_amount: i128) -> Context {
    Context::Contract(ContractContext {
        contract: Address::generate(e),
        fn_name: Symbol::new(e, "settle"),
        args: (
            Address::generate(e),
            Address::generate(e),
            max_amount,
            2_000_u32,
            BytesN::from_array(e, &[7u8; 32]),
        )
            .into_val(e),
    })
}

/// `approve(from, spender, amount, expiration)` — the sub-invocation of `settle`.
fn approve_ctx(e: &Env, amount: i128) -> Context {
    Context::Contract(ContractContext {
        contract: Address::generate(e),
        fn_name: Symbol::new(e, "approve"),
        args: (Address::generate(e), Address::generate(e), amount, 2_000_u32).into_val(e),
    })
}

fn enforce(f: &F, ctx: Context) {
    f.e.as_contract(&f.host, || {
        X402AgentPolicy::enforce(&f.e, ctx, Vec::new(&f.e), f.rule.clone(), f.account.clone());
    });
}

fn spent(f: &F) -> i128 {
    f.e.as_contract(&f.host, || {
        X402AgentPolicy::get_policy_data(f.e.clone(), f.rule.id, f.account.clone()).total_spent
    })
}

// ── the gap this policy exists to close ──────────────────────────────────────

#[test]
fn allows_an_upto_settle_that_the_reference_policy_refuses() {
    // OZ's `spending_limit` rejects this with NotAllowed because the function is not `transfer`.
    // Confirmed by executing their own harness. This is the whole reason for a custom policy.
    let f = setup();
    enforce(&f, settle_ctx(&f.e, 400_000));
    assert_eq!(spent(&f), 400_000, "must budget the signed ceiling");
}

#[test]
fn budgets_the_ceiling_not_the_metered_amount() {
    // `actual_amount` is not covered by the client's signature, so budgeting it would police a
    // number the account never agreed to and let the facilitator decide whether the policy passes.
    let f = setup();
    enforce(&f, settle_ctx(&f.e, 900_000));
    assert_eq!(spent(&f), 900_000, "the signed ceiling at argument 2");
}

#[test]
fn does_not_double_count_the_approve_sub_invocation() {
    // `approve` covers the same money as its parent `settle`. Counting both would halve the cap
    // an operator configured.
    let f = setup();
    enforce(&f, settle_ctx(&f.e, 400_000));
    enforce(&f, approve_ctx(&f.e, 400_000));
    assert_eq!(spent(&f), 400_000);
}

// ── the budget ───────────────────────────────────────────────────────────────

#[test]
fn allows_an_exact_transfer_inside_budget() {
    let f = setup();
    enforce(&f, transfer_ctx(&f.e, 250_000));
    assert_eq!(spent(&f), 250_000);
}

#[test]
#[should_panic(expected = "Error(Contract, #7)")]
fn refuses_a_single_payment_over_the_limit() {
    let f = setup();
    enforce(&f, transfer_ctx(&f.e, LIMIT + 1));
}

#[test]
#[should_panic(expected = "Error(Contract, #7)")]
fn refuses_once_cumulative_spend_would_pass_the_limit() {
    let f = setup();
    enforce(&f, transfer_ctx(&f.e, 600_000));
    enforce(&f, transfer_ctx(&f.e, 600_000));
}

#[test]
fn spending_ages_out_of_the_rolling_window() {
    // The property that makes this better than a lifetime cap: budget recovers with time.
    let f = setup();
    enforce(&f, transfer_ctx(&f.e, 900_000));
    f.e.ledger().set_sequence_number(1_000 + PERIOD + 1);
    enforce(&f, transfer_ctx(&f.e, 900_000));
    assert_eq!(spent(&f), 900_000, "the earlier spend has aged out");
}

// ── failing closed ───────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn refuses_a_function_that_is_not_a_payment() {
    let f = setup();
    let ctx = Context::Contract(ContractContext {
        contract: Address::generate(&f.e),
        fn_name: Symbol::new(&f.e, "set_admin"),
        args: vec![&f.e],
    });
    enforce(&f, ctx);
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")]
fn refuses_a_negative_amount() {
    // The audited reference policy gained this guard from an audit finding
    // (`spending-limit-policy-bypass-by-specifying-negative-amount`); a negative amount would
    // credit the budget instead of spending it.
    let f = setup();
    enforce(&f, transfer_ctx(&f.e, -1));
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")]
fn refuses_a_malformed_amount_argument() {
    let f = setup();
    let ctx = Context::Contract(ContractContext {
        contract: Address::generate(&f.e),
        fn_name: Symbol::new(&f.e, "transfer"),
        // An address where the amount should be.
        args: (Address::generate(&f.e), Address::generate(&f.e), Address::generate(&f.e))
            .into_val(&f.e),
    });
    enforce(&f, ctx);
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")]
fn refuses_a_truncated_argument_list() {
    let f = setup();
    let ctx = Context::Contract(ContractContext {
        contract: Address::generate(&f.e),
        fn_name: Symbol::new(&f.e, "transfer"),
        args: (Address::generate(&f.e), Address::generate(&f.e)).into_val(&f.e),
    });
    enforce(&f, ctx);
}

#[test]
fn a_zero_settlement_is_allowed_and_costs_nothing() {
    // `upto` may settle zero. It moves no funds, so it cannot consume budget, and refusing it
    // would break a legitimate flow.
    let f = setup();
    enforce(&f, settle_ctx(&f.e, 0));
    assert_eq!(spent(&f), 0);
}

// ── lifecycle ────────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn refuses_a_zero_limit_at_install() {
    let e = Env::default();
    let host = e.register(Host, ());
    let account = Address::generate(&e);
    e.mock_all_auths();
    let rule = rule_for(&e, 9);
    e.as_contract(&host, || {
        X402AgentPolicy::install(
            &e,
            X402PolicyParams { spending_limit: 0, period_ledgers: PERIOD },
            rule,
            account,
        );
    });
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn uninstall_removes_the_budget() {
    let f = setup();
    f.e.as_contract(&f.host, || {
        X402AgentPolicy::uninstall(&f.e, f.rule.clone(), f.account.clone());
    });
    // Reading afterwards must fail rather than silently report an empty budget.
    spent(&f);
}

#[test]
fn raising_the_limit_keeps_spending_history() {
    let f = setup();
    enforce(&f, transfer_ctx(&f.e, 900_000));
    f.e.as_contract(&f.host, || {
        X402AgentPolicy::set_spending_limit(f.e.clone(), f.rule.id, f.account.clone(), 2_000_000);
    });
    // Still counted, so raising the cap does not wipe what has already been committed.
    assert_eq!(spent(&f), 900_000);
    enforce(&f, transfer_ctx(&f.e, 900_000));
    assert_eq!(spent(&f), 1_800_000);
}

#[test]
fn error_codes_are_stable() {
    // These reach a client through the facilitator's error registry, so they are wire contract.
    assert_eq!(Error::NotInstalled as u32, 1);
    assert_eq!(Error::FunctionNotAllowed as u32, 4);
    assert_eq!(Error::MalformedAmount as u32, 6);
    assert_eq!(Error::SpendingLimitExceeded as u32, 7);
}

// ── configurability ──────────────────────────────────────────────────────────

#[test]
fn one_deployed_policy_serves_many_accounts_independently() {
    // The property that makes a single deployment viable for every buyer: budgets are keyed by
    // (account, rule), so two accounts sharing this contract cannot spend each other's allowance.
    let e = Env::default();
    e.ledger().set_sequence_number(1_000);
    let host = e.register(Host, ());
    let a = Address::generate(&e);
    let b = Address::generate(&e);
    let rule = rule_for(&e, 1);
    e.mock_all_auths();

    e.as_contract(&host, || {
        X402AgentPolicy::install(
            &e,
            X402PolicyParams { spending_limit: 1_000, period_ledgers: 50 },
            rule.clone(),
            a.clone(),
        );
        X402AgentPolicy::install(
            &e,
            X402PolicyParams { spending_limit: 9_000_000, period_ledgers: 500 },
            rule.clone(),
            b.clone(),
        );
    });

    // Spending on `a` must not appear on `b`, and each keeps the limit it was configured with.
    e.as_contract(&host, || {
        X402AgentPolicy::enforce(
            &e,
            transfer_ctx(&e, 900),
            Vec::new(&e),
            rule.clone(),
            a.clone(),
        );
    });
    let (sa, sb) = e.as_contract(&host, || {
        (
            X402AgentPolicy::get_policy_data(e.clone(), rule.id, a.clone()),
            X402AgentPolicy::get_policy_data(e.clone(), rule.id, b.clone()),
        )
    });
    assert_eq!(sa.total_spent, 900);
    assert_eq!(sa.spending_limit, 1_000);
    assert_eq!(sb.total_spent, 0, "one account's spending must not touch another's budget");
    assert_eq!(sb.spending_limit, 9_000_000);
    assert_eq!(sb.period_ledgers, 500, "each account keeps its own window");
}

#[test]
fn the_same_account_budgets_each_rule_separately() {
    // The two-rule layout depends on this: the settle rule and the token rule hold independent
    // budgets, which is why an `upto` ceiling and an `exact` payment do not consume one allowance.
    let f = setup();
    let other = rule_for(&f.e, 2);
    f.e.as_contract(&f.host, || {
        X402AgentPolicy::install(
            &f.e,
            X402PolicyParams { spending_limit: LIMIT, period_ledgers: PERIOD },
            other.clone(),
            f.account.clone(),
        );
    });

    enforce(&f, transfer_ctx(&f.e, 250_000));
    f.e.as_contract(&f.host, || {
        X402AgentPolicy::enforce(
            &f.e,
            settle_ctx(&f.e, 400_000),
            Vec::new(&f.e),
            other.clone(),
            f.account.clone(),
        );
    });

    let second = f.e.as_contract(&f.host, || {
        X402AgentPolicy::get_policy_data(f.e.clone(), other.id, f.account.clone())
    });
    assert_eq!(spent(&f), 250_000, "rule 1 carries only the exact payment");
    assert_eq!(second.total_spent, 400_000, "rule 2 carries only the upto ceiling");
}

// ── release() reconciliation ─────────────────────────────────────────────────
//
// enforce() reserves the CEILING; release() brings the budget down to the actual charge once the
// settlement contract reports it. These prove the arithmetic and the edges. The auth boundary (only
// the settlement contract may release) rests on Soroban's invoker authorization and is proven on a
// real cross-contract call in the on-ledger e2e; here `mock_all_auths` is already set, so the focus
// is the reconciliation logic itself.

/// 32-byte payment id from a single repeated byte, matching how the ctx helpers build a nonce.
fn bn(e: &Env, b: u8) -> BytesN<32> {
    BytesN::from_array(e, &[b; 32])
}

/// A settle context with a chosen nonce, so a later `release` can name the same reservation.
fn settle_ctx_n(e: &Env, nonce_byte: u8, max_amount: i128) -> Context {
    Context::Contract(ContractContext {
        contract: Address::generate(e),
        fn_name: Symbol::new(e, "settle"),
        args: (
            Address::generate(e),
            Address::generate(e),
            max_amount,
            2_000_u32,
            bn(e, nonce_byte),
        )
            .into_val(e),
    })
}

fn release(f: &F, nonce_byte: u8, actual: i128) {
    f.e.as_contract(&f.host, || {
        X402AgentPolicy::release(f.e.clone(), f.account.clone(), bn(&f.e, nonce_byte), actual);
    });
}

#[test]
fn release_reconciles_the_budget_from_ceiling_to_actual() {
    let f = setup();
    enforce(&f, settle_ctx_n(&f.e, 7, 900_000));
    assert_eq!(spent(&f), 900_000, "the ceiling is committed at authorization time");
    release(&f, 7, 100_000);
    assert_eq!(spent(&f), 100_000, "release brings the budget down to the actual charge");
}

#[test]
fn a_zero_settlement_releases_the_whole_ceiling() {
    let f = setup();
    enforce(&f, settle_ctx_n(&f.e, 7, 900_000));
    release(&f, 7, 0);
    assert_eq!(spent(&f), 0, "nothing was spent, so nothing stays committed");
}

#[test]
fn reconciliation_frees_budget_for_more_spending() {
    // LIMIT is 1_000_000. Two 900k ceilings cannot both be committed, but if the first settles for
    // 100k the second 900k ceiling fits.
    let f = setup();
    enforce(&f, settle_ctx_n(&f.e, 7, 900_000));
    release(&f, 7, 100_000);
    enforce(&f, settle_ctx_n(&f.e, 8, 900_000));
    assert_eq!(spent(&f), 1_000_000, "100k real plus a fresh 900k ceiling, inside the 1M limit");
}

#[test]
#[should_panic(expected = "Error(Contract, #7)")]
fn without_reconciliation_the_ceiling_blocks_the_second_payment() {
    // The same two payments, but the first is never released: 900k + 900k exceeds the 1M limit. This
    // is the conservative behaviour release() exists to relax.
    let f = setup();
    enforce(&f, settle_ctx_n(&f.e, 7, 900_000));
    enforce(&f, settle_ctx_n(&f.e, 8, 900_000));
}

#[test]
fn release_without_a_reservation_is_a_noop() {
    // Covers an exact payment (which reserves nothing) and recording-mode simulation (where enforce
    // never ran). Releasing a nonce that was never reserved must change nothing and must not panic.
    let f = setup();
    enforce(&f, transfer_ctx(&f.e, 250_000));
    release(&f, 7, 100_000);
    assert_eq!(spent(&f), 250_000, "the exact payment stands, the release is inert");
}

#[test]
fn a_second_release_is_a_noop() {
    // The reservation is consumed on first release, so a replayed release cannot refund twice.
    let f = setup();
    enforce(&f, settle_ctx_n(&f.e, 7, 900_000));
    release(&f, 7, 100_000);
    assert_eq!(spent(&f), 100_000);
    release(&f, 7, 0);
    assert_eq!(spent(&f), 100_000, "the consumed reservation gives nothing back a second time");
}

#[test]
#[should_panic(expected = "Error(Contract, #9)")]
fn release_rejects_an_actual_over_the_reserved_ceiling() {
    let f = setup();
    enforce(&f, settle_ctx_n(&f.e, 7, 500_000));
    release(&f, 7, 500_001);
}
