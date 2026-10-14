/**
 * The Playground in Chromium, end to end on the local stack (e2e/stack.ts): the production build with
 * its real CSP, the real engine, real transactions on the private Stellar network.
 *
 * One test wallet is imported from a canary seed and funded through the wallet panel, then every lab
 * scenario and experiment, every refusal check, the Pay, Bazaar, Sell and Agents pages run through
 * the UI. Rows must appear in causal order with their sources, transactions must link to the
 * explorer, refusals must show their codes, balances must move exactly as the page says, and no page
 * may log an error or violate its CSP. Last, everything the browser sent, stored, logged and showed
 * is scanned for the key and the payments.
 */
import { readFileSync } from "node:fs";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { Keypair } from "@stellar/stellar-sdk";
import { SecretScanner } from "@rail402.dev/testkit";
import { CHECK_EXPECTED_CODES, CHECK_IDS, LAB_PRICES } from "../src/shared/lab.ts";
import { recordRun } from "../web/test/fixtures/record.ts";
import { LAB_ROWS } from "./expected.ts";
import type { StackInfo } from "./ports.ts";
import {
  Traffic,
  addPaymentNeedles,
  balance,
  captureExchanges,
  guardProblems,
  seedFoundInPlantedRpcBody,
  captureStorage,
  control,
  pinHorizon,
  samplePaymentHeader,
  stackInfo,
  uncodedRelayFailures,
  watchProblems,
  type PageProblem,
} from "./support.ts";

test.describe.configure({ mode: "serial" });

const PASSPHRASE = "Test SDF Network ; September 2015";
const TX_LINK = /^https:\/\/stellar\.expert\/explorer\/testnet\/tx\/[0-9a-f]{64}$/;
/** Demo seller prices in base units (7 decimals). */
const WEATHER = 10_000n;
const HISTORY_WEEK = 21_000n;
const FORECAST_SIX_HOURS = 12_000n;
const SELL = BigInt(LAB_PRICES.sell.atomic);

const canary = Keypair.random();
const payer = canary.publicKey();
const problems: PageProblem[] = [];
const consoleLines: string[][] = [];
const domTexts: { name: string; text: string }[] = [];
const reports: { name: string; text: string }[] = [];
let stack: StackInfo;
let context: BrowserContext;
let traffic: Traffic;
let page: Page;

interface Balances {
  readonly payer: bigint;
  readonly demo: bigint;
  readonly lab: bigint;
}

async function balances(): Promise<Balances> {
  const [mine, demo, lab] = await Promise.all([
    balance(payer),
    balance(stack.demoSeller.payTo),
    balance(stack.labPayTo),
  ]);
  return { payer: mine, demo, lab };
}

/** Each row as `step lane status source`, in the order the swimlane draws them. */
async function rowShapes(target: Page = page): Promise<string[]> {
  const rows = target.locator('ol[aria-label="Messages"] button.row');
  const shapes: string[] = [];
  for (const row of await rows.all()) {
    const [step, lane, status, source] = await Promise.all(
      ["data-step", "data-lane", "data-status", "data-source"].map((name) => row.getAttribute(name)),
    );
    shapes.push(`${step ?? "?"} ${lane ?? "?"} ${status ?? "?"} ${source ?? "?"}`);
  }
  return shapes;
}

/** Remembers what the page shows now, for the secret scan. */
async function snapshot(name: string): Promise<void> {
  domTexts.push({ name, text: await page.locator("body").innerText() });
}

/** Saves the shown run's report through the page's download button; a lab run's is a fixture too. */
async function downloadReport(name: string, fixture = true): Promise<unknown> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download the run report" }).click(),
  ]);
  const path = await download.path();
  const text = readFileSync(path, "utf8");
  reports.push({ name, text });
  const report = JSON.parse(text) as unknown;
  if (!fixture) return report;
  recordRun(name, report, {
    publicUrl: stack.publicUrl,
    demoSellerUrl: stack.demoSeller.url,
    facilitatorUrl: stack.rail402Url,
    payer,
    demoPayTo: stack.demoSeller.payTo,
    labPayTo: stack.labPayTo,
    sponsor: stack.sponsor,
    asset: stack.asset,
    assetIssuer: stack.assetIssuer,
    uptoContract: stack.uptoContract,
  });
  return report;
}

/** The Pay page for any URL. */
const payUrl = (url: string): string => `/pay?${new URLSearchParams({ url }).toString()}`;

