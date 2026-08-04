#![no_std]
//! # x402 spending policy for OpenZeppelin smart accounts
//!
//! A [`Policy`] implementation that lets a smart account fund an autonomous agent with a session
//! key and a rolling spending budget, while allowing exactly the calls an x402 payment makes and
//! nothing else.
//!
//! ## Why this exists
//!
//! OpenZeppelin's `stellar-accounts` splits a smart account into an audited core — `__check_auth`,
//! signature authentication, context-rule matching, verifiers — and *policies*, which are separate
//! contracts carrying business logic. Their README names custom policies as a first-class option
//! for "specialized business logic", which is what an x402 budget is.
//!
//! Their reference `spending_limit` policy cannot serve x402: it matches only `transfer` and
//! rejects everything else via a fail-closed fallthrough, so an `upto` payment (which authorizes
//! `settle` plus an `approve` sub-invocation) is refused outright with `NotAllowed` even when the
//! amount is far inside budget. Verified by executing their own test harness, and confirmed
//! independently by an OpenZeppelin engineer.
//!
//! Building here rather than extending our own `__check_auth` means the cryptography and the
//! authorization machinery stay in audited code, and the only thing we own is budget arithmetic.
//!
//! ## What it allows
//!
//! | Function | Scheme | Budgeted against |
//! |---|---|---|
//! | `transfer(from, to, amount)` | `exact` | `amount`, argument 2 |
//! | `settle(token, to, max_amount, expiration, nonce)` | `upto` | `max_amount`, argument **2** |
//! | `approve(from, spender, amount, expiration)` | `upto` sub-invocation | nothing — see below |
//!
//! Anything else fails closed.
//!
//! ### Why the ceiling is reserved, then reconciled
//!
//! `upto` has the client authorize a ceiling while the server settles at or below it.
//! `actual_amount` is not covered by the client's signature and is unknown when `enforce` runs, so
//! the policy reserves the signed `max_amount` at authorization time. Budgeting against a figure the
//! facilitator chooses would let it decide whether the policy passes; the account commits to the
//! ceiling, so the ceiling is what it reserves.
//!
//! Left there, that would be conservative to the point of being a problem: a 50-per-period cap would
//! admit only five requests at a ceiling of 10 even if real usage were a fifth of that. So the
//! reservation is not the end of it. `enforce` records the settlement nonce alongside the reserved
//! amount, and once the settlement contract knows the actual charge it calls
//! [`X402AgentPolicy::release`], which refunds the unspent difference. An agent that authorizes 10
//! and is charged 3 ends up having spent 3 of its budget, not 10. The reservation keeps the payment
//! bounded before the charge is known; the release stops the ceiling being over-counted after.
//!
//! ### Why `approve` is allowed but not budgeted
//!
//! `approve` is the sub-invocation of `settle` for the *same money*, already committed via the
//! ceiling. Counting both would charge every `upto` payment twice and make the effective cap half
//! what an operator configured.
//!
//! ## Argument indices
//!
//! An authorization context carries the arguments the callee **authorized**, which is not always the
//! function's full parameter list. Decoded from a live simulation of each call:
//!
//! ```text
//! ROOT settle  args=5   [0] token  [1] to  [2] max_amount  [3] expiration  [4] nonce
//!  SUB approve args=4   [0] from   [1] spender  [2] amount  [3] expiration
//! ```
//!
//! `settle` takes seven parameters but authorizes only five, because `contracts/upto-stellar` calls
//! `require_auth_for_args((token, to, max_amount, expiration_ledger, nonce))` and deliberately
//! leaves `actual_amount` unsigned. So `max_amount` is argument **2**, not 3.
//!
//! `transfer` is argument 2 for the opposite reason: the Stellar Asset Contract uses plain
//! `require_auth`, so its context carries the full `(from, to, amount)`.
//!
//! Getting this wrong is quiet rather than loud: argument 3 of `settle` is the expiration ledger, a
//! `u32` that converts to `i128` without error, so the contract would budget a ledger sequence
//! number as if it were an amount.

use soroban_sdk::{
    auth::Context, contract, contracterror, contractimpl,
    contracttype, panic_with_error, Address, BytesN, Env, Symbol, TryFromVal, Val, Vec,
};
use stellar_accounts::{
    policies::Policy,
    smart_account::{ContextRule, Signer},
};

