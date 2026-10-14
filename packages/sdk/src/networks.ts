import { PUBNET, TESTNET, isStellarNetwork, type StellarNetwork } from "@rail402.dev/stellar";
import { paymentError } from "./codes.ts";

export type { StellarNetwork };
export { PUBNET, TESTNET };

/** Endpoints a network uses when none are configured. Pubnet has none: every endpoint is explicit. */
export interface NetworkDefaults {
  readonly rpcUrl: string | undefined;
  readonly bazaarUrl: string | undefined;
}

export const NETWORK_DEFAULTS: Readonly<Record<StellarNetwork, NetworkDefaults>> = {
  [TESTNET]: {
    rpcUrl: "https://soroban-testnet.stellar.org",
    bazaarUrl: "https://testnet.rail402.dev",
  },
  [PUBNET]: { rpcUrl: undefined, bazaarUrl: undefined },
};

/**
 * The network a buyer pays on. There is no default: a buyer that silently fell back to one network
 * could pay on the wrong one.
 */
export function requireNetwork(value: unknown): StellarNetwork {
  if (isStellarNetwork(value)) return value;
  throw paymentError("payment_policy_invalid", {
    reason: `network must be "${TESTNET}" or "${PUBNET}"; there is no default network.`,
  });
}
