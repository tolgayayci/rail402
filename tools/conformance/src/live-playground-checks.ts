/**
 * What a live-playground evidence document must contain beyond the common schema, shared by the run
 * and its tests.
 */
import type { Evidence, EvidenceCase } from "./evidence.ts";

/** Cases every run has; each must pass, or be skipped with a reason. */
export const PLAYGROUND_CASES = [
  "onboarding",
  "pay-exact",
  "cap-below-price",
  "replay",
  "pay-upto",
  "overcharge",
  "agent-mcp",
  "sell-listed",
  "refusal-network",
  "refusal-asset",
  "refusal-amount",
  "refusal-recipient",
  "refusal-session",
  "ssrf-literal",
  "ssrf-metadata",
  "redirect",
  "overcharge-release",
  "explorer",
  "secret-scan",
] as const;

/**
 * Cases that pay: each records the settlement it showed. The session check pays once on purpose before
 * its second payment is refused, so it records that first payment too.
 */
const PAYING = ["pay-exact", "replay", "pay-upto", "agent-mcp", "sell-listed", "refusal-session"] as const;
/** Cases that are refused: each records a coded rejection. */
const REFUSED = [
  "cap-below-price",
  "replay",
  "overcharge",
  "refusal-network",
  "refusal-asset",
  "refusal-amount",
  "refusal-recipient",
  "refusal-session",
  "ssrf-literal",
  "ssrf-metadata",
  "redirect",
] as const;
/** Refusals that move nothing: the payer's balance is recorded unchanged. */
const UNCHANGED = REFUSED.filter((id) => id !== "replay" && id !== "refusal-session");
/** Cases that only a run with every service in reach can do; any other run must say why it skipped them. */
const SKIPPABLE = new Set<string>(["sell-listed", "ssrf-literal", "redirect"]);

/**
 * Problems with a live-playground document: a required case missing, failed or skipped without being
 * allowed to; a paying case without its transaction; a refusal without its code or with a balance
 * that moved; onboarding without its three transactions; a transaction the explorer did not answer
 * 200 for; or a secret scan that found anything, or did not prove itself on a planted leak.
 */
export function livePlaygroundProblems(evidence: Evidence): string[] {
  const problems: string[] = [];
  if (evidence.kind !== "live-playground") problems.push(`kind is ${evidence.kind}, not live-playground`);
  const byId = new Map<string, EvidenceCase>(evidence.cases.map((entry) => [entry.id, entry]));
  const ran = (id: string): EvidenceCase | undefined => {
    const entry = byId.get(id);
    return entry?.status === "passed" ? entry : undefined;
  };

  for (const id of PLAYGROUND_CASES) {
    const entry = byId.get(id);
    if (entry === undefined) problems.push(`case ${id} is missing`);
    else if (entry.status === "failed") problems.push(`case ${id} failed`);
    else if (entry.status === "skipped" && !SKIPPABLE.has(id))
      problems.push(`case ${id} must not be skipped`);
    if (entry !== undefined && !entry.checks.includes("playground")) {
      problems.push(`case ${id} does not name the playground check`);
    }
  }

  const onboarding = ran("onboarding");
  const classic = onboarding?.observations?.["classicTransactions"];
  if (onboarding !== undefined && (!Array.isArray(classic) || classic.length !== 3)) {
    problems.push("onboarding must record its three setup transactions");
  }
  for (const id of PAYING) {
    const entry = ran(id);
    if (entry !== undefined && (entry.transactions?.length ?? 0) === 0) {
      problems.push(`case ${id} records no transaction`);
    }
  }
  for (const id of REFUSED) {
    const entry = ran(id);
    if (entry !== undefined && (entry.rejections?.length ?? 0) === 0) {
      problems.push(`case ${id} records no rejection`);
    }
  }
  for (const id of UNCHANGED) {
    const entry = ran(id);
    if (entry !== undefined && entry.observations?.["balancesUnchanged"] !== true) {
      problems.push(`case ${id} does not record an unchanged balance`);
    }
  }

  const explorer = ran("explorer");
  const checked = new Map<string, number>();
  const listed = explorer?.observations?.["transactions"];
  for (const item of Array.isArray(listed) ? (listed as { hash?: unknown; apiStatus?: unknown }[]) : []) {
    if (typeof item.hash === "string" && typeof item.apiStatus === "number")
      checked.set(item.hash, item.apiStatus);
  }
  if (explorer !== undefined) {
    const hashes = [
      ...evidence.cases.flatMap((entry) => (entry.transactions ?? []).map((transaction) => transaction.hash)),
      ...(Array.isArray(classic) ? (classic as { hash?: unknown }[]) : []).flatMap((item) =>
        typeof item.hash === "string" ? [item.hash] : [],
      ),
    ];
    for (const hash of hashes) {
      const status = checked.get(hash);
      if (status === undefined) problems.push(`transaction ${hash} was not checked in the explorer`);
      else if (status !== 200) problems.push(`transaction ${hash}: the explorer answered ${String(status)}`);
    }
  }

  const scan = ran("secret-scan")?.observations?.["secretScan"] as
    { hits?: unknown; plantedLeakFound?: unknown } | undefined;
  if (byId.get("secret-scan")?.status === "passed" && (scan?.hits !== 0 || scan.plantedLeakFound !== true)) {
    problems.push("the secret scan must record 0 hits and a found planted leak");
  }
  return problems;
}
