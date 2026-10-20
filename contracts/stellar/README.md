# Stellar contracts

## `upto/` — x402 `upto` settlement contract

`x402-upto-stellar` settles payments of the x402 `upto` scheme on Stellar: the payer authorizes a cap, and the
settlement authority (the facilitator) later charges any amount from 0 up to that cap. It is written against
`soroban-sdk` 28.0.0 and has no admin, no upgrade path, no storage and no constructor.

### Interface

```rust
fn settle(env: Env, payer: Address, terms: UptoTerms, amount: i128) -> Result<i128, UptoError>;
fn version(env: Env) -> u32; // 1

struct UptoTerms {            // an ScMap on the wire, keys in this order
    expiration_ledger: u32,   // last ledger (inclusive) at which the terms can be settled
    facilitator: Address,     // the only address that can choose the amount
    max_amount: i128,         // cap in atomic units of `token`, > 0
    recipient: Address,       // G… account or C… contract
    token: Address,           // SEP-41 token contract
    valid_after_ledger: u32,  // first ledger at which the terms can be settled
}
```

`settle` returns the settled amount and emits one `upto_settled` event (topics: `"upto_settled"`, payer,
recipient; data: `token`, `amount`, `max_amount`, `facilitator`), also for a zero amount.

### Authorization

The payer signs one Soroban authorization entry whose tree is exactly:

```text
settle(terms)                                               on the settlement contract
└── approve(payer, <settlement contract>, max_amount, expiration_ledger)   on terms.token
```

The amount is not part of the payer's signature. Instead `terms.facilitator` must authorize
`settle(payer, terms, amount)`, so only the settlement authority the payer named can choose the amount, and it can
choose only a value in `0..=max_amount`. For a positive amount the contract then calls the signed `approve`
and pulls the amount with `transfer_from`, which the token authorizes because the contract is the direct
invoker. A zero amount makes no token calls.

Single use comes from the payer's authorization nonce, which the Soroban host consumes when the entry is used and
keeps until the signature expires. A failed settlement rolls back everything, nonce included. The allowance that
a partial settlement leaves (at most `max_amount − amount`) expires at `expiration_ledger`, can only be spent by
the settlement contract itself, and is overwritten by the next settlement's `approve` before anything is spent.

### Errors

| Code | Name               | When                                              |
| ---- | ------------------ | ------------------------------------------------- |
| 1    | `InvalidMaxAmount` | `max_amount` is zero or negative                  |
| 2    | `NegativeAmount`   | `amount` is negative                              |
| 3    | `AmountExceedsMax` | `amount` is larger than `max_amount`              |
| 4    | `NotYetValid`      | the current ledger is before `valid_after_ledger` |
| 5    | `Expired`          | the current ledger is after `expiration_ledger`   |
| 6    | `InvalidRecipient` | `recipient` is the settlement contract itself     |

Authorization failures surface as host errors: `Error(Auth, InvalidAction)` when an authorization is missing or
does not match, `Error(Auth, ExistingValue)` when the payer's entry was already used.

### Deployments

| Network           | Contract                                                   | WASM sha256                                                        | Record                                                 |
| ----------------- | ---------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------ |
| `stellar:testnet` | `CBTVKCHLSGQ3WSV3NKSU6FZR4FZMC6ENMDMXUS5XQ66HYVUUHYE3TU7U` | `cc2d2fefe77d1a470abe88be8563679a9d40f49c127683947784c0cb2d0ca797` | [`deployments/testnet.json`](deployments/testnet.json) |

