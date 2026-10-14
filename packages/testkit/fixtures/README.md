# Test fixtures

| File                          | What it is                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `simple_account.wasm`         | Minimal Soroban custom account: `init(public_key)`, and `__check_auth` verifies an ed25519 signature over the authorization payload. Used to test smart-account (`C…`) payers.                                                                                                                                                                   |
| `x402_upto_stellar.wasm`      | The `upto` settlement contract from `contracts/stellar/upto`, built reproducibly by `scripts/contracts/build.sh` the way stellar.expert's release workflow builds it (SEP-55 `source_repo` metadata). Its hash, source-archive hash, build image and CLI are in `x402_upto_stellar.provenance.json`; CI rebuilds it and fails on any difference. |
| `test_token.wasm`             | The SEP-41 test token from `contracts/testing/test-token` (decimals chosen at deployment, open faucet, no admin), built reproducibly by `scripts/contracts/build.sh`; provenance in `test_token.provenance.json`.                                                                                                                                |
| `approve_spending_limit.wasm` | The approve-aware spending-limit policy for OpenZeppelin smart accounts from `contracts/testing/approve-spending-limit`, built reproducibly by `scripts/contracts/build.sh`; provenance in `approve_spending_limit.provenance.json`.                                                                                                             |
| `oz_smart_account.wasm`       | OpenZeppelin's multisig smart account example (`multisig-account-example`), built by `scripts/contracts/fixtures.sh` from the pinned commit; provenance in `oz_smart_account.provenance.json`.                                                                                                                                                   |
| `oz_ed25519_verifier.wasm`    | OpenZeppelin's ed25519 verifier example (`multisig-ed25519-verifier-example`), built the same way; provenance in `oz_ed25519_verifier.provenance.json`.                                                                                                                                                                                          |

`simple_account.wasm` is the `example_simple_account.wasm` test contract from
[stellar/rs-soroban-env](https://github.com/stellar/rs-soroban-env) at commit
`cb32250d926bd7188f3a6f9075bd48c44550dcac`
(`soroban-test-wasms/wasm-workspace/opt/20/`, source in `soroban-test-wasms/wasm-workspace/simple_account`),
licensed Apache-2.0. SHA-256: `bdec8e0b2e2f0b9023f1b44fbd54c7d10f4d085b46420073c95c6c0d0956315f`.
It is a test fixture only and is never deployed outside test networks.

`oz_smart_account.wasm` and `oz_ed25519_verifier.wasm` are built from
[OpenZeppelin/stellar-contracts](https://github.com/OpenZeppelin/stellar-contracts) at commit
`a5bd8cbd3d0bb8efbd5cf5e2edf9734f87e47640` (`examples/multisig-smart-account/{account,ed25519-verifier}`), licensed
MIT, with that repository's `Cargo.lock` in the same pinned build image as the contracts above. CI rebuilds every
wasm here except `simple_account.wasm` and fails on any difference. All of them are test fixtures and are never
deployed outside test networks.
