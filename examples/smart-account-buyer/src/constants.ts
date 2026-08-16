/**
 * Deployed OpenZeppelin smart-account pieces on Stellar testnet, and the x402 spending policy
 * that runs on them.
 *
 * The account wasm and the verifier are OpenZeppelin's: audited, immutable, and shared, so one
 * deployment serves every account. Only the policy is Rail402's, and it carries budget arithmetic
 * with no cryptography in it. These are the same addresses the `oz-account` canary settles against.
 */

/** OpenZeppelin `multisig_account_example`, uploaded to testnet. */
export const OZ_ACCOUNT_WASM_HASH =
  "c09cac4623692cd62f700c5703f5cf48988bdff74074baa702e0fc7e3355b24f";

/** OpenZeppelin ed25519 verifier. Stateless, immutable, shared by every account. */
export const OZ_ED25519_VERIFIER = "CCC4DCEZYW2GLEF2JCASZASC34AH4VHR2KISPODRQDC6D37SBRFSLEWP";

/** Rail402's x402-aware spending policy. Refuses a payment that exceeds the account's budget. */
export const X402_POLICY = "CC3XJMYTTLQNDHOQHNQPQWLRIABQDUQBNJQKED7D67A3RMLGVQHF7LEC";

/** The `upto` settlement contract on testnet. */
export const UPTO_CONTRACT = "CCMM3FMGEH7FHRYXZ3WQDQCTIWDXGZBGW7D4UT7NKH34SUQACYC3U54X";

export const NETWORK = "stellar:testnet";
export const RPC_URL = "https://soroban-testnet.stellar.org";
export const HORIZON_URL = "https://horizon-testnet.stellar.org";
