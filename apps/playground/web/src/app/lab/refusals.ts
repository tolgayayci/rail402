/**
 * The refusals a visitor can try from the Lab. Before signing: the buyer's refusal checks, each of
 * which must end refused with its code while nothing is signed. After signing: the same payment sent
 * twice, and a seller that asks to settle more than the signed cap.
 */
import {
  CHECK_EXPECTED_CODES,
  OVERCHARGE_REFUSAL_CODE,
  PRIVATE_ADDRESS_TARGETS,
  REPLAY_REFUSAL_CODE,
  SCENARIO_DEFAULTS,
  SESSION_CHECK_WINDOW,
  type CheckId,
  type ExperimentId,
} from "../../../../src/shared/lab.ts";
import type { PublicConfig } from "../../engine/types.ts";
import { displayUrl } from "../../projection/format.ts";
import { defaultTarget } from "../../projection/targets.ts";

export type RefusalId =
  | { readonly kind: "check"; readonly id: CheckId }
  | { readonly kind: "experiment"; readonly id: Extract<ExperimentId, "replay" | "overcharge"> };

export interface RefusalEntry {
  readonly refusal: RefusalId;
  /** The value of the `try` query parameter that selects it. */
  readonly key: string;
  readonly title: string;
  readonly how: string;
  /** The code the run is expected to end with. */
  readonly expects: string;
}

const BEFORE: readonly { readonly id: CheckId; readonly title: string; readonly how: string }[] = [
  { id: "per-call-cap", title: "Cap below the price", how: "The weather API, with a cap under its price." },
  { id: "network", title: "Another network", how: "A 402 that asks to be paid on stellar:pubnet." },
  { id: "asset", title: "Unknown asset", how: "A 402 priced in an asset your policy does not list." },
  { id: "amount", title: "Zero amount", how: "A 402 that asks for an amount of 0." },
  {
    id: "recipient",
    title: "Recipient not allowed",
    how: "The weather API, with its seller on your deny list.",
  },
  {
    id: "session-budget",
    title: "Session budget used up",
    how: `Pays ${SESSION_CHECK_WINDOW.total} once from a budget with room for one payment; the second must be refused.`,
  },
  {
    id: "private-address",
    title: "Private address",
    how: "Asks the relay for a loopback and a cloud-metadata address.",
  },
];

/** The refusal checks this Playground runs, in the order the menu lists them. */
export function refusalsBeforeSigning(config: PublicConfig): readonly RefusalEntry[] {
  return BEFORE.filter((entry) => config.lab.checks.includes(entry.id)).map((entry) => ({
    refusal: { kind: "check", id: entry.id },
    key: entry.id,
    title: entry.title,
    how: entry.how,
    expects: CHECK_EXPECTED_CODES[entry.id],
  }));
}

/** The refusals after signing this Playground runs. */
export function refusalsAfterSigning(config: PublicConfig): readonly RefusalEntry[] {
  const entries: RefusalEntry[] = [];
  if (config.lab.experiments.includes("replay") && config.lab.scenarios.includes("pay")) {
    entries.push({
      refusal: { kind: "experiment", id: "replay" },
      key: "replay",
      title: "Send it twice",
      how: "Pays the weather API, then sends the same signed payment again.",
      expects: REPLAY_REFUSAL_CODE,
    });
  }
  if (config.lab.experiments.includes("overcharge") && config.lab.scenarios.includes("upto")) {
    entries.push({
      refusal: { kind: "experiment", id: "overcharge" },
      key: "overcharge",
      title: "Seller charges over the cap",
      how: "An upto seller asks Rail402 to settle twice what you signed for.",
      expects: OVERCHARGE_REFUSAL_CODE,
    });
  }
  return entries;
}

/** The refusal a `try` query value names, when this Playground offers it. */
export function refusalFor(key: string | null, config: PublicConfig): RefusalEntry | undefined {
  if (key === null) return undefined;
  return [...refusalsBeforeSigning(config), ...refusalsAfterSigning(config)].find(
    (entry) => entry.key === key,
  );
}

/**
 * What a refusal calls, for the stage's request bar: the weather API, a lab offer, the greedy seller,
 * or the private addresses the relay must not reach.
 */
export function refusalTarget(
  entry: RefusalEntry,
  config: PublicConfig,
): { readonly url?: string; readonly text: string } {
  const { refusal } = entry;
  const lab = (path: string, query: Readonly<Record<string, string>> = {}): string => {
    const url = new URL(path, config.urls.public);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    return url.href;
  };
  let url: string | undefined;
  if (refusal.kind === "experiment") {
    url =
      refusal.id === "replay"
        ? defaultTarget("exact", config)
        : lab(config.lab.paths.greedy, SCENARIO_DEFAULTS.upto.query);
  } else {
    switch (refusal.id) {
      case "network":
        url = lab(config.lab.paths.offers.pubnet);
        break;
      case "asset":
        url = lab(config.lab.paths.offers.asset);
        break;
      case "amount":
        url = lab(config.lab.paths.offers.zero);
        break;
      case "private-address":
        return { text: PRIVATE_ADDRESS_TARGETS.map((target) => displayUrl(target)).join(" · ") };
      case "per-call-cap":
      case "recipient":
      case "session-budget":
        url = defaultTarget("exact", config);
        break;
    }
  }
  return { url, text: displayUrl(url) };
}
