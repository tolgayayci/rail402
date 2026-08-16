import type { Network } from "@x402/core/types";

/**
 * Canonical `upto` settlement contract per network.
 *
 * ## Reproducible build — check this, do not trust it
 *
 * The deployed wasm is byte-identical to a build of `contracts/upto-stellar` at this commit.
 * Build with `stellar contract build`, NOT plain `cargo build` — the CLI's post-processing
 * (spec-shaking) is part of the deployed bytes, and a bare `cargo build --release --target
 * wasm32v1-none` produces a different hash (`3bdb5072…`) that was never deployed:
 *
 * ```
 * stellar contract build                                # in contracts/upto-stellar
 * stellar contract fetch --id <address> --network testnet --out-file /tmp/deployed.wasm
 * shasum -a 256 target/wasm32v1-none/release/x402_upto_stellar.wasm /tmp/deployed.wasm
 * # both: a19f563e764dfd52a0d229c063e7ac1a1b36f6a976f552a8e19b91ee8e4ef84a
 * ```
 *
 * This build adds the optional settlement hook (`settle`'s 8th argument), so `settle` calls a
 * spending policy's `release` after the transfer to reconcile a smart-account budget down to the
 * actual charge. It supersedes `CBHDZLYADBUEBP3KK4WLPG3TWKSYWQO4MTVKYCRY3Z6WY4QFLNJYBSEU`
 * (wasm `29ed0e90…`), which had no hook.
 *
 * Re-verify after ANY change to the contract source. A source change without a redeploy silently
 * makes every guarantee documented in `contracts/upto-stellar/src/lib.rs` a description of code
 * that is not running — which is exactly what happened when the `expiration_ledger` bound landed
 * and the previous address, `CB3TWFYYDS74WM2N4RKMKUBUREZ6SR5PV3PI3PGO2JEBPJ6A65PSL342`
 * (wasm `abc872c2…`), stayed in this table without it.
 *
 * Clients MUST verify the `extra.uptoContract` a server advertises against this table. The address
 * arrives from the server in the 402 challenge, and a hostile server naming its own contract would
 * be naming its own rules — a contract that ignores the ceiling, or pays itself. Trusting an
 * arbitrary address here would undo every guarantee the scheme provides.
 *
 * Source: `contracts/upto-stellar`, Apache-2.0, built for `wasm32v1-none`.
 */
export const UPTO_CONTRACTS: Readonly<Record<string, string>> = Object.freeze({
  "stellar:testnet": "CCMM3FMGEH7FHRYXZ3WQDQCTIWDXGZBGW7D4UT7NKH34SUQACYC3U54X",
  // Deployed 2026-08-16 from the same source, wasm `a19f563e…` byte-identical to the testnet build
  // (instantiate tx `d0476bae03b8ee50fc75615f1a2b6a77efb9e543d448764b69f038b48ec5d49e`).
  "stellar:pubnet": "CCQ3LI76R3EN7MKC7NQOW744BAJPGXWJNDWNORBX6BVFYZUYXUT2WAZJ",
});

/** The contract's entry point. */
export const SETTLE_FN = "settle";

/**
 * Argument positions in `settle`. The order is a wire contract with the deployed contract; changing
 * it here without redeploying silently corrupts every payment.
 *
 * `settle(token, from, to, max_amount, expiration_ledger, nonce, actual_amount, hook)`
 */
export const ARG = Object.freeze({
  TOKEN: 0,
  FROM: 1,
  TO: 2,
  MAX_AMOUNT: 3,
  EXPIRATION_LEDGER: 4,
  NONCE: 5,
  /**
   * The one argument the client does NOT sign. That is the entire basis of the scheme: the
   * facilitator substitutes the metered amount here at settle time without invalidating the
   * client's signature, because the signed tuple deliberately excludes it.
   */
  ACTUAL_AMOUNT: 6,
  /**
   * Optional settlement hook, a spending policy's `release` entrypoint. Also outside the signed
   * tuple, so the facilitator preserves whatever the client set. The contract calls it after the
   * transfer to report the actual figure, letting a smart-account budget refund the unspent ceiling.
   * `None` for keypair payers, which have no policy to reconcile.
   */
  HOOK: 7,
});

export const SETTLE_ARG_COUNT = 8;

/** Resolve the canonical contract for a network, or undefined if we do not serve it. */
export function uptoContractFor(network: Network): string | undefined {
  return UPTO_CONTRACTS[network];
}
