//! Adversarial tests of the x402 `upto` settlement contract, run against the deployed build.
//!
//! The contract under test is `packages/testkit/fixtures/x402_upto_stellar.wasm`, byte-identical to
//! the wasm deployed on testnet (`scripts/contracts/build.sh --contract upto --check` proves the
//! crate still builds it). Loading the wasm instead of the crate keeps `contracts/stellar/upto`
//! untouched and tests exactly the code that runs on chain.
//!
//! The tests cover what a hostile payer, seller, token or relayer could try:
//!
//! - `classic`: a classic `G…` payer with real ed25519 signatures: settle, replay, tampering;
//! - `overlap`: two live authorizations of one payer, in both orders, the same terms under two
//!   nonces, and an allowance the payer set beforehand;
//! - `hostile_token`: a token that lies about transfers, re-enters `settle`, or uses the payer's
//!   `approve` authorization against another asset;
//! - `replay`: a wrapper contract without the authority, other networks and other deployments;
//! - `boundaries`: the authority as payer, the payer or token as recipient, expirations at and past
//!   the maximum TTL and at `u32::MAX`, and an `i128::MAX` cap;
//! - `contexts`: what a contract account's `__check_auth` sees, also for a zero settlement.
//!
//! This crate has no library code; everything is under `#[cfg(test)]`.
#![no_std]

#[cfg(test)]
extern crate std;

#[cfg(test)]
mod test;