/// `exact`: the SEP-41 transfer a payment settles with.
const FN_TRANSFER: &str = "transfer";
/// `upto`: the settlement contract entry point.
const FN_SETTLE: &str = "settle";
/// `upto`: the allowance sub-invocation of `settle`.
const FN_APPROVE: &str = "approve";

/// Largest number of spend entries retained per account and rule.
///
/// Bounds the storage an account can accumulate and the work `enforce` does per authorization.
/// Entries older than the window are pruned first, so this is only reached by genuinely bursty
/// spending inside one period.
const MAX_HISTORY: u32 = 30;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// The policy is not installed for this account and context rule.
    NotInstalled = 1,
    /// Already installed; installing twice would silently reset the budget.
    AlreadyInstalled = 2,
    /// A limit of zero or a period of zero would make the policy meaningless or divide the window
    /// by nothing.
    InvalidParams = 3,
    /// The call is not one an x402 payment makes.
    FunctionNotAllowed = 4,
    /// The authorization is not a contract call at all.
    UnsupportedContext = 5,
    /// The budgeted argument is missing, negative, or not an integer.
    MalformedAmount = 6,
    /// This payment would exceed the rolling limit.
    SpendingLimitExceeded = 7,
    /// Too many payments inside one window.
    HistoryCapacityExceeded = 8,
    /// `release()` reported a settled amount larger than the reserved ceiling, or a negative one.
    /// The settlement contract enforces `actual <= max` on-ledger, so reaching this means a caller
    /// that is not the real settlement contract, or a corrupted reservation.
    ReleaseExceedsReserved = 9,
}

/// Installation parameters: a rolling budget.
#[contracttype]
#[derive(Clone)]
pub struct X402PolicyParams {
    /// Most that may be committed within any `period_ledgers` window, in stroops.
    pub spending_limit: i128,
    /// Width of the rolling window, in ledgers. ~17,280 is a day at 5s ledgers.
    pub period_ledgers: u32,
}

/// One committed payment.
///
/// `id` is the settlement nonce for an `upto` payment, so `release()` can find this exact entry and
/// bring its amount down from the reserved ceiling to the settled figure. An `exact` transfer settles
/// its own amount and is never reconciled, so it carries a zero id.
#[contracttype]
#[derive(Clone)]
pub struct SpendEntry {
    pub amount: i128,
    pub ledger: u32,
    pub id: BytesN<32>,
}

/// A committed `upto` ceiling, awaiting reconciliation once the settlement contract reports the
/// actual charge. Keyed by (account, payment_id). `settlement_contract` is the contract the ceiling
/// was authorized against, and the only party allowed to release it.
#[contracttype]
#[derive(Clone)]
pub struct Reservation {
    pub rule_id: u32,
    pub reserved: i128,
    pub settlement_contract: Address,
}

/// Stored state for one (account, context rule).
#[contracttype]
#[derive(Clone)]
pub struct X402PolicyData {
    pub spending_limit: i128,
    pub period_ledgers: u32,
    pub history: Vec<SpendEntry>,
    pub total_spent: i128,
}

#[contracttype]
enum DataKey {
    /// Keyed by account and rule so one deployed policy serves every account, as OZ intends.
    Account(Address, u32),
    /// A pending `upto` reservation, keyed by (account, payment_id), consumed by `release()`.
    Reservation(Address, BytesN<32>),
}

/// Which argument carries the amount to budget, or `None` for allowed-but-not-budgeted.
fn amount_index(e: &Env, fn_name: &Symbol) -> Option<u32> {
    if fn_name == &Symbol::new(e, FN_TRANSFER) {
        Some(2)
    } else if fn_name == &Symbol::new(e, FN_SETTLE) {
        Some(2)
    } else if fn_name == &Symbol::new(e, FN_APPROVE) {
        None
    } else {
        Some(u32::MAX)
    }
}

fn read(e: &Env, smart_account: &Address, rule_id: u32) -> X402PolicyData {
    e.storage()
        .persistent()
        .get(&DataKey::Account(smart_account.clone(), rule_id))
        .unwrap_or_else(|| panic_with_error!(e, Error::NotInstalled))
}