/** The session budget meter's label: it says what is spent, held and left. */
const meterLabel = (): Promise<string | null> => page.getByRole("meter").getAttribute("aria-label");

/** Runs the lab's scenario and experiment through the UI and waits for its outcome. */
async function runLab(scenario: string, experiment: string): Promise<void> {
  const query = new URLSearchParams({ scenario });
  if (experiment !== "normal") query.set("experiment", experiment);
  await page.goto(`/?${query.toString()}`);
  await expect(
    page.getByRole("tablist", { name: "Scenario" }).getByRole("tab", { selected: true }),
  ).toBeVisible();
  const run = page.getByRole("button", { name: /^(Run on testnet|Run again)$/ });
  await expect(run).toBeEnabled();
  await run.click();
  await expect(page.locator(".flow-status")).toHaveText(/messages · click one to inspect$/, {
    timeout: 200_000,
  });
  await expect(page.getByRole("region", { name: "Outcome" })).toBeVisible();
}

async function outcomeTxLink(): Promise<string> {
  const link = page.getByRole("region", { name: "Outcome" }).locator("a.tx-link");
  const href = await link.getAttribute("href");
  expect(href).toMatch(TX_LINK);
  return href ?? "";
}

test.beforeAll(async ({ browser }) => {
  stack = await stackInfo();
  context = await browser.newContext();
  await pinHorizon(context);
  traffic = new Traffic(context);
  page = await context.newPage();
  consoleLines.push(watchProblems(page, "main", problems));
});

test.afterAll(async () => {
  await context.close();
});

test.afterEach(() => {
  expect(problems, "console errors, page errors or CSP violations").toEqual([]);
});

test("serves the built page with a strict CSP and starts the real engine", async () => {
  const response = await page.goto("/");
  const csp = response?.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("style-src 'self'");
  expect(csp).not.toContain("unsafe-inline");
  expect(csp).not.toContain("unsafe-eval");
  await expect(page.getByText("Stellar testnet", { exact: true })).toBeVisible();
  await expect(page.locator(".wallet-chip")).toHaveText("Set up a test wallet");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Watch an x402 payment happen, one message at a time",
  );
});

test("imports a testnet key and sets it up with test funds, each step on chain", async () => {
  await page.locator(".wallet-chip").click();
  const panel = page.getByRole("region", { name: "Test wallet" });
  await panel.locator("#import-seed").fill(canary.secret());
  await panel.getByRole("button", { name: "Import" }).click();
  await expect(panel.locator(".wallet-address")).toHaveText(payer);
  await expect(panel.locator("#import-seed")).toHaveCount(0);

  await panel.getByRole("button", { name: "Set up test funds" }).click();
  await expect(panel.locator("#setup-heading")).toHaveText("Set up", { timeout: 120_000 });
  const links = panel.locator(".setup-step a.tx-link");
  await expect(links).toHaveCount(3);
  for (const link of await links.all()) expect(await link.getAttribute("href")).toMatch(TX_LINK);
  expect(await balance(payer)).toBe(10_000_000n);
  await expect(page.locator(".wallet-chip")).toContainText("1 USDC");
  await expect(page.getByRole("meter")).toBeVisible();

  // The key file holds the seed, by design, and only after a confirmation.
  await panel.getByRole("button", { name: "Download key file…" }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    panel.getByRole("button", { name: "Download the key file" }).click(),
  ]);
  expect(readFileSync(await download.path(), "utf8")).toContain(canary.secret());
  await panel.getByRole("button", { name: "Close" }).click();
  await snapshot("after setup");
});

test("keeps the wallet in one tab: a second tab finds it locked", async () => {
  const second = await context.newPage();
  consoleLines.push(watchProblems(second, "second tab", problems));
  await second.goto("/");
  await expect(second.locator(".wallet-chip")).toHaveText("Wallet in another tab");
  await expect(second.getByRole("button", { name: "Run on testnet" })).toBeDisabled();
  await second.close();
});

