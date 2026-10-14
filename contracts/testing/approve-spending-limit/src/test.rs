//! Unit tests against the policy alone. The smart account's own authorization is mocked here;
//! the composition tests drive the policy from a real smart account with real signatures.
extern crate std;

use soroban_sdk::{
    auth::{Context, ContractContext},
    testutils::{Address as _, EnvTestConfig, Events as _, Ledger as _},
    vec, Address, Bytes, Env, Error, Event as _, IntoVal, String, Symbol, Val, Vec,
};
use stellar_accounts::smart_account::{ContextRule, ContextRuleType, Signer};

use crate::{
    ApproveSpendingLimitParams, ApproveSpendingLimitPolicy, ApproveSpendingLimitPolicyClient,
    PolicyError, SpendRecorded, MAX_HISTORY, MAX_SPENDERS,
};

const START: u32 = 1_000;
const LIMIT: i128 = 1_000;
const PERIOD: u32 = 100;

struct Setup<'a> {
    env: Env,
    policy: ApproveSpendingLimitPolicyClient<'a>,
    account: Address,
    token: Address,
    rule: ContextRule,
    signer: Signer,
    /// The installed `approve` allow-list.
    spenders: Vec<Address>,
}

impl Setup<'_> {
    fn new() -> Self {
        Self::with_spenders(0)
    }

    /// Installs a budget of `LIMIT` over `PERIOD` ledgers with `count` allowed spenders.
    fn with_spenders(count: u32) -> Self {
        let env = Env::new_with_config(EnvTestConfig {
            capture_snapshot_at_drop: false,
        });
        env.ledger().set_sequence_number(START);
        env.mock_all_auths();
        let policy_id = env.register(ApproveSpendingLimitPolicy, ());
        let policy = ApproveSpendingLimitPolicyClient::new(&env, &policy_id);
        let account = Address::generate(&env);
        let token = Address::generate(&env);
        let signer = Signer::External(Address::generate(&env), Bytes::from_array(&env, &[7; 32]));
        let rule = rule(
            &env,
            1,
            ContextRuleType::CallContract(token.clone()),
            &signer,
        );
        let spenders = Vec::from_iter(&env, (0..count).map(|_| Address::generate(&env)));
        let setup = Self {
            env,
            policy,
            account,
            token,
            rule,
            signer,
            spenders,
        };
        setup.install(&setup.params(LIMIT, PERIOD, setup.spenders.clone()));
        setup
    }

    fn params(
        &self,
        limit: i128,
        period: u32,
        spenders: Vec<Address>,
    ) -> ApproveSpendingLimitParams {
        ApproveSpendingLimitParams {
            spending_limit: limit,
            period_ledgers: period,
            spenders,
        }
    }

    fn install(&self, params: &ApproveSpendingLimitParams) {
        self.policy.install(params, &self.rule, &self.account);
    }

    fn call(&self, fn_name: &str, args: Vec<Val>) -> Context {
        Context::Contract(ContractContext {
            contract: self.token.clone(),
            fn_name: Symbol::new(&self.env, fn_name),
            args,
        })
    }

    fn transfer(&self, amount: i128) -> Context {
        let to = Address::generate(&self.env);
        self.call("transfer", (&self.account, to, amount).into_val(&self.env))
    }

    fn approve(&self, spender: &Address, amount: i128) -> Context {
        self.call(
            "approve",
            (&self.account, spender, amount, START + 50).into_val(&self.env),
        )
    }

    fn signers(&self) -> Vec<Signer> {
        vec![&self.env, self.signer.clone()]
    }

    fn enforce(&self, context: &Context) -> Result<(), Error> {
        match self
            .policy
            .try_enforce(context, &self.signers(), &self.rule, &self.account)
        {
            Ok(_) => Ok(()),
            Err(Ok(error)) => Err(error),
            Err(Err(error)) => panic!("invoke error {error:?}"),
        }
    }

    fn spent(&self) -> i128 {
        self.policy.budget(&self.rule.id, &self.account).spent
    }
}

fn rule(env: &Env, id: u32, context_type: ContextRuleType, signer: &Signer) -> ContextRule {
    ContextRule {
        id,
        context_type,
        name: String::from_str(env, "agent"),
        signers: vec![env, signer.clone()],
        signer_ids: vec![env, 0],
        policies: Vec::new(env),
        policy_ids: Vec::new(env),
        valid_until: None,
    }
}

fn policy_error(error: PolicyError) -> Result<(), Error> {
    Err(Error::from_contract_error(error as u32))
}

