import { PUBNET, type StellarNetwork } from "@rail402.dev/stellar";
import { paymentError } from "./codes.ts";

/**
 * Where transaction links point. `stellar.expert` is the default; a template is any https URL with a
 * `{hash}` placeholder and an optional `{network}` placeholder (`testnet` or `public`).
 */
export type ExplorerProvider = "stellar.expert" | { readonly template: string };

const HASH = /^[0-9a-f]{64}$/;

export function explorerUrl(
  network: StellarNetwork,
  hash: string,
  provider: ExplorerProvider = "stellar.expert",
): string {
  const normalized = hash.toLowerCase();
  if (!HASH.test(normalized)) throw paymentError("transaction_hash_invalid");
  const segment = network === PUBNET ? "public" : "testnet";
  if (provider === "stellar.expert") return `https://stellar.expert/explorer/${segment}/tx/${normalized}`;
  return provider.template.replaceAll("{network}", segment).replaceAll("{hash}", normalized);
}

/** Validates an explorer link template. */
export function explorerTemplate(template: string): ExplorerProvider {
  const sample = template.replaceAll("{network}", "testnet").replaceAll("{hash}", "0".repeat(64));
  if (!template.includes("{hash}") || !URL.canParse(sample) || new URL(sample).protocol !== "https:") {
    throw paymentError("payment_policy_invalid", {
      reason: "An explorer template must be an https URL containing {hash}.",
    });
  }
  return { template };
}