test.describe("the lab", () => {
  test("pays for an API: one exact payment, sponsored and settled on chain", async () => {
    const before = await balances();
    const meter = await meterLabel();
    await runLab("pay", "normal");
    expect(await rowShapes()).toEqual(LAB_ROWS["pay-normal"]);
    const outcome = page.getByRole("region", { name: "Outcome" });
    await expect(outcome.locator(".outcome-badge")).toHaveText("Paid and delivered");
    await expect(outcome.getByRole("list", { name: "Money" })).toContainText(/You\s*−\s*0\.001 USDC/);
    await outcomeTxLink();
    expect(await balances()).toEqual({
      ...before,
      payer: before.payer - WEATHER,
      demo: before.demo + WEATHER,
    });
    await expect.poll(meterLabel).not.toBe(meter);

    // A row opens in the inspector.
    await page.locator('button.row[data-step="submit"]').click();
    await expect(page.locator('button.row[data-step="submit"]')).toHaveAttribute("aria-pressed", "true");
    await downloadReport("pay-normal");
    await snapshot("pay normal");
  });

  test("refuses a cap below the price before anything is signed", async () => {
    const before = await balances();
    await runLab("pay", "low-cap");
    expect(await rowShapes()).toEqual(LAB_ROWS["pay-low-cap"]);
    const outcome = page.getByRole("region", { name: "Outcome" });
    await expect(outcome.locator(".outcome-badge")).toHaveText("Refused safely");
    await expect(outcome.locator(".outcome-code code")).toHaveText("payment_per_call_cap_exceeded");
    await expect(outcome.locator(".outcome-code span")).not.toBeEmpty();
    await expect(outcome.locator("a.tx-link")).toHaveCount(0);
    expect(await balances()).toEqual(before);
    await downloadReport("pay-low-cap");
    await snapshot("pay low cap");
  });

  test("sends the same payment twice and is charged once", async () => {
    const before = await balances();
    await runLab("pay", "replay");
    expect((await rowShapes()).slice(7)).toEqual(LAB_ROWS["pay-replay-tail"]);
    const outcome = page.getByRole("region", { name: "Outcome" });
    await expect(outcome.locator(".outcome-badge")).toHaveText("Paid once");
    // The run's money: the first payment, once; the copy moved nothing.
    const money = outcome.getByRole("list", { name: "Money" });
    await expect(money).toContainText(/You\s*−\s*0\.001 USDC/);
    await expect(money).toContainText(/\+\s*0\.001 USDC/);
    await outcomeTxLink();
    expect(await balances()).toEqual({
      ...before,
      payer: before.payer - WEATHER,
      demo: before.demo + WEATHER,
    });
    await downloadReport("pay-replay");
    await snapshot("pay replay");
  });

  test("pays per use: authorizes the cap and settles what was used", async () => {
    const before = await balances();
    await runLab("upto", "normal");
    expect(await rowShapes()).toEqual(LAB_ROWS["upto-normal"]);
    const outcome = page.getByRole("region", { name: "Outcome" });
    await expect(outcome.locator(".outcome-badge")).toHaveText("Charged for usage");
    await expect(page.locator('button.row[data-step="settle"]')).toContainText("/settle 0.0021 USDC");
    await outcomeTxLink();
    expect(await balances()).toEqual({
      ...before,
      payer: before.payer - HISTORY_WEEK,
      demo: before.demo + HISTORY_WEEK,
    });
    await downloadReport("upto-normal");
    await snapshot("upto normal");
  });

  test("blocks a seller that charges over the cap: nothing moves", async () => {
    const before = await balances();
    await runLab("upto", "overcharge");
    expect(await rowShapes()).toEqual(LAB_ROWS["upto-overcharge"]);
    const outcome = page.getByRole("region", { name: "Outcome" });
    await expect(outcome.locator(".outcome-badge")).toHaveText("Overcharge blocked");
    await expect(outcome.locator(".outcome-code code")).toHaveText(
      "invalid_upto_stellar_payload_settlement_exceeds_amount",
    );
    await expect(page.locator('button.row[data-step="settle"]')).toContainText("/settle 0.02 USDC");
    await expect(outcome.locator("a.tx-link")).toHaveCount(0);
    expect(await balances()).toEqual(before);
    // The authorization is held until it expires unused.
    await expect(page.getByRole("meter")).toHaveAttribute("aria-label", /0\.01 held/);
    await downloadReport("upto-overcharge");
    await snapshot("upto overcharge");
  });

  test("lets an agent find a tool in the Bazaar, check its budget and pay it", async () => {
    const before = await balances();
    await runLab("agent", "normal");
    expect(await rowShapes()).toEqual(LAB_ROWS["agent-normal"]);
    const outcome = page.getByRole("region", { name: "Outcome" });
    await expect(outcome.locator(".outcome-badge")).toHaveText("Agent paid within budget");
    await outcomeTxLink();
    expect(await balances()).toEqual({
      ...before,
      payer: before.payer - FORECAST_SIX_HOURS,
      demo: before.demo + FORECAST_SIX_HOURS,
    });
    await downloadReport("agent-normal");
    await snapshot("agent normal");
  });

  test("sells through the sandbox route: settled, cataloged, origin-checked and found", async () => {
    const before = await balances();
    await runLab("sell", "normal");
    expect(await rowShapes()).toEqual(LAB_ROWS["sell-normal"]);
    const outcome = page.getByRole("region", { name: "Outcome" });
    await expect(outcome.locator(".outcome-badge")).toHaveText("Earned and listed");
    await outcomeTxLink();
    expect(await balances()).toEqual({ ...before, payer: before.payer - SELL, lab: before.lab + SELL });
    await downloadReport("sell-normal");
    await snapshot("sell normal");
  });
});

