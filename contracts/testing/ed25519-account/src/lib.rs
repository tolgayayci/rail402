//! A custom account for test payments from a contract (`C…`) payer. Its one ed25519 owner key is
//! set by the constructor, inside the transaction that creates the contract, so no other account
//! can set it first. No other function writes state: nobody, the owner included, can replace the
//! key later, and the contract cannot be upgraded. Whoever holds the owner key controls the funds.
//!
//! `__check_auth` accepts an authorization when the signature is the owner's ed25519 signature
//! over the 32-byte signature payload, passed as its 64 raw bytes. It accepts any context: the
//! owner key authorizes everything the account does.
#![no_std]

use soroban_sdk::{
    auth::{Context, CustomAccountInterface},
    contract, contracterror, contractimpl,
    crypto::Hash,
    symbol_short, BytesN, Env, Symbol, Vec,
};

/// The instance storage key of the owner's ed25519 public key (`BytesN<32>`).
pub const OWNER: Symbol = symbol_short!("owner");

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum AccountError {
    /// The instance holds no owner key. An instance created with the constructor always has one.
    NoOwner = 1,
}

#[contract]
pub struct Ed25519Account;

#[contractimpl]
impl Ed25519Account {
    /// Binds `public_key` as the owner. The host runs it once, while it creates the contract.
    pub fn __constructor(env: Env, public_key: BytesN<32>) {
        env.storage().instance().set(&OWNER, &public_key);
    }
}

#[contractimpl]
impl CustomAccountInterface for Ed25519Account {
    type Signature = BytesN<64>;
    type Error = AccountError;

    fn __check_auth(
        env: Env,
        signature_payload: Hash<32>,
        signature: BytesN<64>,
        _auth_contexts: Vec<Context>,
    ) -> Result<(), AccountError> {
        let owner: BytesN<32> = env
            .storage()
            .instance()
            .get(&OWNER)
            .ok_or(AccountError::NoOwner)?;
        // Traps unless `signature` is the owner's signature over the payload.
        env.crypto()
            .ed25519_verify(&owner, &signature_payload.to_bytes().into(), &signature);
        Ok(())
    }
}

#[cfg(test)]
mod test;
