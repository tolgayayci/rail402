import { STELLAR_PUBNET_CAIP2, STELLAR_TESTNET_CAIP2 } from "@x402/stellar";

/** The x402 scheme name. */
export const UPTO_SCHEME = "upto";

/** The only x402 protocol version this scheme is defined for. */
export const UPTO_X402_VERSION = 2;

/** The settlement contract's entry point. */
export const SETTLE_FUNCTION = "settle";

/** The token function the payer authorizes under `settle`. */
export const APPROVE_FUNCTION = "approve";

/** The function a smart-account payer's delegated signers authorize (see `signerAuthorizations`). */
export const CHECK_AUTH_FUNCTION = "__check_auth";

/** Topic 0 of the event the settlement contract emits once per settlement. */
export const SETTLED_EVENT = "upto_settled";

/** Interface version returned by the contract's `version()`. */
export const UPTO_CONTRACT_VERSION = 1;

/**
 * Salt of the canonical deployment on every network: `sha256("x402-upto-stellar/v1.1")`. A new
 * build of the contract uses a new salt and therefore a new address; `v1` holds the same source
 * built without the SEP-55 `source_repo` metadata.
 */
export const UPTO_DEPLOYMENT_SALT_HEX = "379714072c27ad068d175a4e64017065e569fb9fd33b9c7c8b59428741f7330b";

/** A deployed settlement contract. */
export interface UptoContractDeployment {
  /** Contract address (`C…`). */
  readonly address: string;
  /** Hex sha256 of the installed WASM. */
  readonly wasmHash: string;
}

/**
 * The canonical settlement contract on testnet, deployed from `contracts/stellar/upto` with
 * {@link UPTO_DEPLOYMENT_SALT_HEX}. Its deployment record, with the source commit and every
 * transaction, is `contracts/stellar/deployments/testnet.json`. A local network needs an explicit
 * contract address (`contract` / `contracts` options).
 */
export const UPTO_TESTNET_DEPLOYMENT: UptoContractDeployment = Object.freeze({
  address: "CBTVKCHLSGQ3WSV3NKSU6FZR4FZMC6ENMDMXUS5XQ66HYVUUHYE3TU7U",
  wasmHash: "cc2d2fefe77d1a470abe88be8563679a9d40f49c127683947784c0cb2d0ca797",
});

/** Canonical deployments by CAIP-2 network. Pubnet is reserved until the contract is deployed there. */
export const UPTO_DEPLOYMENTS: Readonly<Record<string, UptoContractDeployment | undefined>> = Object.freeze({
  [STELLAR_TESTNET_CAIP2]: UPTO_TESTNET_DEPLOYMENT,
  [STELLAR_PUBNET_CAIP2]: undefined,
});

/** Settlement contract errors (`Error(Contract, #n)` raised by the settlement contract). */
export const UptoContractError = Object.freeze({
  InvalidMaxAmount: 1,
  NegativeAmount: 2,
  AmountExceedsMax: 3,
  NotYetValid: 4,
  Expired: 5,
  InvalidRecipient: 6,
} as const);

/** Largest value of a Soroban `i128`. */
export const I128_MAX = (1n << 127n) - 1n;

/** Upper bound on the base64 length of each authorization entry in a payload. */
export const MAX_AUTHORIZATION_BASE64_LENGTH = 8 * 1024;

/** Upper bound on the number of `signerAuthorizations` in a payload. */
export const MAX_SIGNER_AUTHORIZATIONS = 4;

/**
 * Ledgers of slack when checking the authorization's expiration against the facilitator's own
 * estimate of `maxTimeoutSeconds`, matching the `exact` scheme's tolerance for clock and RPC skew.
 */
export const EXPIRATION_LEDGER_TOLERANCE = 2;

/**
 * The nominal ledger close time of the public Stellar networks, in seconds. The facilitator's upper
 * bound on the expiration ledger never assumes slower ledgers than this, because a client that
 * estimated the nominal time signs a later expiration than one that estimated a slower one.
 */
export const NOMINAL_LEDGER_SECONDS = 5;

/**
 * Minimum ledgers between the current ledger and the authorization's expiration for a payment to
 * be accepted, so that a settlement submitted now can still be included before it expires.
 */
export const DEFAULT_EXPIRATION_MARGIN_LEDGERS = 2;

/** Largest `maxTimeoutSeconds` accepted by default. */
export const DEFAULT_MAX_TIMEOUT_SECONDS = 300;

/**
 * Default ceiling on the settlement transaction's fee (inclusion fee plus simulated resource fee),
 * in stroops. With current testnet fee settings a settlement from a `G…` payer simulates to about
 * 175,000 stroops through a Stellar Asset Contract to an existing trustline, and to about 385,000
 * stroops through a contract token whose recipient has no balance entry yet (the new entry's rent
 * is part of the fee). Smart-account payers cost more.
 */
export const DEFAULT_MAX_TRANSACTION_FEE_STROOPS = 500_000;