test("runs every refusal check: refused with its code, nothing signed, balance unchanged", async () => {
  const before = await balances();
  await page.goto("/pay");
  const panel = page.getByRole("region", { name: "What your buyer refuses" });
  await panel.getByRole("button", { name: "Run all checks" }).click();
  const checks = panel.locator("li.check");
  await expect(checks).toHaveCount(CHECK_IDS.length);
  await expect(panel.locator('li.check[data-state="passed"]')).toHaveCount(CHECK_IDS.length, {
    timeout: 200_000,
  });
  for (const [index, check] of CHECK_IDS.entries()) {
    const row = checks.nth(index);
    await expect(row.locator(".check-result code")).toHaveText(CHECK_EXPECTED_CODES[check]);
    const signed = check === "session-budget" ? "1 authorization(s)" : "nothing";
    await expect(row.locator(".check-result")).toContainText(`Signed${signed}`);
    await expect(row.locator(".check-result")).toContainText(
      check === "session-budget"
        ? /Balance−\s*0\.001 USDC \(the first payment, from your session budget\)/
        : "Balanceunchanged",
    );
  }
  // Only the session check pays once, from your session budget; the second payment is refused.
  expect(await balances()).toEqual({ ...before, payer: before.payer - WEATHER, demo: before.demo + WEATHER });
  await snapshot("refusal checks");
});

test.describe("the Pay page", () => {
  test("pays the demo route and shows the receipt", async () => {
    const before = await balances();
    await page.goto("/pay");
    // The demo route's price is read before paying (an unpaid request): the button names it.
    await page.getByRole("button", { name: /^Pay 0\.001 USDC and call$/ }).click();
    const result = page.getByRole("region", { name: "Result" });
    await expect(result.locator(".outcome-badge")).toHaveText("Paid and delivered", { timeout: 120_000 });
    await expect(result).toContainText("Sponsored");
    // What was paid for: the seller's response body, as text.
    await expect(result.locator(".response-body")).toContainText('"city": "Ankara"');
    expect(await result.locator("a.tx-link").getAttribute("href")).toMatch(TX_LINK);
    expect(await balances()).toEqual({
      ...before,
      payer: before.payer - WEATHER,
      demo: before.demo + WEATHER,
    });
    // Under the hood: the same swimlane as the lab, open once the payment finished.
    await expect(page.locator("details.under-the-hood")).toHaveAttribute("open", "");
    expect(await rowShapes()).toEqual(LAB_ROWS["pay-normal"]);
    await downloadReport("pay-page", false);
    await snapshot("pay page");
  });

  test("pays any URL", async () => {
    const before = await balances();
    await page.goto(payUrl(`${stack.demoSeller.url}/weather?city=Izmir`));
    await expect(page.locator("#pay-url")).toHaveValue(`${stack.demoSeller.url}/weather?city=Izmir`);
    await page.getByRole("button", { name: /^Pay up to .* and call$/ }).click();
    const result = page.getByRole("region", { name: "Result" });
    await expect(result.locator(".outcome-badge")).toHaveText("Paid and delivered", { timeout: 120_000 });
    await expect(result.locator(".response-body")).toContainText('"city": "Izmir"');
    expect(await balances()).toEqual({
      ...before,
      payer: before.payer - WEATHER,
      demo: before.demo + WEATHER,
    });
    await snapshot("pay any url");
  });

  test("never follows a redirect to another origin, and signs nothing", async () => {
    const before = await balances();
    await page.goto(payUrl(`${stack.redirectorUrl}/pay`));
    await page.getByRole("button", { name: /^Pay up to .* and call$/ }).click();
    const result = page.getByRole("region", { name: "Result" });
    await expect(result.locator(".outcome-code code")).toHaveText(/^egress_/, { timeout: 60_000 });
    await expect(result.locator("a.tx-link")).toHaveCount(0);
    expect(await control<{ requests: number }>("/decoy")).toEqual({ requests: 0 });
    expect(await balances()).toEqual(before);
    await snapshot("redirect refused");
  });
});

