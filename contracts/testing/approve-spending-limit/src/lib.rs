//! Spending-limit policy for OpenZeppelin smart accounts that budgets both ways a token can leave
//! the account: `transfer(from, to, amount)` and `approve(from, spender, amount, live_until)`.
//!
//! A payment that is pulled by a contract (an x402 `upto` settlement, for example) reaches the
//! account's `__check_auth` as an `approve` context, not a `transfer`. A policy that only counts
//! transfers has to reject it or let it through unbudgeted; this one counts the approved amount
//! against the same rolling-window budget, so the full approved cap is reserved even if the
//! spender later pulls less.
//!
//! Install it on a `CallContract(<token>)` context rule next to the signer it constrains (an
//! agent key, say). Each `(smart account, context rule)` pair has its own budget:
//!
//! - `spending_limit`: the most that may be transferred or approved within the window;
//! - `period_ledgers`: the window length; a spend recorded at ledger `L` stops counting at
//!   ledger `L + period_ledgers`;
//! - `spenders`: if not empty, the only spenders `approve` may name.
//!
//! Zero amounts are allowed and not recorded; negative amounts and every other function are
//! refused. The policy cannot see which rule a signer would have preferred: keep signers that it
//! constrains off rules without it, `Default` rules included, because the signer picks the rule.
#![no_std]

use soroban_sdk::{
    auth::{Context, ContractContext},
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error,
    symbol_short, Address, Env, Symbol, TryFromVal, Val, Vec,
};
use stellar_accounts::{
    policies::Policy,
    smart_account::{ContextRule, ContextRuleType, Signer},
};

/// Recorded spends kept per budget. Enforcement refuses new spends while the window is full.
pub const MAX_HISTORY: u32 = 256;
/// Spenders an `approve` allow-list may hold.
pub const MAX_SPENDERS: u32 = 16;

const DAY_IN_LEDGERS: u32 = 17_280;
const TTL_EXTEND_TO: u32 = 30 * DAY_IN_LEDGERS;
const TTL_THRESHOLD: u32 = TTL_EXTEND_TO - DAY_IN_LEDGERS;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum PolicyError {
    /// No budget is installed for this smart account and context rule.
    NotInstalled = 1,
    /// A budget is already installed for this smart account and context rule.
    AlreadyInstalled = 2,
    /// The limit is not positive, the period is zero or the spender list is too long.
    InvalidParams = 3,
    /// The policy can only be installed on a `CallContract` context rule.
    OnlyCallContract = 4,
    /// No signer of the context rule authenticated.
    NoSigner = 5,
    /// The context is not `transfer` or `approve` by this account, or its arguments are malformed.
    NotAllowed = 6,
    /// The amount is negative.
    NegativeAmount = 7,
    /// The amount would take the window's total over the spending limit.
    SpendingLimitExceeded = 8,
    /// `approve` names a spender outside the installed allow-list.
    SpenderNotAllowed = 9,
    /// The window already holds [`MAX_HISTORY`] spends.
    HistoryFull = 10,
}

/// Installation parameters, passed through the smart account's `add_context_rule` or
/// `add_policy`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ApproveSpendingLimitParams {
    pub spending_limit: i128,
    pub period_ledgers: u32,
    /// Allowed `approve` spenders; empty allows any spender.
    pub spenders: Vec<Address>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Spend {
    pub amount: i128,
    pub ledger: u32,
}

/// The stored budget of one smart account and context rule.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SpendingLimit {
    pub spending_limit: i128,
    pub period_ledgers: u32,
    pub spenders: Vec<Address>,
    /// Spends inside the current window, oldest first.
    pub history: Vec<Spend>,
    /// Sum of `history`.
    pub spent: i128,
}

#[contracttype]
enum StorageKey {
    Budget(Address, u32),
}