#[test]
fn transfers_and_approvals_share_one_budget() {
    let s = Setup::new();
    let spender = Address::generate(&s.env);
    assert_eq!(s.enforce(&s.transfer(300)), Ok(()));
    assert_eq!(s.enforce(&s.approve(&spender, 600)), Ok(()));
    assert_eq!(s.spent(), 900);
    assert_eq!(
        s.enforce(&s.approve(&spender, 101)),
        policy_error(PolicyError::SpendingLimitExceeded)
    );
    assert_eq!(
        s.enforce(&s.transfer(101)),
        policy_error(PolicyError::SpendingLimitExceeded)
    );
    // Exactly reaching the limit is allowed.
    assert_eq!(s.enforce(&s.transfer(100)), Ok(()));
    assert_eq!(s.spent(), LIMIT);
}

#[test]
fn a_recorded_spend_publishes_an_event() {
    let s = Setup::new();
    let spender = Address::generate(&s.env);
    s.enforce(&s.approve(&spender, 250)).unwrap();
    let expected = SpendRecorded {
        smart_account: s.account.clone(),
        context_rule_id: 1,
        token: s.token.clone(),
        function: Symbol::new(&s.env, "approve"),
        amount: 250,
        spent_in_period: 250,
    };
    let events = s.env.events().all().filter_by_contract(&s.policy.address);
    assert_eq!(
        events.events(),
        [expected.to_xdr(&s.env, &s.policy.address)]
    );
}

#[test]
fn zero_amounts_pass_even_with_an_exhausted_budget() {
    let s = Setup::new();
    let spender = Address::generate(&s.env);
    s.enforce(&s.transfer(LIMIT)).unwrap();
    assert_eq!(s.enforce(&s.approve(&spender, 0)), Ok(()));
    assert_eq!(s.enforce(&s.transfer(0)), Ok(()));
    let budget = s.policy.budget(&s.rule.id, &s.account);
    assert_eq!(budget.history.len(), 1);
}

#[test]
fn negative_amounts_are_refused() {
    let s = Setup::new();
    let spender = Address::generate(&s.env);
    assert_eq!(
        s.enforce(&s.approve(&spender, -1)),
        policy_error(PolicyError::NegativeAmount)
    );
    assert_eq!(
        s.enforce(&s.transfer(-5)),
        policy_error(PolicyError::NegativeAmount)
    );
}

#[test]
fn other_functions_and_foreign_owners_are_refused() {
    let s = Setup::new();
    let other = Address::generate(&s.env);
    let not_allowed = policy_error(PolicyError::NotAllowed);
    let transfer_from = s.call(
        "transfer_from",
        (&s.account, &other, &other, 5i128).into_val(&s.env),
    );
    assert_eq!(s.enforce(&transfer_from), not_allowed);
    let burn = s.call("burn", (&s.account, 5i128).into_val(&s.env));
    assert_eq!(s.enforce(&burn), not_allowed);
    // `from` must be the smart account itself.
    let foreign = s.call("transfer", (&other, &s.account, 5i128).into_val(&s.env));
    assert_eq!(s.enforce(&foreign), not_allowed);
    // Wrong arity or argument types.
    let short = s.call("approve", (&s.account, &other, 5i128).into_val(&s.env));
    assert_eq!(s.enforce(&short), not_allowed);
    let typed = s.call("transfer", (&s.account, &other, 5u32).into_val(&s.env));
    assert_eq!(s.enforce(&typed), not_allowed);
    assert_eq!(s.spent(), 0);
}

#[test]
fn contract_creation_contexts_are_refused() {
    let s = Setup::new();
    let context = Context::CreateContractHostFn(soroban_sdk::auth::CreateContractHostFnContext {
        executable: soroban_sdk::auth::ContractExecutable::Wasm(soroban_sdk::BytesN::from_array(
            &s.env, &[1; 32],
        )),
        salt: soroban_sdk::BytesN::from_array(&s.env, &[2; 32]),
    });
    assert_eq!(s.enforce(&context), policy_error(PolicyError::NotAllowed));
}

#[test]
fn a_spender_allow_list_limits_approvals_only() {
    let s = Setup::with_spenders(1);
    let allowed = s.spenders.get_unchecked(0);
    let stranger = Address::generate(&s.env);
    assert_eq!(s.enforce(&s.approve(&allowed, 10)), Ok(()));
    assert_eq!(
        s.enforce(&s.approve(&stranger, 10)),
        policy_error(PolicyError::SpenderNotAllowed)
    );
    assert_eq!(s.enforce(&s.transfer(10)), Ok(()));
    assert_eq!(s.spent(), 20);
}

#[test]
fn enforcement_needs_an_authenticated_signer() {
    let s = Setup::new();
    let result = s
        .policy
        .try_enforce(&s.transfer(1), &Vec::new(&s.env), &s.rule, &s.account);
    assert_eq!(
        result,
        Err(Ok(Error::from_contract_error(PolicyError::NoSigner as u32)))
    );
}