test("finds a listing in the Bazaar and pays it from the Pay page", async () => {
  const before = await balances();
  await page.goto("/bazaar");
  const search = page.getByRole("search");
  await search.getByRole("searchbox").fill("current weather for a city");
  await search.getByRole("button", { name: "Search" }).click();
  const row = page.getByRole("row").filter({ hasText: "/weather" }).filter({ hasText: "HTTP" }).first();
  await expect(row).toBeVisible();
  await expect(page.locator(".table-foot")).toContainText("Ranked by");
  await row.getByRole("button", { name: "History" }).click();
  await expect(page.locator(".listing-details .versions li").first()).toBeVisible();
  await row.getByRole("link", { name: "Try" }).click();
  await expect(page).toHaveURL(/\/pay\?listing=/);
  // The listing loads after the page opens; fill the parameters once it has.
  await expect(page.getByRole("form", { name: "Request" }).locator(".resource-name")).toContainText(
    "/weather",
  );
  await page.locator("#pay-params").fill('{ "city": "Ankara" }');
  await page.getByRole("button", { name: /^Pay 0\.001 USDC and call$/ }).click();
  const result = page.getByRole("region", { name: "Result" });
  await expect(result.locator(".outcome-badge")).toHaveText("Paid and delivered", { timeout: 120_000 });
  expect(await balances()).toEqual({ ...before, payer: before.payer - WEATHER, demo: before.demo + WEATHER });
  await snapshot("bazaar pay");
});

test("finds an MCP tool in the Bazaar and pays it from the Pay page", async () => {
  const before = await balances();
  await page.goto("/bazaar");
  const search = page.getByRole("search");
  await search.getByRole("searchbox").fill("hourly weather forecast");
  await search.getByRole("button", { name: "Search" }).click();
  const row = page.getByRole("row").filter({ hasText: "hourly_forecast" }).first();
  await expect(row).toBeVisible();
  await row.getByRole("link", { name: "Try" }).click();
  await expect(page).toHaveURL(/\/pay\?listing=/);
  await expect(page.getByRole("form", { name: "Request" }).locator(".resource-name")).toHaveText(
    "hourly_forecast · MCP",
  );
  await page.locator("#pay-params").fill('{ "city": "Izmir", "hours": 6 }');
  await page.getByRole("button", { name: /^Pay (up to )?\d.* and call$/ }).click();
  const result = page.getByRole("region", { name: "Result" });
  await expect(result.locator(".outcome-badge")).toHaveText("Paid and delivered", { timeout: 120_000 });
  await expect(result.locator(".outcome-headline")).toContainText("hourly_forecast");
  await expect(result.locator(".response-line")).toContainText("tool result from hourly_forecast");
  await expect(result.locator(".response-body")).toContainText("Izmir");
  await expect(result).not.toContainText("405");
  expect(await result.locator("a.tx-link").getAttribute("href")).toMatch(TX_LINK);
  expect(await balances()).toEqual({
    ...before,
    payer: before.payer - FORECAST_SIX_HOURS,
    demo: before.demo + FORECAST_SIX_HOURS,
  });
  await expect(page.locator("details.under-the-hood")).toHaveAttribute("open", "");
  expect(await rowShapes()).toEqual(LAB_ROWS["pay-mcp-listing"]);
  await downloadReport("pay-mcp-listing");
  await snapshot("bazaar pay mcp");
});

