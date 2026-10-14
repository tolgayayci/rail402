/**
 * The signer tap: wraps the wallet's key so the page can show what was authorized. The SDK's signing
 * guard wraps the tap, so the tap only ever sees preimages the guard approved for the call in progress;
 * after the key signed, it decodes the preimage into public facts (the call, its terms, the nonce and
 * the expiry) and reports them. The preimage and the signature themselves are never reported.
 */
import type { Sep43AuthSigner } from "@rail402.dev/sdk/browser";
import { authorizationView } from "../engine/decode.ts";
import type { AuthorizationView } from "../engine/events.ts";

export interface SignerTapOptions {
  readonly network: string;
  /** Settlement contracts whose authorizations decode as upto terms. */
  readonly uptoContracts: readonly string[];
  /** The latest ledger the page knows, read without waiting. */
  readonly latestLedger: () => number | null;
  readonly onAuthorization: (view: AuthorizationView) => void;
}

export function tapSigner(key: Sep43AuthSigner, options: SignerTapOptions): Sep43AuthSigner {
  return {
    address: key.address,
    signAuthEntry: async (authEntry, opts) => {
      const signed = await key.signAuthEntry(authEntry, opts);
      if (signed.error === undefined) {
        const view = authorizationView(authEntry, {
          address: key.address,
          network: options.network,
          uptoContracts: options.uptoContracts,
          latestLedger: options.latestLedger(),
        });
        if (view !== undefined) {
          try {
            options.onAuthorization(view);
          } catch {
            // Observers never break a signature.
          }
        }
      }
      return signed;
    },
  };
}
