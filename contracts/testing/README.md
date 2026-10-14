# Test contracts

Contracts that exist to test payments on test networks. None of them is meant for a public network.

| Crate                     | What it is                                                                                  | SDK                  |
| ------------------------- | ------------------------------------------------------------------------------------------- | -------------------- |
| `test-token/`             | SEP-41 token with configurable decimals and an open faucet                                  | `soroban-sdk` 27.0.2 |
| `approve-spending-limit/` | Spending-limit policy for OpenZeppelin smart accounts that budgets `approve` and `transfer` | `soroban-sdk` 27.0.2 |
| `composition/`            | Tests only: the `upto` contract with an OpenZeppelin smart account, verifier and the policy | `soroban-sdk` 28.0.0 |

Each crate is its own Cargo project with its own lockfile and `rust-toolchain.toml` (rust 1.98.0). The two
contracts depend on [OpenZeppelin Stellar Contracts](https://github.com/OpenZeppelin/stellar-contracts) (MIT)
at commit `a5bd8cbd3d0bb8efbd5cf5e2edf9734f87e47640`, which requires `soroban-sdk` 27; contracts built with it
run on protocol 28 networks.

## `test-token/` — `rail402-test-token`

A fungible token built from OpenZeppelin's `stellar-tokens` fungible `Base` and burnable extension, so it has
the full SEP-41 surface (`balance`, `transfer`, `transfer_from`, `approve`, `allowance`, `burn`, `burn_from`,
`decimals`, `name`, `symbol`) plus `total_supply`. It has no admin, owner, pause, allow-list or block-list.

```rust
fn __constructor(env: Env, name: String, symbol: String, decimals: u32); // decimals 0..=18
fn faucet(env: Env, to: Address) -> i128;               // mints 100 whole tokens, no authorization
fn mint_test(env: Env, to: Address, amount: i128);      // 0 < amount <= mint_cap(), no authorization
fn mint_cap(env: Env) -> i128;                          // 1,000,000 whole tokens
```

Deployed with 6 decimals it is `TEST6`; with 18 decimals, `TEST18`, whose amounts go beyond the 64-bit range.
Minting extends the contract instance's TTL, so a token that is being used stays live.

| Event      | Topics                          | Data                              |
| ---------- | ------------------------------- | --------------------------------- |
| `transfer` | `"transfer"`, `from`, `to`      | the amount, a bare `i128`         |
| `approve`  | `"approve"`, `owner`, `spender` | map `{amount, live_until_ledger}` |
| `mint`     | `"mint"`, `to`                  | map `{amount}`                    |
| `burn`     | `"burn"`, `from`                | map `{amount}`                    |

Event consumers that also read Stellar Asset Contract events should note that the `approve` data here is a
map.

### Testnet: `TEST6`

| Network           | Contract                                                   | Decimals | Record                                                             |
| ----------------- | ---------------------------------------------------------- | -------- | ------------------------------------------------------------------ |
| `stellar:testnet` | `CDS45IRSWVDBV4JM2FPZ52EYXYO54J6DJL35GOSXOTRA4BYM6FFRK2BK` | 6        | [`deployments/test6-testnet.json`](deployments/test6-testnet.json) |

[View `TEST6` on stellar.expert](https://stellar.expert/explorer/testnet/contract/CDS45IRSWVDBV4JM2FPZ52EYXYO54J6DJL35GOSXOTRA4BYM6FFRK2BK).
Anyone can mint it: `stellar contract invoke --id <TEST6> --network testnet --source <account> -- faucet --to <address>`
gives 100 `TEST6`. Tests import the address as `TEST6_TESTNET` from `@rail402.dev/testkit`. It was deployed with
`scripts/contracts/deploy.sh --contract test-token --symbol TEST6 --decimals 6` (salt
`sha256("rail402-test-token/v1/TEST6")`), its instance and code were extended to the maximum TTL, and
`scripts/contracts/verify.sh --record contracts/testing/deployments/test6-testnet.json` rebuilds it and compares
it with the deployed WASM. A local network gets its own token, for example `TEST18` with 18 decimals, from the
same script with `--network local`.

| Code | Error                             | When                                                          |
| ---- | --------------------------------- | ------------------------------------------------------------- |
| 1    | `InvalidDecimals`                 | the constructor was given more than 18 decimals               |
| 2    | `InvalidMintAmount`               | `mint_test` was given zero, a negative amount or over the cap |
| 100  | `InsufficientBalance` (library)   | the holder's balance is lower than the amount                 |
| 101  | `InsufficientAllowance` (library) | the spender's allowance is lower than the amount              |

## `approve-spending-limit/` — `rail402-approve-spending-limit`

An OpenZeppelin smart-account policy (`install`, `enforce`, `uninstall`, plus a read-only `budget`). A payment
that a contract pulls from the account, such as an x402 `upto` settlement, reaches the account's
`__check_auth` as an `approve(from, spender, amount, live_until)` context. OpenZeppelin's stock spending-limit
policy refuses that context; this one counts the approved amount against the same rolling budget as
`transfer(from, to, amount)`.

- Install it on a `CallContract(<token>)` rule with the parameters
  `{spending_limit: i128, period_ledgers: u32, spenders: Vec<Address>}`. Each smart account and rule has its
  own budget. An empty `spenders` list allows any spender; otherwise `approve` may only name a listed one.
- `enforce` requires the smart account's authorization and at least one authenticated signer of the rule.
- It accepts only `transfer` and `approve` whose first argument is the smart account itself. A zero amount
  passes and is not recorded; a negative amount is refused.
- A spend recorded at ledger `L` counts until ledger `L + period_ledgers`. At most 256 spends are kept.
- Each recorded spend publishes a `spend_recorded` event (topic: the smart account); the policy never moves
  tokens.
- For `upto`, the account sees the `approve` of the full cap for every payment, including a zero settlement,
  so a budget reserves the cap, not the amount finally charged.

| Code | Error                   | When                                                               |
| ---- | ----------------------- | ------------------------------------------------------------------ |
| 1    | `NotInstalled`          | no budget for this smart account and rule                          |
| 2    | `AlreadyInstalled`      | a budget already exists for this smart account and rule            |
| 3    | `InvalidParams`         | the limit is not positive, the period is zero, or over 16 spenders |
| 4    | `OnlyCallContract`      | installed on a rule that is not `CallContract`                     |
| 5    | `NoSigner`              | no signer of the rule authenticated                                |
| 6    | `NotAllowed`            | another function, another `from`, or malformed arguments           |
| 7    | `NegativeAmount`        | the amount is negative                                             |
| 8    | `SpendingLimitExceeded` | the amount would take the window's total over the limit            |
| 9    | `SpenderNotAllowed`     | `approve` names a spender outside the allow-list                   |
| 10   | `HistoryFull`           | the window already holds 256 spends                                |

### Rule configuration for an agent key

The signer chooses the rule for each context, so a key that a policy constrains must not appear on any rule
without that policy:

| Rule                    | Signers   | Policy                                                            |
| ----------------------- | --------- | ----------------------------------------------------------------- |
| `Default`               | owner key | none                                                              |
| `CallContract(<token>)` | agent key | `approve-spending-limit`                                          |
| `CallContract(<upto>)`  | agent key | none (`settle` itself moves nothing, so it is not budgeted twice) |

With this configuration the agent signs `upto` payments with the rule ids `[<upto rule>, <token rule>]` for
the contexts `[settle, approve]`.

## `composition/`

Tests that load the OpenZeppelin smart account and ed25519 verifier, the policy and the test token from their
committed wasm fixtures, and compile the `upto` contract from `contracts/stellar/upto`. Every smart-account
authorization, including the owner's rule setup, carries real ed25519 signatures over
`sha256(signature_payload || xdr(rule_ids))`; nothing on that path is mocked. They show that:

- payments within the budget settle, with a Stellar Asset Contract and with the test token, and every payment
  reserves its full cap;
- a payment whose cap exceeds the remaining budget fails in the policy (`SpendingLimitExceeded`), and the
  budget frees up when the window moves on;
- an amount over the cap fails with the upto contract's error #3 before the account is consulted;
- the agent key cannot use the `Default` rule or the policy-free upto rule for `approve`;
- a relayer cannot move a signed payment to another rule, because the signature covers the rule ids;
- a used authorization cannot be replayed.

`src/vectors.rs` replays the test vectors of `@rail402.dev/upto`
(`packages/upto/test/fixtures/upto-stellar-vectors.json`): the terms, the payer's tree, both signature payloads
(legacy and CAP-71 V2), the settle arguments and the authority's entry are byte-identical to the contract's own
encoding, and the vectors' contract-account payer entry settles 300000 once (a second use fails with
`ExistingValue`) and settles zero.

## Tests and builds

```sh
cd contracts/testing/<crate>
cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked
```

The two contracts are built like the `upto` contract (see [`../stellar/README.md`](../stellar/README.md)):
`scripts/contracts/build.sh --contract test-token` or `--contract approve-spending-limit`. Their wasm and
provenance records are committed as `packages/testkit/fixtures/{test_token,approve_spending_limit}.*`.
`scripts/contracts/fixtures.sh` builds the OpenZeppelin smart account and verifier from the pinned commit in
the same image (`--check` compares them with the committed `oz_*.wasm` fixtures, `--update-fixture` refreshes
them). CI runs the Rust checks for every crate and both `--check` builds.