fn write(e: &Env, smart_account: &Address, rule_id: u32, data: &X402PolicyData) {
    e.storage()
        .persistent()
        .set(&DataKey::Account(smart_account.clone(), rule_id), data);
}

#[contract]
pub struct X402AgentPolicy;

#[contractimpl]
impl Policy for X402AgentPolicy {
    type AccountParams = X402PolicyParams;

    fn install(
        e: &Env,
        install_params: Self::AccountParams,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        smart_account.require_auth();

        if install_params.spending_limit <= 0 || install_params.period_ledgers == 0 {
            panic_with_error!(e, Error::InvalidParams);
        }
        let key = DataKey::Account(smart_account.clone(), context_rule.id);
        if e.storage().persistent().has(&key) {
            panic_with_error!(e, Error::AlreadyInstalled);
        }
        e.storage().persistent().set(
            &key,
            &X402PolicyData {
                spending_limit: install_params.spending_limit,
                period_ledgers: install_params.period_ledgers,
                history: Vec::new(e),
                total_spent: 0,
            },
        );
    }

    /// Validate one authorization context and commit its amount to the budget.
    ///
    /// Runs after the account has already authenticated signatures and matched the context type,
    /// so everything here is business logic. Panicking reverts the whole transaction.
    fn enforce(
        e: &Env,
        context: Context,
        _authenticated_signers: Vec<Signer>,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        smart_account.require_auth();

        let invocation = match context {
            Context::Contract(c) => c,
            // Deploying contracts or uploading wasm is not something a payment key should ever
            // authorize. Fail closed rather than ignore.
            _ => panic_with_error!(e, Error::UnsupportedContext),
        };

        let index = match amount_index(e, &invocation.fn_name) {
            // Allowed, deliberately not budgeted: the `approve` sub-invocation covers the same
            // money as its parent `settle`.
            None => return,
            Some(i) if i == u32::MAX => panic_with_error!(e, Error::FunctionNotAllowed),
            Some(i) => i,
        };

        let raw: Val = match invocation.args.get(index) {
            Some(v) => v,
            None => panic_with_error!(e, Error::MalformedAmount),
        };
        let amount = match i128::try_from_val(e, &raw) {
            Ok(a) => a,
            Err(_) => panic_with_error!(e, Error::MalformedAmount),
        };
        // A negative amount would credit the budget rather than spend it. The audited reference
        // policy carries the same guard, added after an audit finding.
        if amount < 0 {
            panic_with_error!(e, Error::MalformedAmount);
        }
        // Moves nothing, so it cannot consume budget, and rejecting it would fail a legitimate
        // zero-value `upto` settlement.
        if amount == 0 {
            return;
        }

        let mut data = read(e, &smart_account, context_rule.id);
        let now = e.ledger().sequence();
        let cutoff = now.saturating_sub(data.period_ledgers);

        // Prune before checking, so a payment is never refused because of spending that has
        // already aged out of the window.
        let mut kept: Vec<SpendEntry> = Vec::new(e);
        let mut total: i128 = 0;
        for entry in data.history.iter() {
            if entry.ledger > cutoff {
                total = total.saturating_add(entry.amount);
                kept.push_back(entry);
            }
        }

        let projected = total.saturating_add(amount);
        if projected > data.spending_limit {
            panic_with_error!(e, Error::SpendingLimitExceeded);
        }
        if kept.len() >= MAX_HISTORY {
            panic_with_error!(e, Error::HistoryCapacityExceeded);
        }

        // A settle (upto) reserves its CEILING, and records the nonce plus the contract it was
        // authorized against, so `release()` can later reconcile it down to the actual charge. An
        // exact transfer settles its own amount, needs no reservation, and its entry carries a zero id.
        let (payment_id, settlement) = if invocation.fn_name == Symbol::new(e, FN_SETTLE) {
            let nonce = invocation
                .args
                .get(4)
                .and_then(|v| BytesN::<32>::try_from_val(e, &v).ok())
                .unwrap_or_else(|| panic_with_error!(e, Error::MalformedAmount));
            (nonce, Some(invocation.contract.clone()))
        } else {
            (BytesN::from_array(e, &[0u8; 32]), None)
        };

        kept.push_back(SpendEntry { amount, ledger: now, id: payment_id.clone() });
        data.history = kept;
        data.total_spent = projected;
        write(e, &smart_account, context_rule.id, &data);

        if let Some(settlement_contract) = settlement {
            e.storage().persistent().set(
                &DataKey::Reservation(smart_account.clone(), payment_id),
                &Reservation { rule_id: context_rule.id, reserved: amount, settlement_contract },
            );
        }
    }

