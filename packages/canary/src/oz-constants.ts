/**
 * Deployed OpenZeppelin smart-account pieces, and the x402 policy that runs on them.
 *
 * The account wasm and the verifier are OpenZeppelin's, audited and shared: one deployment serves
 * every account, which is what makes per-user smart accounts affordable. Only the policy is ours,
 * and it carries budget arithmetic with no cryptography in it.
 *
 * Reproduce:
 * ```
 * cd <stellar-contracts>              && stellar contract build   # OZ account + verifier
 * cd contracts/agent-policy           && stellar contract build   # ours
 * ```
 * Re-verify after ANY policy source change and redeploy if the hash moves — a source change
 * without a redeploy silently turns every documented guarantee into a description of code that is
 * not running.
 */

/** OpenZeppelin `multisig_account_example`, uploaded to testnet. */
export const OZ_ACCOUNT_WASM_HASH =
  "c09cac4623692cd62f700c5703f5cf48988bdff74074baa702e0fc7e3355b24f";

/** OpenZeppelin ed25519 verifier. Stateless, immutable, shared by every account. */
export const OZ_ED25519_VERIFIER = "CCC4DCEZYW2GLEF2JCASZASC34AH4VHR2KISPODRQDC6D37SBRFSLEWP";

/**
 * Our x402 spending policy, wasm sha256
 * `6d9307303a7f11e14b98530688e1cccb259fc35c537b71561429e77bc4aaa232`. Carries the `release`
 * entrypoint that reconciles a committed ceiling down to the actual settled amount, AND (as of this
 * build) refreshes each persistent entry's TTL on write, so an active account's budget or a pending
 * reservation is never archived out from under it (S6). Deployed testnet tx
 * `b122fcede162ca4acf154ad0db68a1a78d390253311dd722cccfd4c4c3ba0f02`. Supersedes `CC34LRGI…` (wasm
 * `041d8c79…`), which had the `release` hook but no TTL refresh.
 */
export const X402_POLICY = "CC3XJMYTTLQNDHOQHNQPQWLRIABQDUQBNJQKED7D67A3RMLGVQHF7LEC";

/**
 * The `upto` settlement contract on testnet, mirrored here to keep the canary dependency-free. This
 * build (wasm `a19f563e…`) carries the settlement hook that calls the policy's `release` after a
 * transfer.
 */
export const UPTO_CONTRACT = "CCMM3FMGEH7FHRYXZ3WQDQCTIWDXGZBGW7D4UT7NKH34SUQACYC3U54X";