[View the testnet contract on stellar.expert](https://stellar.expert/explorer/testnet/contract/CBTVKCHLSGQ3WSV3NKSU6FZR4FZMC6ENMDMXUS5XQ66HYVUUHYE3TU7U).
`@rail402.dev/upto` uses this deployment on `stellar:testnet` unless a contract is configured
(`UPTO_TESTNET_DEPLOYMENT`). There is no pubnet deployment.

The deployment record holds the source commit, the WASM and source-archive hashes, the build image, options and
CLI, the deployer, the salt, the hash and ledger of every deployment transaction (upload, deploy, both TTL
extensions), the ledgers until which the instance and the code live, the CLI version that sent them, and under
`previous` the deployment it replaced: its address, WASM hash, source commit, salt and deploy transaction, and a
note on how it was built.

The address depends only on the network, the deployer and the salt `sha256("x402-upto-stellar/v1.1")`
(`37971407…f7330b`), so it can be computed before anything is sent, and only the deployer can create a contract
there. The contract has no admin and cannot be upgraded, so the deployer holds no privilege over it
afterwards. It replaces `CCNU3CYA…AYPB` (salt `sha256("x402-upto-stellar/v1")`), which runs the same source
built with the SEP-58 recipe of the test contracts (no `--optimize`, no SEP-55 `source_repo` metadata) and stays
on chain unchanged. `verify.sh --contract upto --recipe sep58 --rev <commit> --wasm <file>` rebuilds it from the
commit its record names.

### Verifying a deployment

```sh
scripts/contracts/verify.sh --network testnet
```

This rebuilds the recorded commit from a clean export (see [Reproducible build](#reproducible-build)), checks
the source archive and the result against the recorded hashes, downloads the WASM that the deployed instance
runs (`stellar contract fetch`) and checks it too, and prints the embedded metadata, `source_repo` included.
Only Docker, git, jq and curl are needed.

### Source verification on stellar.expert

stellar.expert links a contract to its source ([SEP-55](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0055.md))
only for WASM that its own release workflow,
[`stellar-expert/soroban-build-workflow`](https://github.com/stellar-expert/soroban-build-workflow), built. Pushing
a tag `upto-contract-v<crate version>` (for this crate `upto-contract-v1.0.0`) runs
[`.github/workflows/contract-release.yml`](../../.github/workflows/contract-release.yml):

1. `check` refuses the release unless stellar.expert's workflow is still at the reviewed revision, the tag names
   the crate version, and `build.sh --contract upto --check` reproduces the WASM that `deployments/testnet.json`
   names.
2. `release` calls stellar.expert's workflow for `contracts/stellar/upto`. It builds the contract with
   `stellar contract build --optimize --meta source_repo=github:<repository>`, publishes the WASM as a GitHub
   release, attests it with GitHub build provenance and sends stellar.expert the validation request.
3. `confirm` downloads the released WASM, requires it to be the deployed one, and verifies its attestation
   (`gh attestation verify <wasm> --repo tolgayayci/rail402 --signer-repo stellar-expert/soroban-build-workflow`).

stellar.expert shows the repository and commit on the contract's page once it has processed the request. The
testnet contract was verified this way by the `upto-contract-v1.0.0` release, built from commit `77a4ddb`. A tag `upto-contract-v1.0.0-<n>` releases the same
version again: a new release and attestation of the same bytes, and a new validation request.

### Deploying

```sh
scripts/contracts/deploy.sh --network testnet --deployer-secret-file <file> [--fund]
```

`deploy.sh` deploys the committed fixture with the pinned image's CLI. It prints the address it will create,
uploads the WASM unchanged, deploys it with the salt, extends the instance and the code to the network's
maximum TTL, checks that the deployed instance runs the fixture, and writes
`deployments/<network>.json`, keeping the record it replaces under `previous`. It refuses to run when the crate
or its fixture has uncommitted changes, so the recorded commit always holds the deployed source. `--network local` deploys to a local network and writes the
record under `target/`. The secret is read from a file and passed to the CLI through its environment.
Keep the deployer's secret: after a testnet reset, the same address can only be recreated with it.

### Contract TTL

The contract never extends its own instance or code. Since protocol 23 an invocation that touches an archived
instance restores it automatically and pays for the restoration in the same transaction, so whoever operates
the contract should keep both entries live and restore them explicitly if they were archived. Anyone may
extend or restore them; the operations need no authorization from the contract.

```sh
# Extend the instance and the code (any funded account can send these).
stellar contract extend --id <contract> --durability persistent --ledgers-to-extend 3110399 --network testnet --source <account>
stellar contract extend --wasm-hash <wasm sha256> --ledgers-to-extend 3110399 --network testnet --source <account>
# After archival: restore both entries, then extend them as above.
stellar contract restore --id <contract> --durability persistent --network testnet --source <account>
stellar contract restore --wasm-hash <wasm sha256> --network testnet --source <account>
```

`3110399` is the largest extension testnet accepts today (`max_entry_ttl − 1`). The deployment record's
`live_until_ledger` shows where the entries stood right after deployment.

### Tests

```sh
cd contracts/stellar/upto
cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked
```

The tests cover partial, maximum and zero settlements with balance, event and authorization-tree checks; every
error including both inclusive ledger bounds; the facilitator binding (missing, different amount, different
submitter, different operation source); mutated terms and approve arguments; real ed25519 signatures through a
contract account with V1 and V2 credentials, replay, expiry and a `SOURCE_ACCOUNT` authority; the residual
allowance; the absence of contract storage; and a resource-cost snapshot.

The crate, its tests included, is frozen byte for byte: the deployment record names the SHA-256 of the crate's
source archive, which covers every file in `upto/`, so changing even a test would no longer match the deployed
contract's record and would require a new deployment under a new salt. New tests of the deployed contract go in a separate crate that depends on it by path, like
[`../testing/composition`](../testing/README.md).

### Reproducible build

The crate directory `upto/` is the complete build input: `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`,
`.gitignore` and `src/`. Nothing that records a build result lives inside it.

```sh
scripts/contracts/build.sh --contract upto                   # build the working tree into target/contracts/upto/
scripts/contracts/build.sh --contract upto --check           # rebuild and compare with the committed wasm
scripts/contracts/build.sh --contract upto --update-fixture  # refresh packages/testkit/fixtures/x402_upto_stellar.*
scripts/contracts/verify.sh --wasm <file>                    # rebuild HEAD (or --rev <rev>) and compare with a wasm file
scripts/contracts/verify.sh --wasm <file> --recipe sep58     # the same with the test contracts' SEP-58 recipe
```

`build.sh` builds the contract exactly as stellar.expert's release workflow does:

1. `stellar contract build --locked --optimize --package x402-upto-stellar --meta source_repo=github:tolgayayci/rail402`,
   where `--optimize` and the `source_repo` metadata are what the release workflow passes and `--locked` only
   refuses a stale lockfile.
2. `stellar` is the official 28.1.0 release binary for linux x86_64, the version the release workflow installs;
   the archive is downloaded once into `target/` and its SHA-256 is checked (`scripts/contracts/common.sh`).
3. It runs on Rust 1.98.0, the toolchain `rust-toolchain.toml` pins, inside
   `docker.io/stellar/stellar-cli:28.0.0-rust1.98.0-slim-trixie-amd64-0@sha256:3901802e…` (a single-architecture
   digest; the full reference is in `scripts/contracts/common.sh`).

The result does not depend on the host path, the host user or the host toolchain: the CLI maps the cargo
registry path out of the build, and the crate's own paths never reach the wasm. `build.sh` also records the
SHA-256 of the crate's source archive (fixed order, timestamps and ownership), which `verify.sh` checks against the
deployment record. `stellar contract info meta --wasm <file>` shows the embedded metadata (`rsver`, `rssdkver`,
`cliver`, `source_repo`). Every run asks for the image's `linux/amd64` platform, so an arm64 host runs it under
emulation: slower, with the same bytes.

Without `--contract`, `build.sh` builds every contract in this repository, including the test contracts in
[`../testing/`](../testing/README.md). CI runs the Rust checks and `build.sh --check` on every change. The committed wasm and its provenance record
are `packages/testkit/fixtures/x402_upto_stellar.wasm` and `x402_upto_stellar.provenance.json`.
