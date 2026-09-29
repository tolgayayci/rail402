import { MuxedAccount, StrKey } from "@stellar/stellar-sdk";
import {
  STELLAR_NETWORK_TO_PASSPHRASE,
  STELLAR_PUBNET_CAIP2,
  STELLAR_TESTNET_CAIP2,
  USDC_PUBNET_ADDRESS,
  USDC_TESTNET_ADDRESS,
} from "@x402/stellar";

/** CAIP-2 identifiers for the Stellar networks x402 defines. Taken from @x402/stellar, never redefined. */
export const TESTNET = STELLAR_TESTNET_CAIP2;
export const PUBNET = STELLAR_PUBNET_CAIP2;

export type StellarNetwork = typeof TESTNET | typeof PUBNET;

export const STELLAR_NETWORKS: readonly StellarNetwork[] = [TESTNET, PUBNET];

export function isStellarNetwork(value: unknown): value is StellarNetwork {
  return value === TESTNET || value === PUBNET;
}

export function networkPassphrase(network: StellarNetwork): string {
  const passphrase = STELLAR_NETWORK_TO_PASSPHRASE.get(network);
  if (passphrase === undefined) throw new Error(`no passphrase for ${network}`);
  return passphrase;
}

/** A SEP-41 token identified by its contract address. */
export interface TokenInfo {
  readonly contract: string;
  readonly symbol: string;
  readonly decimals: number;
}

/** Circle USDC as a Stellar Asset Contract. Both networks use 7 decimals. */
export const USDC: Readonly<Record<StellarNetwork, TokenInfo>> = {
  [TESTNET]: { contract: USDC_TESTNET_ADDRESS, symbol: "USDC", decimals: 7 },
  [PUBNET]: { contract: USDC_PUBNET_ADDRESS, symbol: "USDC", decimals: 7 },
};

/** Stellar's historical ledger close target, used only when no live estimate is available. */
export const DEFAULT_LEDGER_SECONDS = 5;

/** Matches a G… account, C… contract or M… muxed account strkey. */
export const DESTINATION_ADDRESS = /^(?:[GC][A-D][A-Z2-7]{54}|M[A-D][A-Z2-7]{67})$/;
/** The G… or C… account behind a Stellar address; the base account of an M… muxed address. */
export function baseAccount(address: string): string | undefined {
  if (StrKey.isValidEd25519PublicKey(address) || StrKey.isValidContract(address)) return address;
  if (StrKey.isValidMed25519PublicKey(address)) {
    try {
      return MuxedAccount.fromAddress(address, "0").baseAccount().accountId();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Matches a C… contract strkey, the only valid form of an x402 Stellar asset. */
export const CONTRACT_ADDRESS = /^C[A-D][A-Z2-7]{54}$/;
