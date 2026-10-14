//! A SEP-41 fungible token for test networks: the decimals are chosen at deployment, anyone can
//! mint from an open faucet, and there is no admin, pause, allow-list or block-list. It exists to
//! exercise payments in an asset that is not a Stellar Asset Contract and whose decimals differ
//! from the 7 of classic assets. It has no value and must never be deployed on a public network.
//!
//! The token logic is OpenZeppelin's `stellar-tokens` fungible `Base` with the burnable
//! extension, so the SEP-41 surface and its events are the library's:
//!
//! - `transfer`: topics `["transfer", from, to]`, data the bare `i128` amount;
//! - `approve`: topics `["approve", owner, spender]`, data the map `{amount, live_until_ledger}`;
//! - `mint`: topics `["mint", to]`, data the map `{amount}`.
#![no_std]

// `MuxedAddress` is named by the code that `contractimpl(contracttrait)` generates for `transfer`.
use soroban_sdk::{
    contract, contracterror, contractimpl, panic_with_error, Address, Env, MuxedAddress, String,
};
use stellar_tokens::fungible::{
    burnable::FungibleBurnable, Base, FungibleToken, INSTANCE_EXTEND_AMOUNT, INSTANCE_TTL_THRESHOLD,
};

/// The largest supported number of decimals. It keeps every faucet amount far inside `i128`.
pub const MAX_DECIMALS: u32 = 18;
/// Whole tokens minted by one `faucet` call.
pub const FAUCET_TOKENS: i128 = 100;
/// Whole tokens that one `mint_test` call may mint at most.
pub const MINT_CAP_TOKENS: i128 = 1_000_000;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum TestTokenError {
    /// `decimals` is larger than [`MAX_DECIMALS`].
    InvalidDecimals = 1,
    /// `mint_test` was asked for zero, a negative amount or more than the per-call cap.
    InvalidMintAmount = 2,
}

#[contract]
pub struct TestToken;

#[contractimpl]
impl TestToken {
    pub fn __constructor(e: &Env, name: String, symbol: String, decimals: u32) {
        if decimals > MAX_DECIMALS {
            panic_with_error!(e, TestTokenError::InvalidDecimals);
        }
        Base::set_metadata(e, decimals, name, symbol);
    }

    /// Mints [`FAUCET_TOKENS`] whole tokens to `to` and returns the minted atomic amount. Open to
    /// anyone; `to` does not need to authorize.
    pub fn faucet(e: &Env, to: Address) -> i128 {
        let amount = FAUCET_TOKENS * unit(e);
        mint(e, &to, amount);
        amount
    }

    /// Mints `amount` atomic units to `to`: more than zero and at most [`MINT_CAP_TOKENS`] whole
    /// tokens per call. Open to anyone; `to` does not need to authorize.
    pub fn mint_test(e: &Env, to: Address, amount: i128) {
        if amount <= 0 || amount > Self::mint_cap(e) {
            panic_with_error!(e, TestTokenError::InvalidMintAmount);
        }
        mint(e, &to, amount);
    }

    /// The largest atomic amount one `mint_test` call accepts.
    pub fn mint_cap(e: &Env) -> i128 {
        MINT_CAP_TOKENS * unit(e)
    }
}

/// One whole token in atomic units: `10^decimals`.
fn unit(e: &Env) -> i128 {
    10i128.pow(Base::decimals(e))
}

/// Mints through the library (balance update and `mint` event) and keeps the instance, which
/// holds the metadata, alive for as long as the faucet is used.
fn mint(e: &Env, to: &Address, amount: i128) {
    Base::mint(e, to, amount);
    e.storage()
        .instance()
        .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_EXTEND_AMOUNT);
}

#[contractimpl(contracttrait)]
impl FungibleToken for TestToken {
    type ContractType = Base;
}

#[contractimpl(contracttrait)]
impl FungibleBurnable for TestToken {}

#[cfg(test)]
mod test;