/// Published for every recorded spend. It names no balance change: the token's own events do.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SpendRecorded {
    #[topic]
    pub smart_account: Address,
    pub context_rule_id: u32,
    pub token: Address,
    pub function: Symbol,
    pub amount: i128,
    pub spent_in_period: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BudgetInstalled {
    #[topic]
    pub smart_account: Address,
    pub context_rule_id: u32,
    pub spending_limit: i128,
    pub period_ledgers: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BudgetUninstalled {
    #[topic]
    pub smart_account: Address,
    pub context_rule_id: u32,
}

#[contract]
pub struct ApproveSpendingLimitPolicy;

#[contractimpl]
impl Policy for ApproveSpendingLimitPolicy {
    type AccountParams = ApproveSpendingLimitParams;

    fn enforce(
        e: &Env,
        context: Context,
        authenticated_signers: Vec<Signer>,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        smart_account.require_auth();
        if authenticated_signers.is_empty() {
            panic_with_error!(e, PolicyError::NoSigner);
        }
        let key = StorageKey::Budget(smart_account.clone(), context_rule.id);
        let mut budget = load(e, &key);
        let (token, function, amount) = spend_of(e, &context, &smart_account, &budget);
        if amount < 0 {
            panic_with_error!(e, PolicyError::NegativeAmount);
        }
        if amount == 0 {
            return;
        }

        let now = e.ledger().sequence();
        evict(&mut budget, now);
        if amount > budget.spending_limit - budget.spent {
            panic_with_error!(e, PolicyError::SpendingLimitExceeded);
        }
        if budget.history.len() >= MAX_HISTORY {
            panic_with_error!(e, PolicyError::HistoryFull);
        }
        budget.history.push_back(Spend {
            amount,
            ledger: now,
        });
        budget.spent += amount;
        save(e, &key, &budget);

        SpendRecorded {
            smart_account,
            context_rule_id: context_rule.id,
            token,
            function,
            amount,
            spent_in_period: budget.spent,
        }
        .publish(e);
    }

    fn install(
        e: &Env,
        params: ApproveSpendingLimitParams,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        smart_account.require_auth();
        if !matches!(context_rule.context_type, ContextRuleType::CallContract(_)) {
            panic_with_error!(e, PolicyError::OnlyCallContract);
        }
        if params.spending_limit <= 0
            || params.period_ledgers == 0
            || params.spenders.len() > MAX_SPENDERS
        {
            panic_with_error!(e, PolicyError::InvalidParams);
        }
        let key = StorageKey::Budget(smart_account.clone(), context_rule.id);
        if e.storage().persistent().has(&key) {
            panic_with_error!(e, PolicyError::AlreadyInstalled);
        }
        let budget = SpendingLimit {
            spending_limit: params.spending_limit,
            period_ledgers: params.period_ledgers,
            spenders: params.spenders,
            history: Vec::new(e),
            spent: 0,
        };
        save(e, &key, &budget);

        BudgetInstalled {
            smart_account,
            context_rule_id: context_rule.id,
            spending_limit: budget.spending_limit,
            period_ledgers: budget.period_ledgers,
        }
        .publish(e);
    }

    fn uninstall(e: &Env, context_rule: ContextRule, smart_account: Address) {
        smart_account.require_auth();
        let key = StorageKey::Budget(smart_account.clone(), context_rule.id);
        if !e.storage().persistent().has(&key) {
            panic_with_error!(e, PolicyError::NotInstalled);
        }
        e.storage().persistent().remove(&key);

        BudgetUninstalled {
            smart_account,
            context_rule_id: context_rule.id,
        }
        .publish(e);
    }
}

#[contractimpl]
impl ApproveSpendingLimitPolicy {
    /// The budget of `smart_account` for `context_rule_id`, with spends that left the window
    /// already removed from `history` and `spent`.
    pub fn budget(e: &Env, context_rule_id: u32, smart_account: Address) -> SpendingLimit {
        let mut budget = load(e, &StorageKey::Budget(smart_account, context_rule_id));
        evict(&mut budget, e.ledger().sequence());
        budget
    }
}

fn load(e: &Env, key: &StorageKey) -> SpendingLimit {
    e.storage()
        .persistent()
        .get(key)
        .unwrap_or_else(|| panic_with_error!(e, PolicyError::NotInstalled))
}

fn save(e: &Env, key: &StorageKey, budget: &SpendingLimit) {
    let storage = e.storage().persistent();
    storage.set(key, budget);
    storage.extend_ttl(key, TTL_THRESHOLD, TTL_EXTEND_TO);
}

/// Drops spends recorded at or before `now - period_ledgers`.
fn evict(budget: &mut SpendingLimit, now: u32) {
    let cutoff = now.saturating_sub(budget.period_ledgers);
    while let Some(first) = budget.history.first() {
        if first.ledger > cutoff {
            break;
        }
        budget.spent -= first.amount;
        budget.history.pop_front();
    }
}

/// The token, function and amount of a `transfer` or `approve` that `smart_account` authorizes.
/// Anything else panics with [`PolicyError::NotAllowed`], and an `approve` to a spender outside a
/// non-empty allow-list with [`PolicyError::SpenderNotAllowed`].
fn spend_of(
    e: &Env,
    context: &Context,
    smart_account: &Address,
    budget: &SpendingLimit,
) -> (Address, Symbol, i128) {
    let Context::Contract(ContractContext {
        contract,
        fn_name,
        args,
    }) = context
    else {
        panic_with_error!(e, PolicyError::NotAllowed);
    };
    let is_transfer = *fn_name == symbol_short!("transfer");
    let is_approve = *fn_name == symbol_short!("approve");
    let expected_args = if is_transfer {
        3
    } else if is_approve {
        4
    } else {
        panic_with_error!(e, PolicyError::NotAllowed);
    };
    if args.len() != expected_args {
        panic_with_error!(e, PolicyError::NotAllowed);
    }
    let from = arg::<Address>(e, args, 0);
    if from != *smart_account {
        panic_with_error!(e, PolicyError::NotAllowed);
    }
    if is_approve && !budget.spenders.is_empty() {
        let spender = arg::<Address>(e, args, 1);
        if !budget.spenders.contains(&spender) {
            panic_with_error!(e, PolicyError::SpenderNotAllowed);
        }
    }
    (contract.clone(), fn_name.clone(), arg::<i128>(e, args, 2))
}

fn arg<T: TryFromVal<Env, Val>>(e: &Env, args: &Vec<Val>, index: u32) -> T {
    args.get(index)
        .and_then(|value| T::try_from_val(e, &value).ok())
        .unwrap_or_else(|| panic_with_error!(e, PolicyError::NotAllowed))
}

#[cfg(test)]
mod test;
