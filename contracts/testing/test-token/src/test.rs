extern crate std;

use soroban_sdk::{
    symbol_short,
    testutils::{
        storage::Instance as _, Address as _, EnvTestConfig, Events as _, Ledger as _, MockAuth,
        MockAuthInvoke,
    },
    xdr, Address, Env, Error, IntoVal, Map, String, Symbol, TryFromVal, Val,
};

use crate::{TestToken, TestTokenClient, TestTokenError, FAUCET_TOKENS, MINT_CAP_TOKENS};

fn env() -> Env {
    let env = Env::new_with_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    env.ledger().set_sequence_number(1_000);
    env
}

fn deploy<'a>(env: &Env, symbol: &str, decimals: u32) -> TestTokenClient<'a> {
    let name = String::from_str(env, "Test Token");
    let symbol = String::from_str(env, symbol);
    let id = env.register(TestToken, (name, symbol, decimals));
    TestTokenClient::new(env, &id)
}

fn contract_error(code: u32) -> Error {
    Error::from_contract_error(code)
}

/// The events `token` published during the last invocation, as XDR.
fn token_events(env: &Env, token: &Address) -> std::vec::Vec<xdr::ContractEventBody> {
    let id = xdr::ScAddress::from(token);
    env.events()
        .all()
        .events()
        .iter()
        .filter(|event| event.contract_id.as_ref().map(|c| c.0 .0) == Some(contract_hash(&id)))
        .map(|event| event.body.clone())
        .collect()
}

fn contract_hash(address: &xdr::ScAddress) -> [u8; 32] {
    match address {
        xdr::ScAddress::Contract(id) => id.0 .0,
        _ => panic!("not a contract address"),
    }
}

fn sc<T: IntoVal<Env, Val>>(env: &Env, value: T) -> xdr::ScVal {
    xdr::ScVal::try_from_val(env, &value.into_val(env)).unwrap()
}

/// The `{amount}` map that `mint` and `burn` events carry as data.
fn amount_map(env: &Env, amount: i128) -> xdr::ScVal {
    let mut data: Map<Symbol, Val> = Map::new(env);
    data.set(Symbol::new(env, "amount"), amount.into_val(env));
    sc(env, data)
}

/// Mocks exactly one authorization: `address` for `fn_name(args)` on `contract`.
fn authorize(
    env: &Env,
    address: &Address,
    contract: &Address,
    fn_name: &str,
    args: soroban_sdk::Vec<Val>,
) {
    env.mock_auths(&[MockAuth {
        address,
        invoke: &MockAuthInvoke {
            contract,
            fn_name,
            args,
            sub_invokes: &[],
        },
    }]);
}

