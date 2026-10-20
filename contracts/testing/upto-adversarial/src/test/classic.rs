//! A classic `G…` payer with a trustline and real ed25519 signatures, checked by the host's
//! built-in account authentication (signers, weights and the medium threshold).
use std::rc::Rc;

use ed25519_dalek::{Signer as _, SigningKey};
use soroban_sdk::{
    testutils::{Address as _, StellarAssetContract},
    token::TokenClient,
    xdr::{
        self, ScErrorCode, ScMap, ScSymbol, ScVal, SorobanAuthorizationEntry,
        SorobanAuthorizedInvocation,
    },
    Address, Env, Error,
};

use super::{
    account_id, address_entry, auth_error, authority_entry, g_address, invoke_settle, payer_root,
    signature_payload, test_env, upto, Credentials, UptoTerms, AUTHORITY_SEED, EXPIRATION, MAX,
};

const BALANCE: i64 = 10_000_000;

/// Creates the account `master` (weight 1) with extra `signers` (weight 1 each), the medium
/// threshold `threshold`, and a trustline for the asset holding `BALANCE`.
fn put_account(
    env: &Env,
    master: &SigningKey,
    signers: &[&SigningKey],
    threshold: u8,
    sac: &StellarAssetContract,
) {
    let id = account_id(master);
    let account_key = Rc::new(xdr::LedgerKey::Account(xdr::LedgerKeyAccount {
        account_id: id.clone(),
    }));
    let extra: std::vec::Vec<xdr::Signer> = signers
        .iter()
        .map(|key| xdr::Signer {
            key: xdr::SignerKey::Ed25519(xdr::Uint256(key.verifying_key().to_bytes())),
            weight: 1,
        })
        .collect();
    let account = Rc::new(xdr::LedgerEntry {
        data: xdr::LedgerEntryData::Account(xdr::AccountEntry {
            account_id: id.clone(),
            balance: 100_000_000,
            flags: 0,
            home_domain: Default::default(),
            inflation_dest: None,
            num_sub_entries: 1 + signers.len() as u32,
            seq_num: xdr::SequenceNumber(0),
            thresholds: xdr::Thresholds([1, threshold, threshold, threshold]),
            signers: extra.try_into().unwrap(),
            ext: xdr::AccountEntryExt::V0,
        }),
        last_modified_ledger_seq: 0,
        ext: xdr::LedgerEntryExt::V0,
    });
    env.host()
        .add_ledger_entry(&account_key, &account, None)
        .unwrap();
    let asset = match sac.asset() {
        xdr::Asset::CreditAlphanum4(a) => xdr::TrustLineAsset::CreditAlphanum4(a),
        xdr::Asset::CreditAlphanum12(a) => xdr::TrustLineAsset::CreditAlphanum12(a),
        xdr::Asset::Native => unreachable!("the test asset is issued"),
    };
    let trustline_key = Rc::new(xdr::LedgerKey::Trustline(xdr::LedgerKeyTrustLine {
        account_id: id.clone(),
        asset: asset.clone(),
    }));
    let trustline = Rc::new(xdr::LedgerEntry {
        data: xdr::LedgerEntryData::Trustline(xdr::TrustLineEntry {
            account_id: id,
            asset,
            balance: BALANCE,
            limit: i64::MAX,
            flags: 1, // authorized
            ext: xdr::TrustLineEntryExt::V0,
        }),
        last_modified_ledger_seq: 0,
        ext: xdr::LedgerEntryExt::V0,
    });
    env.host()
        .add_ledger_entry(&trustline_key, &trustline, None)
        .unwrap();
}

/// A classic account signature: `Vec<{public_key, signature}>`, sorted by public key.
fn classic_signature(digest: &[u8; 32], keys: &[&SigningKey]) -> ScVal {
    let mut keys = keys.to_vec();
    keys.sort_by_key(|key| key.verifying_key().to_bytes());
    let entries: std::vec::Vec<ScVal> = keys
        .iter()
        .map(|key| {
            let map = ScMap::sorted_from(std::vec![
                (
                    ScVal::Symbol(ScSymbol("public_key".try_into().unwrap())),
                    ScVal::Bytes(xdr::ScBytes(
                        key.verifying_key().to_bytes().to_vec().try_into().unwrap()
                    )),
                ),
                (
                    ScVal::Symbol(ScSymbol("signature".try_into().unwrap())),
                    ScVal::Bytes(xdr::ScBytes(
                        key.sign(digest).to_bytes().to_vec().try_into().unwrap()
                    )),
                ),
            ])
            .unwrap();
            ScVal::Map(Some(map))
        })
        .collect();
    ScVal::Vec(Some(xdr::ScVec(entries.try_into().unwrap())))
}

struct Classic {
    env: Env,
    upto: Address,
    token: Address,
    payer: Address,
    facilitator: Address,
    recipient: Address,
}

impl Classic {
    fn new(master: &SigningKey, signers: &[&SigningKey], threshold: u8) -> Self {
        let env = test_env();
        let upto = env.register(upto::WASM, ());
        let issuer = Address::generate(&env);
        let sac = env.register_stellar_asset_contract_v2(issuer);
        put_account(&env, master, signers, threshold, &sac);
        let authority = SigningKey::from_bytes(&AUTHORITY_SEED);
        env.host()
            .set_source_account(account_id(&authority))
            .unwrap();
        Self {
            payer: g_address(&env, master),
            facilitator: g_address(&env, &authority),
            recipient: Address::generate(&env),
            token: sac.address(),
            upto,
            env,
        }
    }

