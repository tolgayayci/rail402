//! Composition tests for the x402 `upto` settlement contract and an OpenZeppelin smart account.
//!
//! The payer is the OpenZeppelin multisig smart account, built from a pinned commit
//! (`packages/testkit/fixtures/oz_smart_account.wasm`), with an ed25519 verifier contract and the
//! approve-aware spending-limit policy from `contracts/testing/approve-spending-limit`, all loaded
//! from their committed wasm fixtures. The upto contract is compiled from its crate. Every payer
//! authorization carries real ed25519 signatures checked by the account's `__check_auth`; nothing
//! on the smart-account path is mocked.
//!
//! The account is configured the way an agent wallet should be:
//!
//! | Rule | Context                     | Signer    | Policy                        |
//! | ---- | --------------------------- | --------- | ----------------------------- |
//! | 0    | `Default`                   | owner key | none                          |
//! | 1    | `CallContract(token)`       | agent key | approve-aware spending limit  |
//! | 2    | `CallContract(upto)`        | agent key | none (`settle` moves nothing) |
//!
//! `vectors` replays the test vectors of the TypeScript `@rail402.dev/upto` package against the
//! contract.
//!
//! This crate has no library code; everything is under `#[cfg(test)]`.
#![no_std]

#[cfg(test)]
extern crate std;

#[cfg(test)]
mod test;

#[cfg(test)]
mod vectors;
