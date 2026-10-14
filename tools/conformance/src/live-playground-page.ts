/**
 * What the live Playground run does in the browser, through the page only: the wallet panel, a lab
 * run with its swimlane, outcome and run report, a refusal check, and a payment from the Pay page.
 * Every function reads back what the page shows; the run report the page exports is the event log the
 * page drew from.
 */
import { readFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

/** A Playground run report, as the page's "Download the run report" button saves it. */
export interface RunReport {
  readonly format: string;
  readonly runId: string;
  readonly summary: { readonly status: string; readonly code?: string; readonly reason?: string } | null;
  readonly events: readonly ReportEvent[];
}

/** The parts of a run event this run reads. */
export interface ReportEvent {
  readonly kind: string;
  readonly phase?: string;
  readonly event?: { readonly type?: string };
  readonly layer?: string;
  readonly code?: string;
  readonly reason?: string;
  readonly view?: { readonly hash?: string; readonly explorerUrl?: string };
  readonly listing?: { readonly id?: string; readonly state?: string | null; readonly trust?: string };
  readonly top?: readonly { readonly id?: string }[];
  readonly query?: string;
}

/** Waits until `probe` returns a value other than undefined, or throws `message` after `timeoutMs`. */
export async function until<T>(
  probe: () => Promise<T | undefined>,
  message: string,
  timeoutMs = 60_000,
  intervalMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`timed out after ${String(timeoutMs)} ms: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

const text = async (locator: Locator): Promise<string> => ((await locator.textContent()) ?? "").trim();

/** Waits until `locator`'s text matches `pattern` and returns it. */
export function textMatching(locator: Locator, pattern: RegExp, timeoutMs = 60_000): Promise<string> {
  return until(
    async () => {
      const value = await text(locator);
      return pattern.test(value) ? value : undefined;
    },
    `text matching ${String(pattern)}`,
    timeoutMs,
  );
}

const HASH_LINK = /\/tx\/([0-9a-f]{64})$/;

/** The transaction hash of an explorer link's href. */
export function hashOfLink(href: string): string {
  const hash = HASH_LINK.exec(href)?.[1];
  if (hash === undefined) throw new Error(`not an explorer transaction link: ${href}`);
  return hash;
}

// --- wallet -----------------------------------------------------------------------------------------

/**
 * Imports a testnet seed through the wallet panel and sets it up with test funds: Friendbot, the
 * asset's trustline and a small purchase. Returns the explorer links of the setup transactions.
 */
export async function importAndFund(page: Page, seed: string, address: string): Promise<string[]> {
  await page.goto("/");
  await page.locator(".wallet-chip").click();
  const panel = page.getByRole("region", { name: "Test wallet" });
  await panel.locator("#import-seed").fill(seed);
  await panel.getByRole("button", { name: "Import" }).click();
  await textMatching(panel.locator(".wallet-address"), new RegExp(`^${address}$`));
  await panel.getByRole("button", { name: "Set up test funds" }).click();
  await textMatching(panel.locator("#setup-heading"), /^Set up$/, 240_000);
  const links = await panel.locator(".setup-step a.tx-link").all();
  const hrefs = await Promise.all(links.map(async (link) => (await link.getAttribute("href")) ?? ""));
  await panel.getByRole("button", { name: "Close" }).click();
  return hrefs;
}

/** The session budget meter's label: what is spent, held and left. */
export async function meterLabel(page: Page): Promise<string> {
  return (await page.getByRole("meter").getAttribute("aria-label")) ?? "";
}

/** Asks the page to check unfinished payments against the chain now, when the panel offers it. */
export async function reconcileNow(page: Page): Promise<void> {
  await page.locator(".wallet-chip").click();
  const panel = page.getByRole("region", { name: "Test wallet" });
  const button = panel.getByRole("button", { name: "Check the chain now" });
  if ((await button.count()) > 0 && (await button.isEnabled())) await button.click();
  await panel.getByRole("button", { name: "Close" }).click();
}

// --- lab ----------------------------------------------------------------------------------------------

/** What a finished lab run shows. */
export interface LabResult {
  /** Each swimlane row as `step lane status source`, in drawing order. */
  readonly rows: readonly string[];
  readonly badge: string;
  /** The code the outcome shows for a refusal, when it shows one. */
  readonly code: string | undefined;
  /** The explorer link of the run's transaction, when it has one. */
  readonly txLink: string | undefined;
  readonly report: RunReport;
  /** The report as the page saved it, for the secret scan. */
  readonly reportText: string;
}

/** Each swimlane row as `step lane status source`, in drawing order. */
export async function rowShapes(page: Page): Promise<string[]> {
  const shapes: string[] = [];
  for (const row of await page.locator('ol[aria-label="Messages"] button.row').all()) {
    const [step, lane, status, source] = await Promise.all(
      ["data-step", "data-lane", "data-status", "data-source"].map((name) => row.getAttribute(name)),
    );
    shapes.push(`${step ?? "?"} ${lane ?? "?"} ${status ?? "?"} ${source ?? "?"}`);
  }
  return shapes;
}

/** Saves the shown run's report through the page's download button. */
export async function downloadReport(page: Page): Promise<{ report: RunReport; text: string }> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download the run report" }).click(),
  ]);
  const saved = readFileSync(await download.path(), "utf8");
  const report = JSON.parse(saved) as RunReport;
  if (report.format !== "rail402-playground-run") throw new Error("the download is not a run report");
  return { report, text: saved };
}

/** The outcome's or result card's code, badge and transaction link. */
async function outcomeOf(region: Locator) {
  const code = region.locator(".outcome-code code");
  const link = region.locator("a.tx-link");
  return {
    badge: await text(region.locator(".outcome-badge")),
    code: (await code.count()) > 0 ? await text(code.first()) : undefined,
    txLink: (await link.count()) > 0 ? ((await link.first().getAttribute("href")) ?? undefined) : undefined,
  };
}

/** Runs a lab scenario and experiment with the page's default cap and waits for its outcome. */
export async function runLab(page: Page, scenario: string, experiment: string): Promise<LabResult> {
  const query = new URLSearchParams({ scenario });
  if (experiment !== "normal") query.set("experiment", experiment);
  await page.goto(`/?${query.toString()}`);
  const run = page.getByRole("button", { name: /^(Run on testnet|Run again)$/ });
  await until(async () => ((await run.isEnabled()) ? true : undefined), "the Run button", 120_000);
  await run.click();
  await textMatching(page.locator(".flow-status"), /messages · click one to inspect$/, 300_000);
  const outcome = page.getByRole("region", { name: "Outcome" });
  await outcome.waitFor({ state: "visible" });
  const { report, text: reportText } = await downloadReport(page);
  return { rows: await rowShapes(page), ...(await outcomeOf(outcome)), report, reportText };
}

// --- refusal checks ---------------------------------------------------------------------------------

/** Titles of the refusal checks on the Pay page, by check id. */
export const CHECK_TITLES = Object.freeze({
  network: "Wrong network",
  asset: "Asset not allowed",
  amount: "Amount not allowed",
  recipient: "Recipient blocked",
  "per-call-cap": "Over the per-call cap",
  "session-budget": "Session budget used up",
  "private-address": "Private address",
});
export type CheckTitleId = keyof typeof CHECK_TITLES;

/** What a finished refusal check shows. */
export interface CheckResult {
  readonly state: string;
  readonly fields: Readonly<Record<string, string>>;
  /** The transaction links the check's result shows (the session check's first payment). */
  readonly txLinks: readonly string[];
}

/** Runs one refusal check from the Pay page's panel and returns the fields it shows. */
export async function runCheck(page: Page, check: CheckTitleId): Promise<CheckResult> {
  await page.goto("/pay");
  const panel = page.getByRole("region", { name: "What your buyer refuses" });
  const row = panel.locator("li.check").filter({ hasText: CHECK_TITLES[check] });
  const run = row.getByRole("button", { name: /^(Run|Run again)$/ });
  await until(async () => ((await run.isEnabled()) ? true : undefined), `the ${check} check`, 120_000);
  await run.click();
  const state = await until(
    async () => {
      const value = (await row.getAttribute("data-state")) ?? "";
      return value === "passed" || value === "failed" ? value : undefined;
    },
    `the ${check} check to finish`,
    240_000,
  );
  const fields: Record<string, string> = {};
  for (const item of await row.locator(".check-result > div").all()) {
    fields[await text(item.locator("dt"))] = await text(item.locator("dd"));
  }
  const txLinks: string[] = [];
  for (const link of await row.locator(".check-result a.tx-link").all()) {
    const href = await link.getAttribute("href");
    if (href !== null) txLinks.push(href);
  }
  return { state, fields, txLinks };
}

// --- Pay page ---------------------------------------------------------------------------------------

/** What a payment from the Pay page shows. */
export interface PayResult {
  readonly badge: string;
  readonly code: string | undefined;
  readonly txLink: string | undefined;
  readonly report: RunReport;
  readonly reportText: string;
}

/** Pays any URL from the Pay page with its default cap and waits for the result card. */
export async function payUrl(page: Page, url: string): Promise<PayResult> {
  await page.goto(`/pay?${new URLSearchParams({ url }).toString()}`);
  const button = page.getByRole("button", { name: /^Pay up to .* and call$/ });
  await until(async () => ((await button.isEnabled()) ? true : undefined), "the Pay button", 120_000);
  await button.click();
  // The report button appears once the run has ended, under the result card.
  const save = page.getByRole("button", { name: "Download the run report" });
  await until(async () => ((await save.count()) > 0 ? true : undefined), "the payment's end", 240_000);
  const outcome = await outcomeOf(page.getByRole("region", { name: "Result" }));
  const { report, text: reportText } = await downloadReport(page);
  return { ...outcome, report, reportText };
}

// --- reading run reports ----------------------------------------------------------------------------

/** How many SDK events of a type a run reported (`reserved`, `signed`, `settled`, …). */
export function sdkEventCount(report: RunReport, type: string): number {
  return report.events.filter((event) => event.kind === "sdk" && event.event?.type === type).length;
}

/** The last refusal a run reported, with the layer that refused. */
export function lastRefusal(report: RunReport): { layer: string; code: string; reason: string } | undefined {
  const refusal = report.events.filter((event) => event.kind === "refusal").at(-1);
  return refusal === undefined
    ? undefined
    : { layer: refusal.layer ?? "", code: refusal.code ?? "", reason: refusal.reason ?? "" };
}

/** The transactions a run read from the chain, by hash. */
export function reportedTransactions(report: RunReport): string[] {
  return report.events.flatMap((event) =>
    event.kind === "chain" && event.phase === "tx" && typeof event.view?.hash === "string"
      ? [event.view.hash]
      : [],
  );
}
