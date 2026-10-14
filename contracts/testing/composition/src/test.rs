use ed25519_dalek::{Signer as _, SigningKey};
use soroban_env_host::Env as _;
use soroban_sdk::{
    testutils::{Address as _, EnvTestConfig, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    xdr::{
        self, AccountId, HashIdPreimage, HashIdPreimageSorobanAuthorization, InvokeContractArgs,
        Limits, PublicKey, ScAddress, ScErrorCode, ScErrorType, ScSymbol, ScVal,
        SorobanAddressCredentials, SorobanAuthorizationEntry, SorobanAuthorizedFunction,
        SorobanAuthorizedInvocation, SorobanCredentials, ToXdr, Uint256, VecM, WriteXdr,
    },
    Address, Bytes, BytesN, Env, Error, IntoVal, Map, String, Symbol, TryFromVal, Val, Vec,
};
use x402_upto_stellar::{UptoError, UptoSettlement, UptoTerms};

mod account {
    soroban_sdk::contractimport!(file = "../../../packages/testkit/fixtures/oz_smart_account.wasm");
}
mod verifier {
    soroban_sdk::contractimport!(
        file = "../../../packages/testkit/fixtures/oz_ed25519_verifier.wasm"
    );
}
mod policy {
    soroban_sdk::contractimport!(
        file = "../../../packages/testkit/fixtures/approve_spending_limit.wasm"
    );
}
mod test_token {
    soroban_sdk::contractimport!(file = "../../../packages/testkit/fixtures/test_token.wasm");
}

const START: u32 = 10_000;
/// Ledgers between signing and the expiration of the terms and signature.
const VALIDITY: u32 = 60;
/// The x402 cap of every payment in these tests.
const MAX: i128 = 1_000_000;
/// The spending-limit window.
const PERIOD: u32 = 17_280;
const FUNDED: i128 = 100 * MAX;

const OWNER_SEED: [u8; 32] = [11; 32];
const AGENT_SEED: [u8; 32] = [12; 32];
const AUTHORITY_SEED: [u8; 32] = [13; 32];

const DEFAULT_RULE: u32 = 0;
const TOKEN_RULE: u32 = 1;
const UPTO_RULE: u32 = 2;

/// Which SEP-41 token the payments use.
#[derive(Clone, Copy)]
enum Token {
    /// A Stellar Asset Contract.
    Sac,
    /// The OpenZeppelin-based test token, 6 decimals.
    Test6,
}

struct Setup {
    env: Env,
    upto: Address,
    token: Address,
    account: Address,
    verifier: Address,
    policy: Address,
    facilitator: Address,
    recipient: Address,
    owner: SigningKey,
    agent: SigningKey,
    next_nonce: core::cell::Cell<i64>,
}

fn sc<T: IntoVal<Env, Val>>(env: &Env, value: T) -> ScVal {
    ScVal::try_from_val(env, &value.into_val(env)).unwrap()
}

fn account_id(key: &SigningKey) -> AccountId {
    AccountId(PublicKey::PublicKeyTypeEd25519(Uint256(
        key.verifying_key().to_bytes(),
    )))
}

fn g_address(env: &Env, key: &SigningKey) -> Address {
    Address::try_from_val(env, &ScVal::Address(ScAddress::Account(account_id(key)))).unwrap()
}

fn invocation(
    contract: &Address,
    function: &str,
    args: std::vec::Vec<ScVal>,
    children: std::vec::Vec<SorobanAuthorizedInvocation>,
) -> SorobanAuthorizedInvocation {
    SorobanAuthorizedInvocation {
        function: SorobanAuthorizedFunction::ContractFn(InvokeContractArgs {
            contract_address: ScAddress::from(contract),
            function_name: ScSymbol(function.try_into().unwrap()),
            args: args.try_into().unwrap(),
        }),
        sub_invocations: children.try_into().unwrap_or_else(|_| VecM::default()),
    }
}

fn auth_error(code: ScErrorCode) -> Error {
    Error::from_type_and_code(ScErrorType::Auth, code)
}

impl Setup {
    fn new(token: Token) -> Self {
        let env = Env::new_with_config(EnvTestConfig {
            capture_snapshot_at_drop: false,
        });
        env.ledger().set_sequence_number(START);
        let owner = SigningKey::from_bytes(&OWNER_SEED);
        let agent = SigningKey::from_bytes(&AGENT_SEED);
        let authority = SigningKey::from_bytes(&AUTHORITY_SEED);

        let upto = env.register(UptoSettlement, ());
        let verifier = env.register(verifier::WASM, ());
        let policy = env.register(policy::WASM, ());
        let owner_signer = account::Signer::External(verifier.clone(), public_key(&env, &owner));
        let account = env.register(
            account::WASM,
            (
                soroban_sdk::vec![&env, owner_signer],
                Map::<Address, Val>::new(&env),
            ),
        );
        let token = match token {
            Token::Sac => {
                let issuer = Address::generate(&env);
                let sac = env.register_stellar_asset_contract_v2(issuer).address();
                env.mock_all_auths();
                StellarAssetClient::new(&env, &sac).mint(&account, &FUNDED);
                sac
            }
            Token::Test6 => {
                let id = env.register(
                    test_token::WASM,
                    (
                        String::from_str(&env, "Test Token (6 decimals)"),
                        String::from_str(&env, "TEST6"),
                        6u32,
                    ),
                );
                test_token::Client::new(&env, &id).mint_test(&account, &FUNDED);
                id
            }
        };
        // From here on every authorization must be supplied explicitly.
        env.set_auths(&[]);

        let facilitator = g_address(&env, &authority);
        env.host()
            .set_source_account(account_id(&authority))
            .unwrap();
        let s = Self {
            upto,
            token,
            account,
            verifier,
            policy,
            facilitator,
            recipient: Address::generate(&env),
            owner,
            agent,
            env,
            next_nonce: core::cell::Cell::new(1),
        };
        s.add_agent_rules(3 * MAX);
        s
    }

    fn signer(&self, key: &SigningKey) -> account::Signer {
        account::Signer::External(self.verifier.clone(), public_key(&self.env, key))
    }

    fn nonce(&self) -> i64 {
        let nonce = self.next_nonce.get();
        self.next_nonce.set(nonce + 1);
        nonce
    }

    /// Adds rules 1 and 2 (see the crate docs), authorized by the owner through rule 0.
    fn add_agent_rules(&self, spending_limit: i128) {
        let rule = self.add_budget_rule(spending_limit);
        assert_eq!(rule.id, TOKEN_RULE);
        let rule = self.add_rule(
            account::ContextRuleType::CallContract(self.upto.clone()),
            "agent upto terms",
            Map::new(&self.env),
        );
        assert_eq!(rule.id, UPTO_RULE);
    }

    /// Adds a `CallContract(token)` rule for the agent key with its own budget.
    fn add_budget_rule(&self, spending_limit: i128) -> account::ContextRule {
        let params = policy::ApproveSpendingLimitParams {
            spending_limit,
            period_ledgers: PERIOD,
            spenders: Vec::new(&self.env),
        };
        let mut policies = Map::<Address, Val>::new(&self.env);
        policies.set(self.policy.clone(), params.into_val(&self.env));
        self.add_rule(
            account::ContextRuleType::CallContract(self.token.clone()),
            "agent payments",
            policies,
        )
    }

    fn add_rule(
        &self,
        context_type: account::ContextRuleType,
        name: &str,
        policies: Map<Address, Val>,
    ) -> account::ContextRule {
        let env = &self.env;
        let name = String::from_str(env, name);
        let signers = soroban_sdk::vec![env, self.signer(&self.agent)];
        let valid_until: Option<u32> = None;
        let root = invocation(
            &self.account,
            "add_context_rule",
            std::vec![
                sc(env, context_type.clone()),
                sc(env, name.clone()),
                sc(env, valid_until),
                sc(env, signers.clone()),
                sc(env, policies.clone()),
            ],
            std::vec![],
        );
        let entry = self.sign(root, &[&self.owner], &[DEFAULT_RULE], START + VALIDITY);
        env.set_auths(&[entry]);
        account::Client::new(env, &self.account).add_context_rule(
            &context_type,
            &name,
            &valid_until,
            &signers,
            &policies,
        )
    }

    /// An authorization entry of the smart account for `root`, signed by `keys` for the context
    /// rules `rule_ids`, as an OpenZeppelin smart-account wallet builds it: each key signs
    /// `sha256(signature_payload || xdr(rule_ids))`.
    fn sign(
        &self,
        root: SorobanAuthorizedInvocation,
        keys: &[&SigningKey],
        rule_ids: &[u32],
        expiration: u32,
    ) -> SorobanAuthorizationEntry {
        let env = &self.env;
        let nonce = self.nonce();
        let preimage = HashIdPreimage::SorobanAuthorization(HashIdPreimageSorobanAuthorization {
            network_id: xdr::Hash(env.ledger().network_id().to_array()),
            nonce,
            signature_expiration_ledger: expiration,
            invocation: root.clone(),
        });
        let payload = env
            .crypto()
            .sha256(&Bytes::from_slice(
                env,
                &preimage.to_xdr(Limits::none()).unwrap(),
            ))
            .to_bytes();
        let rule_ids = Vec::from_slice(env, rule_ids);
        let mut signed = Bytes::from(payload);
        signed.append(&rule_ids.clone().to_xdr(env));
        let digest = env.crypto().sha256(&signed).to_array();

        let mut signers = Map::new(env);
        for key in keys {
            let signature = key.sign(&digest).to_bytes();
            signers.set(self.signer(key), Bytes::from_array(env, &signature));
        }
        let auth_payload = account::AuthPayload {
            context_rule_ids: rule_ids,
            signers,
        };
        SorobanAuthorizationEntry {
            credentials: SorobanCredentials::Address(SorobanAddressCredentials {
                address: ScAddress::from(&self.account),
                nonce,
                signature_expiration_ledger: expiration,
                signature: sc(env, auth_payload),
            }),
            root_invocation: root,
        }
    }

    /// Terms valid from now for `VALIDITY` ledgers.
    fn terms(&self) -> UptoTerms {
        UptoTerms {
            expiration_ledger: self.env.ledger().sequence() + VALIDITY,
            facilitator: self.facilitator.clone(),
            max_amount: MAX,
            recipient: self.recipient.clone(),
            token: self.token.clone(),
            valid_after_ledger: 0,
        }
    }

    /// The payer's tree: `settle(terms)` with the `approve` child.
    fn payer_root(&self, terms: &UptoTerms) -> SorobanAuthorizedInvocation {
        let env = &self.env;
        let approve = invocation(
            &terms.token,
            "approve",
            std::vec![
                sc(env, &self.account),
                sc(env, &self.upto),
                sc(env, terms.max_amount),
                sc(env, terms.expiration_ledger),
            ],
            std::vec![],
        );
        invocation(
            &self.upto,
            "settle",
            std::vec![sc(env, terms.clone())],
            std::vec![approve],
        )
    }

    /// The agent's authorization, with rule ids for the contexts `[settle, approve]`.
    fn agent_entry(&self, terms: &UptoTerms, rule_ids: [u32; 2]) -> SorobanAuthorizationEntry {
        self.sign(
            self.payer_root(terms),
            &[&self.agent],
            &rule_ids,
            terms.expiration_ledger,
        )
    }

    /// The facilitator's `SOURCE_ACCOUNT` entry for `settle(payer, terms, amount)`.
    fn authority_entry(&self, terms: &UptoTerms, amount: i128) -> SorobanAuthorizationEntry {
        let env = &self.env;
        SorobanAuthorizationEntry {
            credentials: SorobanCredentials::SourceAccount,
            root_invocation: invocation(
                &self.upto,
                "settle",
                std::vec![
                    sc(env, &self.account),
                    sc(env, terms.clone()),
                    sc(env, amount)
                ],
                std::vec![],
            ),
        }
    }

    /// Settles `amount` under `terms` with `payer_entry`, through the host so that the granular
    /// error is visible.
    fn settle(
        &self,
        payer_entry: SorobanAuthorizationEntry,
        terms: &UptoTerms,
        amount: i128,
    ) -> Result<i128, Error> {
        let env = &self.env;
        env.set_auths(&[payer_entry, self.authority_entry(terms, amount)]);
        let args: Vec<Val> = (self.account.clone(), terms.clone(), amount).into_val(env);
        env.host()
            .call(
                self.upto.to_object(),
                Symbol::new(env, "settle").to_symbol_val(),
                args.to_object(),
            )
            .map(|value| i128::try_from_val(env, &value).unwrap())
            .map_err(|error| error.error)
    }

    /// One payment the way an agent makes it: fresh terms, the agent key, rules 2 and 1.
    fn pay(&self, amount: i128) -> Result<i128, Error> {
        let terms = self.terms();
        self.settle(
            self.agent_entry(&terms, [UPTO_RULE, TOKEN_RULE]),
            &terms,
            amount,
        )
    }

    /// A direct `transfer` of `amount` from the account to the recipient, signed by the agent
    /// under the token rule, so it is budgeted by the same policy.
    fn transfer(&self, amount: i128) {
        let env = &self.env;
        let root = invocation(
            &self.token,
            "transfer",
            std::vec![
                sc(env, &self.account),
                sc(env, &self.recipient),
                sc(env, amount)
            ],
            std::vec![],
        );
        let entry = self.sign(root, &[&self.agent], &[TOKEN_RULE], START + VALIDITY);
        env.set_auths(&[entry]);
        TokenClient::new(env, &self.token).transfer(&self.account, &self.recipient, &amount);
    }

    /// The error that `contract` raised last, read from the host's diagnostic events
    /// (which include the events of failed calls). This is how a test tells which contract
    /// refused an authorization that the host reports as `Error(Auth, InvalidAction)`.
    fn last_error_of(&self, contract: &Address) -> Option<Error> {
        let id = match ScAddress::from(contract) {
            ScAddress::Contract(id) => id,
            _ => unreachable!(),
        };
        let error = sc(&self.env, Symbol::new(&self.env, "error"));
        let events = self.env.host().get_events().unwrap().0;
        events.iter().rev().find_map(|host_event| {
            let event = &host_event.event;
            if event.type_ != xdr::ContractEventType::Diagnostic
                || event.contract_id.as_ref() != Some(&id)
            {
                return None;
            }
            let xdr::ContractEventBody::V0(body) = &event.body;
            match body.topics.as_slice() {
                [topic, ScVal::Error(raised)] if *topic == error => {
                    Some(Error::from(raised.clone()))
                }
                _ => None,
            }
        })
    }

    fn balance(&self, address: &Address) -> i128 {
        TokenClient::new(&self.env, &self.token).balance(address)
    }

    /// The amount of the agent's budget used in the current window.
    fn spent(&self) -> i128 {
        policy::Client::new(&self.env, &self.policy)
            .budget(&TOKEN_RULE, &self.account)
            .spent
    }

    fn assert_balances(&self, paid: i128) {
        assert_eq!(self.balance(&self.account), FUNDED - paid);
        assert_eq!(self.balance(&self.recipient), paid);
        // The facilitator is a `G…` account without a trustline, so it cannot hold the token.
        for party in [&self.upto, &self.policy, &self.verifier] {
            assert_eq!(self.balance(party), 0);
        }
    }
}

fn public_key(env: &Env, key: &SigningKey) -> Bytes {
    Bytes::from_array(env, &key.verifying_key().to_bytes())
}

/// `SpendingLimitExceeded` of the approve-aware spending-limit policy.
const POLICY_LIMIT_EXCEEDED: u32 = 8;
/// `UnvalidatedContext` of the OpenZeppelin smart account: the selected rule does not cover the
/// context, or its signers did not all sign.
const ACCOUNT_UNVALIDATED_CONTEXT: u32 = 3002;

/// The error the host reports when the smart account's `__check_auth`, or a policy it runs,
/// refuses an authorization.
fn refused() -> Error {
    auth_error(ScErrorCode::InvalidAction)
}

#[test]
fn payments_within_the_budget_settle() {
    for token in [Token::Sac, Token::Test6] {
        let s = Setup::new(token);
        assert_eq!(s.pay(300_000), Ok(300_000));
        assert_eq!(s.pay(MAX), Ok(MAX));
        assert_eq!(s.pay(0), Ok(0));
        s.assert_balances(300_000 + MAX);
        // Every payment reserves its full cap, including the zero settlement.
        assert_eq!(s.spent(), 3 * MAX);
    }
}

#[test]
fn a_fourth_payment_after_the_budget_is_used_fails_in_the_policy() {
    let s = Setup::new(Token::Sac);
    for _ in 0..3 {
        assert_eq!(s.pay(100), Ok(100));
    }
    assert_eq!(s.pay(100), Err(refused()));
    assert_eq!(
        s.last_error_of(&s.policy),
        Some(Error::from_contract_error(POLICY_LIMIT_EXCEEDED))
    );
    s.assert_balances(300);
    assert_eq!(s.spent(), 3 * MAX);
}

#[test]
fn a_cap_above_the_remaining_budget_fails_even_for_a_small_amount() {
    let s = Setup::new(Token::Sac);
    assert_eq!(s.pay(MAX), Ok(MAX));
    assert_eq!(s.pay(MAX), Ok(MAX));
    // Take the remaining budget below one cap with a direct transfer under the same rule.
    s.transfer(1);
    assert_eq!(s.spent(), 2 * MAX + 1);
    assert_eq!(s.pay(1), Err(refused()));
    assert_eq!(
        s.last_error_of(&s.policy),
        Some(Error::from_contract_error(POLICY_LIMIT_EXCEEDED))
    );
    assert_eq!(s.balance(&s.recipient), 2 * MAX + 1);
}

#[test]
fn the_budget_frees_up_when_the_window_moves_on() {
    // The same exhausted account pays again once its earlier spends leave the window: nothing
    // but the budget was in the way.
    let s = Setup::new(Token::Sac);
    for _ in 0..3 {
        s.pay(1).unwrap();
    }
    assert_eq!(s.pay(1), Err(refused()));
    assert_eq!(
        s.last_error_of(&s.policy),
        Some(Error::from_contract_error(POLICY_LIMIT_EXCEEDED))
    );
    s.env.ledger().set_sequence_number(START + PERIOD);
    assert_eq!(s.spent(), 0);
    assert_eq!(s.pay(1), Ok(1));
}

#[test]
fn an_amount_over_the_cap_is_contract_error_3() {
    let s = Setup::new(Token::Sac);
    let terms = s.terms();
    let entry = s.agent_entry(&terms, [UPTO_RULE, TOKEN_RULE]);
    assert_eq!(
        s.settle(entry.clone(), &terms, MAX + 1),
        Err(UptoError::AmountExceedsMax.into())
    );
    // Nothing was spent and nothing was recorded; the same entry still settles within the cap.
    assert_eq!(s.spent(), 0);
    assert_eq!(s.settle(entry, &terms, MAX), Ok(MAX));
    s.assert_balances(MAX);
}

#[test]
fn the_agent_key_cannot_use_the_default_rule() {
    let s = Setup::new(Token::Sac);
    let terms = s.terms();
    for rule_ids in [[DEFAULT_RULE, DEFAULT_RULE], [UPTO_RULE, DEFAULT_RULE]] {
        let entry = s.agent_entry(&terms, rule_ids);
        assert_eq!(s.settle(entry, &terms, 10), Err(refused()));
        assert_eq!(
            s.last_error_of(&s.account),
            Some(Error::from_contract_error(ACCOUNT_UNVALIDATED_CONTEXT))
        );
    }
    s.assert_balances(0);
    assert_eq!(s.spent(), 0);
}

#[test]
fn the_agent_key_cannot_route_the_approval_around_the_policy() {
    // Rule 2 has no policy but only covers the upto contract, so it cannot match `approve`.
    let s = Setup::new(Token::Sac);
    let terms = s.terms();
    let entry = s.agent_entry(&terms, [UPTO_RULE, UPTO_RULE]);
    assert_eq!(s.settle(entry, &terms, 10), Err(refused()));
    assert_eq!(
        s.last_error_of(&s.account),
        Some(Error::from_contract_error(ACCOUNT_UNVALIDATED_CONTEXT))
    );
    s.assert_balances(0);
}

#[test]
fn the_rule_selection_is_bound_by_the_signature() {
    // A second token rule for the agent with a larger budget. The agent signs for the small one;
    // whoever relays the entry cannot move it to the large one, because the account's signed
    // digest covers the rule ids.
    let s = Setup::new(Token::Sac);
    let large = s.add_budget_rule(100 * MAX);
    for _ in 0..3 {
        s.pay(1).unwrap();
    }
    let terms = s.terms();
    let mut entry = s.agent_entry(&terms, [UPTO_RULE, TOKEN_RULE]);
    let SorobanCredentials::Address(credentials) = &mut entry.credentials else {
        unreachable!()
    };
    let mut payload = account::AuthPayload::try_from_val(&s.env, &credentials.signature).unwrap();
    payload.context_rule_ids = soroban_sdk::vec![&s.env, UPTO_RULE, large.id];
    credentials.signature = sc(&s.env, payload);
    assert_eq!(s.settle(entry, &terms, 10), Err(refused()));
    // The verifier refuses the signature over the altered digest.
    assert_eq!(
        s.last_error_of(&s.verifier),
        Some(Error::from_type_and_code(
            ScErrorType::Crypto,
            ScErrorCode::InvalidInput
        ))
    );
    s.assert_balances(3);
    // Signed for the large rule, the same payment goes through.
    let entry = s.agent_entry(&terms, [UPTO_RULE, large.id]);
    assert_eq!(s.settle(entry, &terms, 10), Ok(10));
}

#[test]
fn the_owner_key_pays_through_the_default_rule_without_a_budget() {
    let s = Setup::new(Token::Sac);
    let terms = s.terms();
    let entry = s.sign(
        s.payer_root(&terms),
        &[&s.owner],
        &[DEFAULT_RULE, DEFAULT_RULE],
        terms.expiration_ledger,
    );
    assert_eq!(s.settle(entry, &terms, 500), Ok(500));
    assert_eq!(s.spent(), 0);
}

#[test]
fn a_used_authorization_cannot_be_replayed() {
    let s = Setup::new(Token::Sac);
    let terms = s.terms();
    let entry = s.agent_entry(&terms, [UPTO_RULE, TOKEN_RULE]);
    assert_eq!(s.settle(entry.clone(), &terms, 10), Ok(10));
    assert_eq!(
        s.settle(entry, &terms, 10),
        Err(auth_error(ScErrorCode::ExistingValue))
    );
    s.assert_balances(10);
    assert_eq!(s.spent(), MAX);
}

#[test]
fn fixtures_are_the_expected_contracts() {
    let s = Setup::new(Token::Test6);
    assert_eq!(test_token::Client::new(&s.env, &s.token).decimals(), 6);
    let verified = verifier::Client::new(&s.env, &s.verifier).canonicalize_key(
        &BytesN::from_array(&s.env, &s.owner.verifying_key().to_bytes()),
    );
    assert_eq!(verified, public_key(&s.env, &s.owner));
}