#[test]
fn enforcement_needs_the_smart_account_authorization() {
    let s = Setup::new();
    s.env.set_auths(&[]);
    // The client narrows the host's `Error(Auth, InvalidAction)` to a context error.
    assert_eq!(
        s.enforce(&s.transfer(1)),
        Err(Error::from_type_and_code(
            soroban_sdk::xdr::ScErrorType::Context,
            soroban_sdk::xdr::ScErrorCode::InvalidAction
        ))
    );
    s.env.mock_all_auths();
    assert_eq!(s.spent(), 0);
}

#[test]
fn spends_leave_the_window_after_period_ledgers() {
    let s = Setup::new();
    s.enforce(&s.transfer(600)).unwrap();
    s.env.ledger().set_sequence_number(START + 40);
    s.enforce(&s.transfer(400)).unwrap();
    // One ledger before the first spend leaves the window: still full.
    s.env.ledger().set_sequence_number(START + PERIOD - 1);
    assert_eq!(
        s.enforce(&s.transfer(1)),
        policy_error(PolicyError::SpendingLimitExceeded)
    );
    // The first spend no longer counts; the second still does.
    s.env.ledger().set_sequence_number(START + PERIOD);
    assert_eq!(s.spent(), 400);
    assert_eq!(s.enforce(&s.transfer(600)), Ok(()));
    assert_eq!(
        s.enforce(&s.transfer(1)),
        policy_error(PolicyError::SpendingLimitExceeded)
    );
}

#[test]
fn the_history_is_bounded() {
    let s = Setup::new();
    for _ in 0..MAX_HISTORY {
        s.enforce(&s.transfer(1)).unwrap();
    }
    assert_eq!(
        s.enforce(&s.transfer(1)),
        policy_error(PolicyError::HistoryFull)
    );
    assert_eq!(s.spent(), i128::from(MAX_HISTORY));
}

#[test]
fn install_validates_its_parameters() {
    let s = Setup::new();
    let other_rule = rule(
        &s.env,
        2,
        ContextRuleType::CallContract(s.token.clone()),
        &s.signer,
    );
    let install = |params: &ApproveSpendingLimitParams, rule: &ContextRule| {
        s.policy.try_install(params, rule, &s.account).map(|_| ())
    };
    let invalid = Err(Ok(Error::from_contract_error(
        PolicyError::InvalidParams as u32,
    )));
    let none = Vec::new(&s.env);
    assert_eq!(
        install(&s.params(0, PERIOD, none.clone()), &other_rule),
        invalid
    );
    assert_eq!(
        install(&s.params(-1, PERIOD, none.clone()), &other_rule),
        invalid
    );
    assert_eq!(
        install(&s.params(LIMIT, 0, none.clone()), &other_rule),
        invalid
    );
    let too_many = Vec::from_iter(
        &s.env,
        (0..=MAX_SPENDERS).map(|_| Address::generate(&s.env)),
    );
    assert_eq!(
        install(&s.params(LIMIT, PERIOD, too_many), &other_rule),
        invalid
    );

    let default_rule = rule(&s.env, 3, ContextRuleType::Default, &s.signer);
    assert_eq!(
        install(&s.params(LIMIT, PERIOD, none.clone()), &default_rule),
        Err(Ok(Error::from_contract_error(
            PolicyError::OnlyCallContract as u32
        )))
    );
    assert_eq!(
        install(&s.params(LIMIT, PERIOD, none.clone()), &s.rule),
        Err(Ok(Error::from_contract_error(
            PolicyError::AlreadyInstalled as u32
        )))
    );
    assert_eq!(install(&s.params(LIMIT, PERIOD, none), &other_rule), Ok(()));
}

#[test]
fn budgets_are_separate_per_rule_and_account() {
    let s = Setup::new();
    s.enforce(&s.transfer(LIMIT)).unwrap();
    let other_account = Address::generate(&s.env);
    s.policy.install(
        &s.params(LIMIT, PERIOD, Vec::new(&s.env)),
        &s.rule,
        &other_account,
    );
    let to = Address::generate(&s.env);
    let context = s.call("transfer", (&other_account, to, LIMIT).into_val(&s.env));
    assert_eq!(
        s.policy
            .try_enforce(&context, &s.signers(), &s.rule, &other_account),
        Ok(Ok(()))
    );
}

#[test]
fn uninstall_removes_the_budget() {
    let s = Setup::new();
    s.enforce(&s.transfer(10)).unwrap();
    s.policy.uninstall(&s.rule, &s.account);
    let not_installed = Err(Error::from_contract_error(PolicyError::NotInstalled as u32));
    assert_eq!(s.enforce(&s.transfer(10)), not_installed);
    assert_eq!(
        s.policy.try_uninstall(&s.rule, &s.account),
        Err(Ok(Error::from_contract_error(
            PolicyError::NotInstalled as u32
        )))
    );
    // A fresh installation starts from an empty window.
    s.install(&s.params(LIMIT, PERIOD, Vec::new(&s.env)));
    assert_eq!(s.spent(), 0);
}