    fn uninstall(e: &Env, context_rule: ContextRule, smart_account: Address) {
        smart_account.require_auth();

        let key = DataKey::Account(smart_account.clone(), context_rule.id);
        if !e.storage().persistent().has(&key) {
            panic_with_error!(e, Error::NotInstalled);
        }
        e.storage().persistent().remove(&key);
    }
}

#[contractimpl]
impl X402AgentPolicy {
    /// Current budget state, for an operator or a UI.
    pub fn get_policy_data(e: Env, context_rule_id: u32, smart_account: Address) -> X402PolicyData {
        read(&e, &smart_account, context_rule_id)
    }

    /// Reconcile a settled `upto` payment: refund the part of the ceiling that was not spent.
    ///
    /// `enforce()` reserves the ceiling at authorization time, because the account cannot know the
    /// final charge then. Once the settlement contract knows the actual amount it calls this, and the
    /// budget drops from the ceiling to the real figure, so an agent that authorizes 10 and is charged
    /// 3 spends 3 of its budget rather than 10.
    ///
    /// This is the settlement-hook ABI (v1): `release(from, payment_id, actual)`.
    ///
    /// Security rests on one line: only the settlement contract the reservation was created against
    /// may call this, enforced by requiring that contract's own authorization. Soroban satisfies that
    /// automatically when the settlement contract is the direct caller, and rejects any other caller,
    /// so a third party cannot free budget the agent did not actually save, nor can it report a false
    /// actual, since the honest settlement contract is the only one that reaches this with the real
    /// figure it just moved.
    ///
    /// A missing reservation is a no-op. That is deliberate and covers two cases: recording-mode
    /// simulation, where `__check_auth` and therefore `enforce()` never run so no reservation exists,
    /// and any exact payment, which reserves nothing because it settles its own amount.
    pub fn release(e: Env, from: Address, payment_id: BytesN<32>, actual: i128) {
        let key = DataKey::Reservation(from.clone(), payment_id.clone());
        let reservation: Reservation = match e.storage().persistent().get(&key) {
            Some(r) => r,
            None => return,
        };

        // The trust boundary: the reservation names the contract it was authorized against, and only
        // that contract, calling here itself, can release it.
        reservation.settlement_contract.require_auth();

        if actual < 0 || actual > reservation.reserved {
            panic_with_error!(&e, Error::ReleaseExceedsReserved);
        }

        let refund = reservation.reserved - actual;
        if refund > 0 {
            let mut data = read(&e, &from, reservation.rule_id);
            // Bring the matching history entry down to the actual figure, so when it later ages out of
            // the rolling window the pruning subtracts the real amount and not the ceiling.
            let mut kept: Vec<SpendEntry> = Vec::new(&e);
            for entry in data.history.iter() {
                if entry.id == payment_id {
                    kept.push_back(SpendEntry { amount: actual, ledger: entry.ledger, id: entry.id });
                } else {
                    kept.push_back(entry);
                }
            }
            data.history = kept;
            data.total_spent = data.total_spent.saturating_sub(refund);
            write(&e, &from, reservation.rule_id, &data);
        }

        // Consumed, so a second release cannot refund the same reservation twice.
        e.storage().persistent().remove(&key);
    }

    /// Change the rolling limit without discarding spending history.
    ///
    /// Authorized by the smart account itself, which is how OZ's `ExecutionEntryPoint` reaches a
    /// policy: the owner's rule authorizes the account to call this, so an agent holding only a
    /// session key cannot raise its own budget.
    pub fn set_spending_limit(
        e: Env,
        context_rule_id: u32,
        smart_account: Address,
        spending_limit: i128,
    ) {
        smart_account.require_auth();

        if spending_limit <= 0 {
            panic_with_error!(&e, Error::InvalidParams);
        }
        let mut data = read(&e, &smart_account, context_rule_id);
        data.spending_limit = spending_limit;
        write(&e, &smart_account, context_rule_id, &data);
    }
}

mod test;
