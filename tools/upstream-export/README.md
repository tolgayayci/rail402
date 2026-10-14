# Upstream export

Exports the Stellar `upto` mechanism and its settlement contract into a checkout of [x402-foundation/x402](https://github.com/x402-foundation/x402), and reports drift between the two.

```sh
pnpm install --dir <x402 checkout>/typescript          # the export is formatted with the checkout's own lint rules
pnpm upstream:export --target <x402 checkout>           # report drift; exit 1 when there is any
pnpm upstream:export --target <x402 checkout> --write   # write the export, then report
```

| This repository                                                                      | x402 checkout                                                                         | How                            |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | ------------------------------ |
| `contracts/stellar/upto/`, `contracts/stellar/deployments/`                          | the same paths                                                                        | byte for byte                  |
| `packages/upto/src/`                                                                 | `typescript/packages/mechanisms/stellar/src/upto/`                                    | imports mapped                 |
| `packages/upto/test/{client-server,codec,facilitator,vectors}.test.ts`, `helpers.ts` | `typescript/packages/mechanisms/stellar/test/unit/upto-*.ts`                          | imports mapped                 |
| `packages/upto/scripts/vectors.ts`, `test/fixtures/upto-stellar-vectors.json`        | `typescript/packages/mechanisms/stellar/test/fixtures/upto-stellar-vectors.{ts,json}` | imports mapped / byte for byte |

Imports move with each file: `@rail402.dev/upto` becomes a relative import of the mechanism's `src/upto`, each name imported from `@x402/stellar` comes from the mechanism module that defines it, and the `.ts` extensions are dropped. The checkout's ESLint then fixes import order and formatting and checks everything else (JSDoc, complexity); a file it still rejects, an import that cannot be mapped, a file of `packages/upto` or `contracts/stellar` that is neither exported nor listed as local, and text that names this repository all stop the export.

The checkout owns everything else: the mechanism's `package.json` exports and tsup entries (checked, never written), its README, the integration test, the changeset, the specification, the contract README, the e2e routes and the examples. Directories that hold only exported files (`src/upto/`, the contract crate and its deployment records) are compared in full, so a file removed here shows up as `extra` there.

Every change to the mechanism or the contract is made here and exported; the checkout is never edited by hand in the exported directories, so `pnpm upstream:export --target <checkout>` without `--write` answering no drift shows the two are in step. The settlement contract is immutable: a change to it is a new crate version deployed under a new salt, with new deployment records and SDK constants on both sides.