test("checks a seller's endpoint and shows the sandbox listing", async () => {
  await page.goto("/sell");
  const check = page.getByRole("region", { name: "Check your endpoint" });
  await check.locator("#check-url").fill(`${stack.demoSeller.url}/weather?city=Ankara`);
  await check.getByRole("button", { name: "Check" }).click();
  const items = check.locator(".checklist li");
  await expect(items.first()).toBeVisible({ timeout: 60_000 });
  // What the catalog requires passes; the local demo account has no home domain, so only the
  // optional domain verification is missing.
  for (const text of [
    "Answers 402 with an x402 price",
    "Discovery metadata is valid",
    "payTo can receive USDC",
  ])
    await expect(items.filter({ hasText: text })).toHaveAttribute("data-state", "ok");
  await expect(check.getByRole("link", { name: "Pay it once from here" })).toBeVisible();

  const listing = page.getByRole("region", { name: "Your listing" });
  await listing.locator("#listing-payto").fill(stack.labPayTo);
  await listing.getByRole("button", { name: "Show" }).click();
  const card = listing.locator(".listing-card");
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("published");
  await card.getByRole("button", { name: "Version history" }).click();
  await expect(card.locator(".versions li").first()).toBeVisible();
  await snapshot("sell page");
});

test("runs the agent example on the Agents page", async () => {
  const before = await balances();
  await page.goto("/agents");
  const example = page.getByRole("region", { name: "Example run" });
  await example.getByRole("button", { name: "Run it on testnet" }).click();
  await expect(example.locator(".bubble-agent")).toBeVisible({ timeout: 120_000 });
  await expect(example).toContainText(`paid 0.0012 USDC`);
  expect(await balances()).toEqual({
    ...before,
    payer: before.payer - FORECAST_SIX_HOURS,
    demo: before.demo + FORECAST_SIX_HOURS,
  });
  await snapshot("agents page");
});

test("never paid from the fee sponsor", async () => {
  expect(await balance(stack.sponsor)).toBe(0n);
});

/**
 * The browser's half of the canary scan. Needles: the imported seed and its key bytes, and every
 * payment the page sent (PAYMENT-SIGNATURE to the relay and the lab sellers, MCP
 * `_meta["x402/payment"]`) with its transaction, authorizations, preimages and signatures. A payment
 * may appear only in the request that carried it, and signed transactions only in what the page sent
 * the RPC. Answers from the chain (RPC, Friendbot) are public ledger data and are not scanned.
 * Everything else must be clean: every request and answer, the server's trace-level logs, the console,
 * the page's text after each run, localStorage, sessionStorage, IndexedDB and the run reports.
 */
test("keeps the key and the payments out of every other channel", async () => {
  await traffic.settled();
  const scanner = new SecretScanner(canary.secret());
  const payments = addPaymentNeedles(scanner, traffic.exchanges, PASSPHRASE);
  // Lab: pay, the resend, upto, overcharge, agent, sell; the session check; Pay ×3; Agents.
  expect(payments).toBeGreaterThanOrEqual(12);
  const chain = { rpcUrl: stack.rpcUrl, friendbotUrl: stack.friendbotUrl };
  // RPC calls and payment-carrying requests are exempt from the payment needles, never from the seed.
  const seedOnly = new SecretScanner(canary.secret());
  captureExchanges(scanner, traffic.exchanges, chain, seedOnly);
  seedOnly.assertClean();
  expect(
    seedFoundInPlantedRpcBody(canary.secret(), traffic.exchanges, chain, (seed) => new SecretScanner(seed)),
  ).toBe(true);

  // The relay's error answers are its coded refusals, never an unexplained failure.
  expect(uncodedRelayFailures(traffic.exchanges)).toEqual([]);

  const logs = await control<{ logs: unknown[]; stderr: string }>("/logs");
  expect(logs.logs.length).toBeGreaterThan(0);
  scanner.capture("server logs", JSON.stringify(logs.logs));
  scanner.capture("server stderr", logs.stderr);
  scanner.capture("browser console", consoleLines.flat().join("\n"));
  for (const { name, text } of domTexts) scanner.capture(`page text: ${name}`, text);
  for (const { name, text } of reports) scanner.capture(`run report: ${name}`, text);
  const stored = await captureStorage(scanner, page);
  expect(stored).toContain('"extractable":false');
  expect(stored).not.toContain('"extractable":true');
  expect(reports.length).toBeGreaterThanOrEqual(7);
  scanner.assertClean();

  // Every run kept the signing guard's order: one signature per call, after its reservation.
  for (const { name, text } of reports) {
    const report = JSON.parse(text) as { events: Record<string, unknown>[] };
    expect(guardProblems(report.events), name).toEqual([]);
  }

  // The scan finds a payment where one does not belong.
  const planted = samplePaymentHeader(traffic.exchanges);
  scanner.capture("planted", JSON.stringify({ echo: planted?.slice(10, 50) }));
  expect(() => {
    scanner.assertClean();
  }).toThrow(/planted/);
});
