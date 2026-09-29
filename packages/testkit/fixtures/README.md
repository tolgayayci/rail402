# Test fixtures

| File                  | What it is                                                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `simple_account.wasm` | Minimal Soroban custom account: `init(public_key)`, and `__check_auth` verifies an ed25519 signature over the authorization payload. Used to test smart-account (`C…`) payers. |

`simple_account.wasm` is the `example_simple_account.wasm` test contract from
[stellar/rs-soroban-env](https://github.com/stellar/rs-soroban-env) at commit
`cb32250d926bd7188f3a6f9075bd48c44550dcac`
(`soroban-test-wasms/wasm-workspace/opt/20/`, source in `soroban-test-wasms/wasm-workspace/simple_account`),
licensed Apache-2.0. SHA-256: `bdec8e0b2e2f0b9023f1b44fbd54c7d10f4d085b46420073c95c6c0d0956315f`.
It is a test fixture only and is never deployed outside test networks.
