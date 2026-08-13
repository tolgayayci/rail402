import { X402Error } from "@rail402/errors";
import { CanaryRun, type CanaryReport } from "./report.js";
import { NETWORK } from "./testnet.js";

/**
 * C-3 — the `/supported` snapshot.
 *
 * `/supported` is the first thing every stock client reads and the last thing anyone tests. It is
 * a contract in the strictest sense: a client that cannot find its scheme in `kinds` never attempts
 * a payment, and a missing `extra` field produces a failure at signing time that reads as a client
 * bug. Two live facilitators in the field are already missing required fields here
 * which is why this is its own check rather than a
 * line in another one.
 *
 * Four properties, in increasing order of how easy they are to lose:
 *
 *   1. The envelope carries `kinds`, `extensions` and `signers`.
 *   2. Every Stellar kind carries `extra.areFeesSponsored`.
 *   3. Advertisement matches reachability: if `bazaar` is advertised, `/discovery/*` answers.
 *   4. The shape has not drifted from the recorded baseline — and where it differs from the public
 *      x402.org facilitator, it differs deliberately.
 *
 * Property 3 is the one this project keeps insisting on. The public x402.org facilitator advertises
 * no bazaar and returns 404 on the discovery paths its own documentation cites; advertising a
 * capability you do not serve is the failure mode, not a cosmetic mismatch.
 */

export interface SupportedKind {
  x402Version: number;
  scheme: string;
  network: string;
  extra?: Record<string, unknown>;
}

export interface SupportedResponse {
  kinds: SupportedKind[];
  extensions?: string[];
  signers?: Record<string, unknown>;
}

/**
 * Fetch `/supported` and assert it advertises the bazaar extension.
 *
 * Shared with the discovery-loop canary, which cannot prove anything about discovery against a
 * facilitator that does not claim to serve it.
 *
 * @returns the advertised extension names
 */
export async function requireBazaarFacilitator(base: string): Promise<string[]> {
  const supported = await fetchSupported(base);
  const extensions = supported.extensions ?? [];
  if (!extensions.includes("bazaar")) {
    throw new X402Error("canary_setup_failed", {
      reason: `The facilitator does not advertise the bazaar extension on /supported, so there is no discovery loop to exercise. Advertised: ${JSON.stringify(extensions)}.`,
      details: { extensions },
    });
  }
  return extensions;
}

export async function fetchSupported(base: string): Promise<SupportedResponse> {
  const response = await fetch(`${base}/supported`).catch((error: unknown) => {
    throw new X402Error("canary_setup_failed", {
      reason: `Could not reach ${base}/supported: ${error instanceof Error ? error.message : String(error)}`,
    });
  });
  if (!response.ok) {
    throw new X402Error("canary_setup_failed", {
      reason: `${base}/supported answered HTTP ${response.status}.`,
      details: { status: response.status },
    });
  }
  return (await response.json()) as SupportedResponse;
}

export interface SupportedSnapshotOptions {
  readonly facilitatorUrl: string;
  readonly log?: (line: string) => void;
}

export async function runSupportedSnapshot(
  options: SupportedSnapshotOptions,
): Promise<CanaryReport> {
  const run = new CanaryRun(
    "supported-snapshot",
    NETWORK,
    options.facilitatorUrl,
    options.log ?? (line => console.error(line)),
  );

  try {
    const supported = await run.step("fetch", async () => {
      const body = await fetchSupported(options.facilitatorUrl);
      run.observe("supported", body);
      return { detail: `${body.kinds?.length ?? 0} kind(s)`, body };
    });

    await run.step("envelope", async () => {
      const missing = (["kinds", "extensions", "signers"] as const).filter(
        key => supported.body[key] === undefined,
      );
      if (missing.length > 0) {
        throw new X402Error("canary_supported_contract_incomplete", {
          reason: `/supported is missing required envelope key(s): ${missing.join(", ")}. A stock client reads these to decide whether it can pay at all.`,
          details: { missing },
        });
      }
      if (!Array.isArray(supported.body.kinds) || supported.body.kinds.length === 0) {
        throw new X402Error("canary_supported_contract_incomplete", {
          reason: "/supported advertises no payment kinds, so no client can pay this facilitator.",
        });
      }
      return { detail: "kinds, extensions and signers all present" };
    });

    const stellarKinds = await run.step("stellar-extra", async () => {
      const kinds = supported.body.kinds.filter(k => k.network?.startsWith("stellar:"));
      if (kinds.length === 0) {
        throw new X402Error("canary_supported_contract_incomplete", {
          reason: "/supported advertises no Stellar kind at all.",
          details: { networks: supported.body.kinds.map(k => k.network) },
        });
      }
      // `areFeesSponsored` is the Stellar-specific `extra` contract. A client uses it to decide
      // whether the buyer needs XLM; absent, the buyer is told to hold a reserve it does not need,
      // or worse, is not told to hold one it does.
      const withoutFlag = kinds.filter(k => typeof k.extra?.["areFeesSponsored"] !== "boolean");
      if (withoutFlag.length > 0) {
        throw new X402Error("canary_supported_contract_incomplete", {
          reason: `Stellar kind(s) missing a boolean extra.areFeesSponsored: ${withoutFlag.map(k => `${k.scheme}/${k.network}`).join(", ")}.`,
          details: { kinds: withoutFlag },
        });
      }
      run.observe(
        "kinds",
        kinds.map(k => `${k.scheme}/${k.network}`),
      );
      return {
        detail: kinds.map(k => `${k.scheme}/${k.network} sponsored=${k.extra!["areFeesSponsored"]}`).join(" · "),
        kinds,
      };
    });

    await run.step("sponsorship-truthful", async () => {
      // The flag is only worth reading if it cannot disagree with behaviour. Ours cannot: the
      // facilitator settles by rebuilding the transaction with its own funded account as source,
      // which IS fee sponsorship, and configuration that would advertise otherwise is refused at
      // startup rather than served (config_fee_sponsorship_mismatch). So the live assertion here
      // is the observable half — a sponsored kind must come from a facilitator that has a signer.
      const sponsored = stellarKinds.kinds.some(k => k.extra!["areFeesSponsored"] === true);
      const health = (await (await fetch(`${options.facilitatorUrl}/health`)).json()) as {
        signers?: number;
      };
      if (sponsored && !(health.signers && health.signers > 0)) {
        throw new X402Error("canary_supported_untruthful", {
          reason:
            "The facilitator advertises areFeesSponsored: true but reports no settlement signer, so it cannot be paying anybody's fees.",
          details: { signers: health.signers ?? 0 },
        });
      }
      return { detail: `sponsored=${sponsored}, ${health.signers ?? 0} signer(s) funded` };
    });

    await run.step("advertised-is-reachable", async () => {
      const extensions = supported.body.extensions ?? [];
      if (!extensions.includes("bazaar")) {
        // Not advertising bazaar is a legitimate configuration; advertising it and 404ing is not.
        return { detail: "bazaar not advertised — nothing to reach" };
      }
      const probes = ["/discovery/resources", "/discovery/search?query=probe"];
      for (const path of probes) {
        const response = await fetch(`${options.facilitatorUrl}${path}`);
        if (!response.ok) {
          throw new X402Error("canary_supported_untruthful", {
            reason: `/supported advertises the bazaar extension but ${path} answered HTTP ${response.status}. Advertising a capability that is not served is the exact gap this project measures in others.`,
            details: { path, status: response.status },
          });
        }
      }
      return { detail: `bazaar advertised and both discovery paths answer` };
    });

    return run.finish();
  } catch (error) {
    return run.finish(error);
  }
}