#[test]
fn metadata_comes_from_the_constructor() {
    let env = env();
    let six = deploy(&env, "TEST6", 6);
    assert_eq!(six.decimals(), 6);
    assert_eq!(six.symbol(), String::from_str(&env, "TEST6"));
    assert_eq!(six.name(), String::from_str(&env, "Test Token"));
    let eighteen = deploy(&env, "TEST18", 18);
    assert_eq!(eighteen.decimals(), 18);
    assert_eq!(eighteen.total_supply(), 0);
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn more_than_eighteen_decimals_is_refused() {
    let env = env();
    deploy(&env, "TEST19", 19);
}

#[test]
fn the_faucet_is_open_and_mints_one_hundred_tokens() {
    let env = env();
    let token = deploy(&env, "TEST6", 6);
    let holder = Address::generate(&env);
    // No authorization of any kind is installed: the faucet needs none.
    assert_eq!(token.faucet(&holder), 100_000_000);
    assert!(env.auths().is_empty());
    let events = token_events(&env, &token.address);
    assert_eq!(events.len(), 1);
    let xdr::ContractEventBody::V0(mint) = &events[0];
    assert_eq!(
        mint.topics.to_vec(),
        std::vec![sc(&env, symbol_short!("mint")), sc(&env, &holder)]
    );
    assert_eq!(mint.data, amount_map(&env, 100_000_000));

    assert_eq!(token.balance(&holder), FAUCET_TOKENS * 1_000_000);
    assert_eq!(token.total_supply(), 100_000_000);
}

#[test]
fn eighteen_decimals_reach_amounts_beyond_int64() {
    let env = env();
    let token = deploy(&env, "TEST18", 18);
    let (from, to) = (Address::generate(&env), Address::generate(&env));
    let minted = token.faucet(&from);
    assert_eq!(minted, 100 * 10i128.pow(18));
    assert!(minted > i128::from(i64::MAX));

    let amount = i128::from(i64::MAX) + 1;
    authorize(
        &env,
        &from,
        &token.address,
        "transfer",
        (&from, &to, amount).into_val(&env),
    );
    token.transfer(&from, &to, &amount);
    assert_eq!(token.balance(&to), amount);
    assert_eq!(token.balance(&from), minted - amount);
}

#[test]
fn mint_test_is_capped_per_call() {
    let env = env();
    let token = deploy(&env, "TEST6", 6);
    let holder = Address::generate(&env);
    let cap = MINT_CAP_TOKENS * 1_000_000;
    assert_eq!(token.mint_cap(), cap);

    token.mint_test(&holder, &cap);
    token.mint_test(&holder, &1);
    assert_eq!(token.balance(&holder), cap + 1);

    let refused = Err(Ok(contract_error(TestTokenError::InvalidMintAmount as u32)));
    assert_eq!(token.try_mint_test(&holder, &(cap + 1)), refused);
    assert_eq!(token.try_mint_test(&holder, &0), refused);
    assert_eq!(token.try_mint_test(&holder, &-1), refused);
    assert_eq!(token.balance(&holder), cap + 1);
}

#[test]
fn transfer_event_has_three_topics_and_a_bare_amount() {
    let env = env();
    let token = deploy(&env, "TEST6", 6);
    let (from, to) = (Address::generate(&env), Address::generate(&env));
    token.faucet(&from);

    authorize(
        &env,
        &from,
        &token.address,
        "transfer",
        (&from, &to, 250_000i128).into_val(&env),
    );
    token.transfer(&from, &to, &250_000);

    let events = token_events(&env, &token.address);
    assert_eq!(events.len(), 1);
    let xdr::ContractEventBody::V0(transfer) = &events[0];
    assert_eq!(
        transfer.topics.to_vec(),
        std::vec![
            sc(&env, symbol_short!("transfer")),
            sc(&env, &from),
            sc(&env, &to)
        ]
    );
    assert_eq!(transfer.data, sc(&env, 250_000i128));
    assert_eq!(token.balance(&to), 250_000);
}

#[test]
fn transfer_needs_the_holder_authorization() {
    let env = env();
    let token = deploy(&env, "TEST6", 6);
    let (from, to) = (Address::generate(&env), Address::generate(&env));
    token.faucet(&from);
    // The client narrows the host's `Error(Auth, InvalidAction)` to a context error.
    let result = token.try_transfer(&from, &to, &1);
    assert_eq!(
        result,
        Err(Ok(Error::from_type_and_code(
            xdr::ScErrorType::Context,
            xdr::ScErrorCode::InvalidAction
        )))
    );
    assert_eq!(token.balance(&from), 100_000_000);
}

#[test]
fn an_insufficient_balance_is_contract_error_100() {
    let env = env();
    let token = deploy(&env, "TEST6", 6);
    let (from, to) = (Address::generate(&env), Address::generate(&env));
    token.mint_test(&from, &10);
    authorize(
        &env,
        &from,
        &token.address,
        "transfer",
        (&from, &to, 11i128).into_val(&env),
    );
    assert_eq!(
        token.try_transfer(&from, &to, &11),
        Err(Ok(contract_error(100)))
    );
}

#[test]
fn approve_zero_with_ledger_zero_is_accepted() {
    let env = env();
    let token = deploy(&env, "TEST6", 6);
    let (owner, spender) = (Address::generate(&env), Address::generate(&env));
    authorize(
        &env,
        &owner,
        &token.address,
        "approve",
        (&owner, &spender, 0i128, 0u32).into_val(&env),
    );
    token.approve(&owner, &spender, &0, &0);
    assert_eq!(token.allowance(&owner, &spender), 0);
}

#[test]
fn approve_event_has_three_topics_and_map_data() {
    let env = env();
    let token = deploy(&env, "TEST6", 6);
    let (owner, spender) = (Address::generate(&env), Address::generate(&env));
    authorize(
        &env,
        &owner,
        &token.address,
        "approve",
        (&owner, &spender, 500i128, 1_100u32).into_val(&env),
    );
    token.approve(&owner, &spender, &500, &1_100);

    let events = token_events(&env, &token.address);
    assert_eq!(events.len(), 1);
    let xdr::ContractEventBody::V0(approve) = &events[0];
    assert_eq!(
        approve.topics.to_vec(),
        std::vec![
            sc(&env, symbol_short!("approve")),
            sc(&env, &owner),
            sc(&env, &spender)
        ]
    );
    let mut data: Map<Symbol, Val> = Map::new(&env);
    data.set(Symbol::new(&env, "amount"), 500i128.into_val(&env));
    data.set(
        Symbol::new(&env, "live_until_ledger"),
        1_100u32.into_val(&env),
    );
    assert_eq!(approve.data, sc(&env, data));
}

#[test]
fn transfer_from_spends_the_allowance() {
    let env = env();
    let token = deploy(&env, "TEST6", 6);
    let (owner, spender, to) = (
        Address::generate(&env),
        Address::generate(&env),
        Address::generate(&env),
    );
    token.faucet(&owner);
    authorize(
        &env,
        &owner,
        &token.address,
        "approve",
        (&owner, &spender, 700i128, 1_100u32).into_val(&env),
    );
    token.approve(&owner, &spender, &700, &1_100);

    authorize(
        &env,
        &spender,
        &token.address,
        "transfer_from",
        (&spender, &owner, &to, 300i128).into_val(&env),
    );
    token.transfer_from(&spender, &owner, &to, &300);
    assert_eq!(token.balance(&to), 300);
    assert_eq!(token.allowance(&owner, &spender), 400);

    authorize(
        &env,
        &spender,
        &token.address,
        "transfer_from",
        (&spender, &owner, &to, 401i128).into_val(&env),
    );
    assert_eq!(
        token.try_transfer_from(&spender, &owner, &to, &401),
        Err(Ok(contract_error(101)))
    );
}

#[test]
fn an_allowance_ends_after_its_live_until_ledger() {
    let env = env();
    let token = deploy(&env, "TEST6", 6);
    let (owner, spender) = (Address::generate(&env), Address::generate(&env));
    token.faucet(&owner);
    authorize(
        &env,
        &owner,
        &token.address,
        "approve",
        (&owner, &spender, 700i128, 1_010u32).into_val(&env),
    );
    token.approve(&owner, &spender, &700, &1_010);
    env.ledger().set_sequence_number(1_010);
    assert_eq!(token.allowance(&owner, &spender), 700);
    env.ledger().set_sequence_number(1_011);
    assert_eq!(token.allowance(&owner, &spender), 0);
}

#[test]
fn burn_reduces_the_supply() {
    let env = env();
    let token = deploy(&env, "TEST6", 6);
    let holder = Address::generate(&env);
    token.faucet(&holder);
    authorize(
        &env,
        &holder,
        &token.address,
        "burn",
        (&holder, 40_000_000i128).into_val(&env),
    );
    token.burn(&holder, &40_000_000);
    let events = token_events(&env, &token.address);
    assert_eq!(events.len(), 1);
    let xdr::ContractEventBody::V0(burn) = &events[0];
    assert_eq!(
        burn.topics.to_vec(),
        std::vec![sc(&env, symbol_short!("burn")), sc(&env, &holder)]
    );
    assert_eq!(burn.data, amount_map(&env, 40_000_000));
    assert_eq!(token.balance(&holder), 60_000_000);
    assert_eq!(token.total_supply(), 60_000_000);
}

#[test]
fn minting_extends_the_instance_ttl() {
    let env = env();
    let token = deploy(&env, "TEST6", 6);
    let before = env.as_contract(&token.address, || env.storage().instance().get_ttl());
    token.faucet(&Address::generate(&env));
    let after = env.as_contract(&token.address, || env.storage().instance().get_ttl());
    assert!(after > before, "ttl {before} -> {after}");
    assert_eq!(after, stellar_tokens::fungible::INSTANCE_EXTEND_AMOUNT);
}