    fn terms(&self, max_amount: i128) -> UptoTerms {
        UptoTerms {
            expiration_ledger: EXPIRATION,
            facilitator: self.facilitator.clone(),
            max_amount,
            recipient: self.recipient.clone(),
            token: self.token.clone(),
            valid_after_ledger: 0,
        }
    }

    fn root(&self, terms: &UptoTerms) -> SorobanAuthorizedInvocation {
        payer_root(&self.env, &self.upto, &self.payer, terms)
    }

    /// The payer's entry over `root`, signed by `keys`.
    fn entry(
        &self,
        root: SorobanAuthorizedInvocation,
        nonce: i64,
        expiration: u32,
        keys: &[&SigningKey],
    ) -> SorobanAuthorizationEntry {
        let digest = signature_payload(
            &self.env,
            &self.payer,
            &root,
            nonce,
            expiration,
            Credentials::V1,
        );
        let signature = classic_signature(&digest, keys);
        address_entry(
            &self.payer,
            root,
            nonce,
            expiration,
            signature,
            Credentials::V1,
        )
    }

    fn settle(
        &self,
        payer: SorobanAuthorizationEntry,
        terms: &UptoTerms,
        amount: i128,
    ) -> Result<i128, Error> {
        let authority = authority_entry(&self.env, &self.upto, &self.payer, terms, amount);
        self.env.set_auths(&[payer, authority]);
        invoke_settle(&self.env, &self.upto, &self.payer, terms, amount)
    }

    fn balance(&self, address: &Address) -> i128 {
        TokenClient::new(&self.env, &self.token).balance(address)
    }
}

#[test]
fn a_signed_classic_payment_settles_once() {
    let key = SigningKey::from_bytes(&[5; 32]);
    let c = Classic::new(&key, &[], 1);
    let terms = c.terms(MAX);
    let entry = c.entry(c.root(&terms), 1, EXPIRATION, &[&key]);
    assert_eq!(c.settle(entry.clone(), &terms, 1_234), Ok(1_234));
    assert_eq!(c.balance(&c.recipient), 1_234);
    assert_eq!(c.balance(&c.payer), BALANCE as i128 - 1_234);
    assert_eq!(
        c.settle(entry, &terms, 1),
        Err(auth_error(ScErrorCode::ExistingValue))
    );
    assert_eq!(c.balance(&c.payer), BALANCE as i128 - 1_234);
}

#[test]
fn a_classic_signature_over_other_terms_fails() {
    let key = SigningKey::from_bytes(&[5; 32]);
    let c = Classic::new(&key, &[], 1);
    let signed = c.terms(MAX);
    let mut stolen = signed.clone();
    stolen.recipient = Address::generate(&c.env);
    // Keep the signature, rewrite the invocation to pay someone else.
    let mut entry = c.entry(c.root(&signed), 2, EXPIRATION, &[&key]);
    entry.root_invocation = c.root(&stolen);
    assert_eq!(
        c.settle(entry, &stolen, 5),
        Err(auth_error(ScErrorCode::InvalidAction))
    );
    assert_eq!(c.balance(&c.payer), BALANCE as i128);
}

#[test]
fn a_key_that_is_not_a_signer_fails() {
    let key = SigningKey::from_bytes(&[5; 32]);
    let stranger = SigningKey::from_bytes(&[6; 32]);
    let c = Classic::new(&key, &[], 1);
    let terms = c.terms(MAX);
    let entry = c.entry(c.root(&terms), 3, EXPIRATION, &[&stranger]);
    assert_eq!(
        c.settle(entry, &terms, 5),
        Err(auth_error(ScErrorCode::InvalidAction))
    );
    let empty = c.entry(c.root(&terms), 4, EXPIRATION, &[]);
    assert_eq!(
        c.settle(empty, &terms, 5),
        Err(auth_error(ScErrorCode::InvalidAction))
    );
    assert_eq!(c.balance(&c.payer), BALANCE as i128);
}

#[test]
fn a_multisig_payer_needs_the_medium_threshold() {
    let key = SigningKey::from_bytes(&[5; 32]);
    let cosigner = SigningKey::from_bytes(&[7; 32]);
    let c = Classic::new(&key, &[&cosigner], 2);
    let terms = c.terms(MAX);
    let alone = c.entry(c.root(&terms), 5, EXPIRATION, &[&key]);
    assert_eq!(
        c.settle(alone, &terms, 5),
        Err(auth_error(ScErrorCode::InvalidAction))
    );
    assert_eq!(c.balance(&c.payer), BALANCE as i128);
    let both = c.entry(c.root(&terms), 6, EXPIRATION, &[&key, &cosigner]);
    assert_eq!(c.settle(both, &terms, 5), Ok(5));
    assert_eq!(c.balance(&c.payer), BALANCE as i128 - 5);
}

#[test]
fn a_classic_payer_cannot_be_charged_beyond_its_balance() {
    let key = SigningKey::from_bytes(&[5; 32]);
    let c = Classic::new(&key, &[], 1);
    let cap = 2 * BALANCE as i128;
    let terms = c.terms(cap);
    let entry = c.entry(c.root(&terms), 7, EXPIRATION, &[&key]);
    assert!(c.settle(entry.clone(), &terms, cap).is_err());
    assert_eq!(c.balance(&c.payer), BALANCE as i128);
    // The failed attempt rolled back, so the same entry still settles a covered amount.
    assert_eq!(c.settle(entry, &terms, 100), Ok(100));
}
