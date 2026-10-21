/**
 * The Playground in Chromium, end to end on the local stack (e2e/stack.ts): the production build with
 * its real CSP, the real engine, real transactions on the private Stellar network.
 *
 * The first visit makes a test wallet on its own and funds it (Friendbot, then test USDC), which a
 * reload keeps; its key file gives the canary seed for the scan at the end. Then every Lab mode runs
 * to its proof, step by step; every refusal of "Try a refusal" ends refused with its code; the Lab pays
 * a pasted URL and refuses private and redirecting ones; the Bazaar lists, filters, searches and pays
 * an HTTP listing and an MCP tool; the Sell and Agents pages copy real commands; the page works from
 * the keyboard and with reduced motion. Rows must play in causal order, transactions must link to the
 * explorer, refusals must show their codes, balances must move exactly as the page says, and no page
 * may log an error or violate its CSP. Then everything the browser sent, stored, logged and showed is
 * scanned for the key and the payments. Last, the wallet is reset and a new one is made.
 */
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { Keypair } from "@stellar/stellar-sdk";
import { SecretScanner } from "@rail402.dev/testkit";
import { CHECK_EXPECTED_CODES, OVERCHARGE_REFUSAL_CODE, REPLAY_REFUSAL_CODES } from "../src/shared/lab.ts";
import { recordRun } from "../web/test/fixtures/record.ts";
import { LAB_STEPS } from "./expected.ts";
import {
  attributesOf,
  clipboardText,
  closeWalletMenu,
  endPanel,
  exportKeyFile,
  followSetup,
  labEnd,
  labSteps,
  listingRow,
  openWalletMenu,
  payListing,
  runButton,
  runLab,
  saveReport,
  stylesOf,
  tryRefusal,
  walletAddress,
  walletPill,
} from "./page.ts";
import type { StackInfo } from "./ports.ts";
import {
  Traffic,
  addPaymentNeedles,
  balance,
  captureExchanges,
  captureStorage,
  control,
  guardProblems,
  pinHorizon,
  samplePaymentHeader,
  seedFoundInPlantedRpcBody,
  stackInfo,
  uncodedRelayFailures,
  watchProblems,
  type PageProblem,
} from "./support.ts";

test.describe.configure({ mode: "serial" });

const PASSPHRASE = "Test SDF Network ; September 2015";
const TX_LINK = /^https:\/\/stellar\.expert\/explorer\/testnet\/tx\/[0-9a-f]{64}$/;
/** What the wallet setup buys, in base units (7 decimals). */
const SETUP_FUNDS = 10_000_000n;
/** Demo seller prices in base units. */
const WEATHER = 10_000n;
const HISTORY_WEEK = 21_000n;
const FORECAST_SIX_HOURS = 12_000n;
const AIR_QUALITY = 10_000n;
/** The least time a played step stays the current one (app/lab/playback.ts paces at 800 ms). */
const MIN_STEP_MS = 600;

/** The refusals before signing, as "Try a refusal" names them, with their check ids. */
const BEFORE_SIGNING = [
  ["Another network", "network"],
  ["Unknown asset", "asset"],
  ["Zero amount", "amount"],
  ["Recipient not allowed", "recipient"],
  ["Cap below the price", "per-call-cap"],
] as const;

const problems: PageProblem[] = [];
const consoleLines: string[][] = [];
const domTexts: { name: string; text: string }[] = [];
const reports: { name: string; text: string }[] = [];
let stack: StackInfo;
let context: BrowserContext;
let traffic: Traffic;
let page: Page;
/** The wallet the page made, and the seed its key file holds: the canary of the scan. */
let payer = "";
let canarySeed = "";

interface Balances {
  readonly payer: bigint;
  readonly demo: bigint;
}

async function balances(): Promise<Balances> {
  const [mine, demo] = await Promise.all([balance(payer), balance(stack.demoSeller.payTo)]);
  return { payer: mine, demo };
}

const paidDemo = (before: Balances, amount: bigint): Balances => ({
  payer: before.payer - amount,
  demo: before.demo + amount,
});

/** Remembers what the page shows now, for the secret scan. */
async function snapshot(name: string): Promise<void> {
  domTexts.push({ name, text: await page.locator("body").innerText() });
}

/** Saves the shown run's report through the page; a Lab run's report is a projection fixture too. */
async function keepReport(name: string, fixture = true): Promise<void> {
  const text = await saveReport(page);
  reports.push({ name, text });
  if (!fixture) return;
  recordRun(name, JSON.parse(text) as unknown, {
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
}

/** The text the clipboard holds. */
const clipboard = (): Promise<string> => clipboardText(page);

test.beforeAll(async ({ browser }) => {
  stack = await stackInfo();
  context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
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

test.describe("the wallet", () => {
  test("serves the built page with a strict CSP and makes a funded test wallet on the first visit", async () => {
    const response = await page.goto("/");
    const csp = response?.headers()["content-security-policy"] ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("font-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");

    const nav = page.getByRole("navigation", { name: "Pages" });
    await expect(nav.getByRole("link")).toHaveText(["Lab", "Bazaar", "Sell", "Agents"]);
    await expect(nav.getByRole("link", { name: "Lab" })).toHaveAttribute("aria-current", "page");
    await expect(page.locator(".network-badge")).toHaveText("Testnet");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Watch a payment, step by step");

    // No button to press: the dialog shows the key, Friendbot and the test USDC, then closes.
    const setup = await followSetup(page);
    expect(setup.titles[0]).toBe("Creating your test wallet");
    expect(setup.titles.at(-1)).toBe("Your test wallet is ready");
    expect(setup.links).toHaveLength(2);
    for (const link of setup.links) expect(link).toMatch(TX_LINK);
    await expect(page.locator(".wallet-dialog")).toHaveCount(0);
    payer = setup.address;
    expect(await balance(payer)).toBe(SETUP_FUNDS);
    await expect(walletPill(page)).toContainText("1 USDC");
    await expect(walletPill(page)).toContainText(`${payer.slice(0, 4)}…${payer.slice(-4)}`);
    // Every font is the page's own: none is fetched from another origin.
    const fonts = traffic.exchanges.filter((exchange) => exchange.url.endsWith(".woff2"));
    expect(fonts.length).toBeGreaterThan(0);
    for (const font of fonts) expect(new URL(font.url).origin).toBe(stack.publicUrl);
    await snapshot("after setup");
  });

  test("shows the wallet in its menu, and writes the key only to a key file after a confirmation", async () => {
    const menu = await openWalletMenu(page);
    await expect(menu.getByRole("heading", { name: "Test wallet" })).toBeFocused();
    await expect(menu.locator(".wallet-balance-amount")).toHaveText("1");
    await expect(menu.locator(".address-text")).toHaveText(payer);
    await menu.getByRole("button", { name: "Copy address" }).click();
    expect(await clipboard()).toBe(payer);
    await expect(menu.getByRole("link", { name: /stellar\.expert/ })).toHaveAttribute(
      "href",
      `https://stellar.expert/explorer/testnet/account/${payer}`,
    );
    // The secret is never on the page.
    expect(await page.locator("body").innerText()).not.toMatch(/\bS[A-Z2-7]{55}\b/);
    await closeWalletMenu(page);
    await expect(walletPill(page)).toBeFocused();

    const keyFile = await exportKeyFile(page);
    expect(Keypair.fromSecret(keyFile.seed).publicKey()).toBe(payer);
    canarySeed = keyFile.seed;
  });

  test("adds test USDC from the menu", async () => {
    const before = await balance(payer);
    const menu = await openWalletMenu(page);
    await menu.getByRole("button", { name: "Add test USDC" }).click();
    await expect(menu.getByRole("status").filter({ hasText: "Added 1 test USDC." })).toBeVisible({
      timeout: 120_000,
    });
    expect(await balance(payer)).toBe(before + SETUP_FUNDS);
    await expect(menu.locator(".wallet-balance-amount")).toHaveText("2");
    await closeWalletMenu(page);
  });

  test("keeps the wallet across a reload, and in one tab only", async () => {
    await page.reload();
    expect(await walletAddress(page)).toBe(payer);
    await expect(page.locator(".wallet-dialog")).toHaveCount(0);

    const second = await context.newPage();
    consoleLines.push(watchProblems(second, "second tab", problems));
    await second.goto("/");
    await expect(walletPill(second)).toHaveText("Open in another tab");
    await expect(runButton(second)).toBeDisabled();
    await second.close();
  });

  test("sends the old Pay page to the Lab with its URL, which fills the field and pays nothing", async () => {
    const before = await balances();
    const url = `${stack.demoSeller.url}/weather?city=Izmir`;
    await page.goto(`/pay?${new URLSearchParams({ url }).toString()}`);
    await expect(page).toHaveURL(`/?${new URLSearchParams({ url }).toString()}`);
    await expect(page.getByLabel("URL to pay")).toHaveValue(url);
    await expect(page.locator(".stage-hint")).toContainText("came from the link you opened");
    await expect(runButton(page)).toHaveText("Run");
    expect(await balances()).toEqual(before);
  });
});

test.describe("the Lab", () => {
  test("plays a fixed-price payment one step at a time, then shows its proof", async () => {
    const before = await balances();
    await page.goto("/");
    await walletAddress(page);
    await expect(page.getByRole("button", { name: /Pay a fixed price/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByLabel("URL to pay")).toHaveValue(`${stack.demoSeller.url}/weather?city=Ankara`);
    await expect(page.locator(".swimlane-steps li.lane-step[data-look=pending]")).toHaveCount(7);

    await runButton(page).click();
    // The steps play in order, one current step at a time, each long enough to follow.
    const seen: { at: number; done: number; current: number }[] = [];
    while ((await endPanel(page).count()) === 0) {
      const looks = (await attributesOf(page, ".swimlane-steps li.lane-step", ["data-look"])).map(
        ([look]) => look,
      );
      seen.push({
        at: Date.now(),
        done: looks.filter((look) => look === "done").length,
        current: looks.filter((look) => look === "current").length,
      });
      await page.waitForTimeout(50);
    }
    expect(seen.every((sample) => sample.current <= 1)).toBe(true);
    expect(seen.every((sample, index) => index === 0 || sample.done >= (seen[index - 1]?.done ?? 0))).toBe(
      true,
    );
    // The last step shows with the proof: six paced steps come after the first.
    const firstStep = seen.find((sample) => sample.current === 1)?.at;
    expect(firstStep).toBeDefined();
    expect(Date.now() - (firstStep ?? 0)).toBeGreaterThanOrEqual(6 * MIN_STEP_MS);

    const end = await labEnd(page);
    expect(end.steps).toEqual(LAB_STEPS["exact-normal"]);
    expect(end.proof?.paid).toBe("0.001 USDC");
    expect(end.proof?.txLink).toMatch(TX_LINK);
    expect(end.proof?.tiles).toEqual(["0.01 your cap, checked first", "0 XLM from you, fee by Rail402"]);
    expect(end.proof?.parties).toEqual(
      expect.arrayContaining(["Seller: received 0.001 USDC", "You: signed once for 0.001"]),
    );
    await expect(page.getByRole("progressbar", { name: "Run progress" })).toHaveAttribute(
      "aria-valuenow",
      "7",
    );
    // What came back, as readable pairs: no raw JSON on the page.
    const result = page.locator(".inspector .result-card");
    await expect(result).toContainText("city");
    await expect(result).toContainText("Ankara");
    expect(await page.locator(".inspector").innerText()).not.toMatch(/[{}]/);
    expect(await balances()).toEqual(paidDemo(before, WEATHER));

    // Each step opens in the inspector, and the proof comes back.
    await endPanel(page).getByRole("button", { name: "See each step" }).click();
    await expect(page.locator(".inspector .step-count")).toHaveText("Step 01 / 07");
    await page
      .getByRole("list", { name: "Steps" })
      .getByRole("button", { name: /Step 6:/ })
      .click();
    await expect(page.locator(".inspector .step-count")).toHaveText("Step 06 / 07");
    await expect(page.locator(".inspector .fact-list")).toContainText(/[0-9a-f]{4}…[0-9a-f]{4}/);
    await page.getByRole("button", { name: "Back to proof" }).click();
    await expect(page.locator(".inspector .proof")).toBeVisible();
    await keepReport("pay-normal");
    await snapshot("exact normal");
  });

  test("refuses a cap typed below the price before anything is signed", async () => {
    const before = await balances();
    const end = await runLab(page, "/", { cap: "0.0001" });
    expect(end.steps).toEqual(LAB_STEPS["exact-low-cap"]);
    expect(end.verdict?.facts).toMatchObject({
      Code: "payment_per_call_cap_exceeded",
      Signed: "nothing",
      "Your balance": "unchanged",
    });
    expect(end.verdict?.txLinks).toEqual([]);
    expect(await balances()).toEqual(before);
    await keepReport("pay-below-cap");
    await snapshot("exact low cap");
  });

  test("pays a pasted URL exactly as typed", async () => {
    const before = await balances();
    // A query the demo route does not name, so it is paid as typed rather than as the scenario.
    const end = await runLab(page, "/", { url: `${stack.demoSeller.url}/weather?city=Izmir&units=metric` });
    expect(end.steps).toEqual(LAB_STEPS["exact-normal"]);
    expect(end.proof?.paid).toBe("0.001 USDC");
    await expect(page.locator(".inspector .result-card")).toContainText("Izmir");
    expect(await balances()).toEqual(paidDemo(before, WEATHER));
    await keepReport("pay-url", false);
    await snapshot("pay url");
  });

  test("pays for what is used: authorizes the cap and settles the usage", async () => {
    const before = await balances();
    const end = await runLab(page, "/?mode=upto");
    expect(end.steps).toEqual(LAB_STEPS["upto-normal"]);
    expect(end.proof?.paid).toBe("0.0021 USDC");
    expect(end.proof?.tiles).toContain("0.0079 of your cap never taken");
    expect(end.proof?.txLink).toMatch(TX_LINK);
    expect(await balances()).toEqual(paidDemo(before, HISTORY_WEEK));
    await keepReport("upto-normal");
    await snapshot("upto normal");
  });

  test("lets an agent find a tool in the Bazaar, check its budget and pay it", async () => {
    const before = await balances();
    await page.goto("/?mode=agent");
    await expect(page.locator(".inspector .prompt-card")).toContainText(
      "What is the air quality in Istanbul? Spend at most 0.05 USDC.",
    );
    const lanes = page.locator(".lane-head-text b");
    await expect(lanes).toHaveText(["AI agent", "Bazaar", "MCP tool", "Rail402", "Stellar"]);
    await runButton(page).click();
    const end = await labEnd(page);
    expect(end.steps).toEqual(LAB_STEPS["agent-normal"]);
    expect(end.proof?.paid).toBe("0.001 USDC");
    expect(end.proof?.txLink).toMatch(TX_LINK);
    expect(await balances()).toEqual(paidDemo(before, AIR_QUALITY));
    await keepReport("agent-normal");
    await snapshot("agent normal");
  });

  for (const [title, check] of BEFORE_SIGNING) {
    test(`refuses before signing: ${title}`, async () => {
      const before = await balances();
      const end = await tryRefusal(page, title);
      await expect(page).toHaveURL(`/?try=${check}`);
      expect(end.steps).toEqual(LAB_STEPS["check-before-signing"]);
      expect(end.verdict?.badge).toBe("Refused as expected");
      expect(end.verdict?.facts).toMatchObject({
        Code: CHECK_EXPECTED_CODES[check],
        "Refused by": "your spending policy",
        Signed: "nothing",
        "Your balance": "unchanged",
      });
      expect(end.verdict?.txLinks).toEqual([]);
      expect(await balances()).toEqual(before);
      await keepReport(`check-${check}`, false);
      await snapshot(`refusal ${check}`);
    });
  }

  test("refuses a payment past the session budget, after paying the one that fits", async () => {
    const before = await balances();
    const end = await tryRefusal(page, "Session budget used up");
    expect(end.steps).toEqual(LAB_STEPS["check-session-budget"]);
    expect(end.verdict?.facts).toMatchObject({
      Code: CHECK_EXPECTED_CODES["session-budget"],
      Signed: "1 payment",
      "Your balance": "− 0.001 USDC",
    });
    expect(end.verdict?.txLinks).toHaveLength(1);
    expect(end.verdict?.txLinks[0]).toMatch(TX_LINK);
    expect(await balances()).toEqual(paidDemo(before, WEATHER));
    await keepReport("check-session-budget", false);
    await snapshot("refusal session");
  });

  test("refuses private addresses at the relay", async () => {
    const before = await balances();
    const end = await tryRefusal(page, "Private address");
    expect(end.steps).toEqual(LAB_STEPS["check-private-address"]);
    expect(end.verdict?.facts).toMatchObject({
      Code: CHECK_EXPECTED_CODES["private-address"],
      Signed: "nothing",
      "Your balance": "unchanged",
    });
    expect(await balances()).toEqual(before);
    await keepReport("check-private-address", false);
  });

  test("sends the same payment twice and is charged once", async () => {
    const before = await balances();
    const end = await tryRefusal(page, "Send it twice");
    expect(end.steps).toEqual(LAB_STEPS.replay);
    expect(Object.keys(REPLAY_REFUSAL_CODES)).toContain(end.verdict?.facts["Code"]);
    expect(end.verdict?.facts).toMatchObject({ Signed: "1 payment", "Your balance": "− 0.001 USDC" });
    expect(end.verdict?.txLinks).toHaveLength(1);
    expect(await balances()).toEqual(paidDemo(before, WEATHER));
    await keepReport("pay-replay");
    await snapshot("replay");
  });

  test("blocks a seller that charges over the cap: nothing moves", async () => {
    const before = await balances();
    const end = await tryRefusal(page, "Seller charges over the cap");
    expect(end.steps).toEqual(LAB_STEPS.overcharge);
    expect(end.verdict?.facts).toMatchObject({
      Code: OVERCHARGE_REFUSAL_CODE,
      "Refused by": "the facilitator",
      "Your balance": "unchanged",
    });
    expect(end.verdict?.txLinks).toEqual([]);
    expect(await balances()).toEqual(before);
    await keepReport("upto-overcharge");
    await snapshot("overcharge");
  });

  test("never reaches the cloud metadata address, and signs nothing", async () => {
    const before = await balances();
    const end = await runLab(page, "/", { url: "https://169.254.169.254/latest/meta-data/" });
    expect(end.steps).toEqual(LAB_STEPS["egress-refused"]);
    expect(end.verdict?.facts).toMatchObject({
      Code: "egress_destination_not_allowed",
      "Refused by": "the Playground relay",
      Signed: "nothing",
    });
    expect(await balances()).toEqual(before);
    await keepReport("egress-metadata", false);
  });

  test("never follows a redirect to another origin, and signs nothing", async () => {
    const before = await balances();
    const end = await runLab(page, "/", { url: `${stack.redirectorUrl}/pay` });
    expect(end.steps).toEqual(LAB_STEPS["egress-refused"]);
    expect(end.verdict?.facts["Code"]).toMatch(/^egress_/);
    expect(end.verdict?.facts["Signed"]).toBe("nothing");
    expect(await control<{ requests: number }>("/decoy")).toEqual({ requests: 0 });
    expect(await balances()).toEqual(before);
    await snapshot("redirect refused");
  });
});

test.describe("the Bazaar", () => {
  test("lists every listing on one page, with filters whose counts are real", async () => {
    await page.goto("/bazaar");
    const rows = page.locator("li.listing-row");
    await expect(listingRow(page, "hourly_forecast")).toBeVisible();
    await expect(listingRow(page, "/weather")).toBeVisible();
    await expect(listingRow(page, "/history")).toBeVisible();
    const total = await rows.count();
    await expect(page.locator(".bazaar-title .eyebrow")).toHaveText(`Bazaar · ${String(total)} listings`);
    const filters = page.getByRole("group", { name: "Filters" }).getByRole("button");
    for (const chip of await filters.all()) {
      const count = Number(/· (\d+)$/.exec(((await chip.textContent()) ?? "").trim())?.[1]);
      await chip.click();
      await expect(chip).toHaveAttribute("aria-pressed", "true");
      await expect(rows).toHaveCount(count);
    }
    await filters.filter({ hasText: /^MCP tools/ }).click();
    await expect(page).toHaveURL(/filter=mcp/);
    for (const type of await rows.locator(".listing-type").allTextContents()) expect(type).toBe("MCP");
    await filters.filter({ hasText: /^All/ }).click();
    await expect(rows).toHaveCount(total);
    // The scheme badges have one width and centred words.
    const badges = await stylesOf(page, "li.listing-row .scheme-badge", [
      "width",
      "text-align",
      "justify-content",
    ]);
    expect(new Set(badges.map((badge) => badge["width"])).size).toBe(1);
    for (const badge of badges) expect([badge["text-align"], badge["justify-content"]]).toContain("center");
    await snapshot("bazaar");
  });

  test("searches in plain words and keeps the query in the address", async () => {
    await page.goto("/bazaar");
    const search = page.getByRole("searchbox", { name: "Search the Bazaar" });
    await search.fill("current weather for a city");
    await expect(page).toHaveURL(/q=current\+weather/);
    await expect(page.locator("li.listing-row").first()).toContainText("/weather");
    await expect(page.locator(".bazaar-foot")).toContainText("ranked by");
    await search.fill("");
    await expect(page.locator(".bazaar-foot")).toHaveCount(0);
  });

  test("tries an HTTP listing with the wallet, then watches the payment in the Lab", async () => {
    const before = await balances();
    const paid = await payListing(page, {
      query: "current weather for a city",
      shows: "/weather",
      fields: { city: "Izmir" },
    });
    expect(paid.result).toContain("Izmir");
    expect(paid.result).toContain("Paid 0.001 USDC");
    expect(paid.txLink).toMatch(TX_LINK);
    expect(await balances()).toEqual(paidDemo(before, WEATHER));
    await snapshot("bazaar pay http");

    await page.getByRole("link", { name: "Watch this payment in the Lab →" }).click();
    await expect(page).toHaveURL(/\/\?(.+&)?watch=/);
    const end = await labEnd(page);
    expect(end.steps).toEqual(LAB_STEPS["exact-normal"]);
    expect(end.proof?.txLink).toBe(paid.txLink);
    await keepReport("bazaar-http", false);
  });

  test("tries an MCP tool with the arguments it declares, and shows its version history", async () => {
    const before = await balances();
    const paid = await payListing(page, {
      query: "hourly weather forecast",
      shows: "hourly_forecast",
      fields: { city: "Izmir", hours: "6" },
    });
    expect(paid.result).toContain("Izmir");
    expect(paid.result).toContain("Paid 0.0012 USDC");
    expect(paid.txLink).toMatch(TX_LINK);
    expect(await balances()).toEqual(paidDemo(before, FORECAST_SIX_HOURS));

    const panel = page.locator(".listing-panel");
    await panel.getByRole("button", { name: "Version history" }).click();
    await expect(panel.getByRole("region", { name: "Version history" }).locator("li").first()).toBeVisible();
    await snapshot("bazaar pay mcp");

    await page.getByRole("link", { name: "Watch this payment in the Lab →" }).click();
    const end = await labEnd(page);
    expect(end.proof?.txLink).toBe(paid.txLink);
    expect(end.proof?.paid).toBe("0.0012 USDC");
    await keepReport("pay-mcp-listing");
  });

  test("says before paying that a price above the cap will be refused", async () => {
    await page.goto("/bazaar");
    await listingRow(page, "/weather").getByRole("button", { name: /^Try / }).click();
    const panel = page.locator(".listing-panel");
    await panel.getByLabel("Cap", { exact: true }).fill("0.0005");
    await expect(panel.locator(".try-hint")).toContainText("refuse it before signing");
  });
});

test.describe("the guides", () => {
  test("copies the seller's real commands and code", async () => {
    await page.goto("/sell");
    const panel = page.locator(".guide-panel");
    const copied: Record<string, string> = {};
    for (const label of [
      "Copy the install command",
      "Copy the key commands",
      "Copy the seller code",
      "Copy the check command",
    ]) {
      await panel.getByRole("button", { name: label }).click();
      await expect(panel.getByRole("button", { name: label })).toHaveAttribute("data-state", "copied");
      copied[label] = await clipboard();
    }
    expect(copied["Copy the install command"]).toMatch(/^(npm|pnpm) (install|add) /);
    expect(copied["Copy the install command"]).toContain("@rail402.dev/sdk");
    expect(copied["Copy the key commands"]).toContain("rail402 keys new");
    const code = copied["Copy the seller code"] ?? "";
    expect(code).toMatch(/^import /);
    expect(code).toContain(stack.rail402Url);
    expect(code).not.toMatch(/\{\{|@hide/);
    expect(copied["Copy the check command"]).toContain("rail402 seller check");
    // The folded imports open on request and are part of the copy either way.
    const fold = panel.getByRole("button", { name: /imports, copied with the code$/ });
    await fold.click();
    await expect(panel.getByRole("button", { name: /^Hide the \d+ imports$/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await snapshot("sell");
  });

  test("switches the agent client with the tabs, copies its configuration and the prompt", async () => {
    await page.goto("/agents");
    const tabs = page.getByRole("tablist", { name: "Client" });
    await expect(tabs.getByRole("tab", { selected: true })).toHaveText("Claude Desktop");
    await tabs.getByRole("tab", { name: "Cursor" }).click();
    await expect(page.getByRole("tabpanel")).toContainText(".cursor/mcp.json");
    await page.keyboard.press("ArrowRight");
    const claudeCode = tabs.getByRole("tab", { name: "Claude Code" });
    await expect(claudeCode).toHaveAttribute("aria-selected", "true");
    await expect(claudeCode).toBeFocused();
    await page.getByRole("button", { name: "Copy the Claude Code configuration" }).click();
    expect(await clipboard()).toMatch(/^claude mcp add rail402 /);
    await claudeCode.focus();
    await page.keyboard.press("Home");
    await expect(tabs.getByRole("tab", { name: "Claude Desktop" })).toBeFocused();
    await page.getByRole("button", { name: "Copy the Claude Desktop configuration" }).click();
    expect(JSON.parse(await clipboard())).toHaveProperty("mcpServers.rail402");

    await page.getByRole("button", { name: "Copy the prompt" }).click();
    const prompt = ((await page.locator(".guide-prompt p").textContent()) ?? "").replace(/^“|”$/g, "");
    expect(await clipboard()).toBe(prompt);

    await page.getByRole("link", { name: /Watch an agent pay/ }).click();
    await expect(page).toHaveURL("/?mode=agent");
    await expect(page.getByRole("button", { name: /Let an agent pay/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

test("works from the keyboard alone", async () => {
  const before = await balances();
  await page.goto("/");
  await walletAddress(page);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main")).toBeFocused();

  // The mode tiles are buttons: one press picks pay-per-use, and a focus ring shows where focus is.
  const upto = page.getByRole("button", { name: /Pay for what you use/ });
  await upto.focus();
  await page.keyboard.press("Space");
  await expect(upto).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL("/?mode=upto");
  const [ring] = await stylesOf(page, '.mode-tile[data-mode="upto"]', ["outline-style"]);
  expect(ring?.["outline-style"]).not.toBe("none");

  // "Try a refusal" opens on its first choice; Escape closes it and returns focus.
  const refusals = page.getByRole("button", { name: /^Try a refusal/ });
  await refusals.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("group", { name: "Payments that must be refused" });
  await expect(menu.getByRole("button").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(refusals).toBeFocused();

  // Enter in the URL field runs the payment.
  await page.getByLabel("URL to pay").focus();
  await page.keyboard.press("Enter");
  const end = await labEnd(page);
  expect(end.steps).toEqual(LAB_STEPS["upto-normal"]);
  expect(await balances()).toEqual(paidDemo(before, HISTORY_WEEK));

  // The step list moves through the run.
  await endPanel(page).getByRole("button", { name: "See each step" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".inspector .step-count")).toHaveText("Step 01 / 08");
  await page
    .getByRole("list", { name: "Steps" })
    .getByRole("button", { name: /Step 5:/ })
    .focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".inspector .step-count")).toHaveText("Step 05 / 08");

  // The wallet menu opens and closes from the keyboard.
  await walletPill(page).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Test wallet" }).getByRole("heading")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(walletPill(page)).toBeFocused();
});

test("turns its animations off for reduced motion, and still plays every step", async () => {
  const before = await balances();
  await page.emulateMedia({ reducedMotion: "reduce" });
  try {
    await runLab(page, "/");
    const durations = await stylesOf(page, ".inspector .proof .reveal", ["animation-duration"]);
    expect(durations.length).toBeGreaterThan(0);
    for (const duration of durations) expect(duration["animation-duration"]).toBe("0.001s");
    expect(await labSteps(page)).toEqual(LAB_STEPS["exact-normal"]);
    expect(await balances()).toEqual(paidDemo(before, WEATHER));
  } finally {
    await page.emulateMedia({ reducedMotion: "no-preference" });
  }
  const [moving] = await stylesOf(page, ".inspector .proof .reveal", ["animation-duration"]);
  expect(moving?.["animation-duration"]).not.toBe("0.001s");
});

test("never paid from the fee sponsor", async () => {
  expect(await balance(stack.sponsor)).toBe(0n);
});

/**
 * The browser's half of the canary scan. Needles: the wallet's seed (from its key file) and its key
 * bytes, and every payment the page sent (PAYMENT-SIGNATURE to the relay and the lab sellers, MCP
 * `_meta["x402/payment"]`) with its transaction, authorizations, preimages and signatures. A payment
 * may appear only in the request that carried it, and signed transactions only in what the page sent
 * the RPC. Answers from the chain (RPC, Friendbot) are public ledger data and are not scanned.
 * Everything else must be clean: every request and answer, the server's trace-level logs, the console,
 * the page's text after each run, localStorage, sessionStorage, IndexedDB and the run reports.
 */
test("keeps the key and the payments out of every other channel", async () => {
  expect(canarySeed).toMatch(/^S[A-Z2-7]{55}$/);
  await traffic.settled();
  const scanner = new SecretScanner(canarySeed);
  const payments = addPaymentNeedles(scanner, traffic.exchanges, PASSPHRASE);
  // Lab: exact ×3, pasted URL, upto ×2, agent, session, replay (and its resend), overcharge; Bazaar ×2.
  expect(payments).toBeGreaterThanOrEqual(12);
  const chain = { rpcUrl: stack.rpcUrl, friendbotUrl: stack.friendbotUrl };
  // RPC calls and payment-carrying requests are exempt from the payment needles, never from the seed.
  const seedOnly = new SecretScanner(canarySeed);
  captureExchanges(scanner, traffic.exchanges, chain, seedOnly);
  seedOnly.assertClean();
  expect(
    seedFoundInPlantedRpcBody(canarySeed, traffic.exchanges, chain, (seed) => new SecretScanner(seed)),
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
  expect(reports.length).toBeGreaterThanOrEqual(10);
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

test("resets the wallet after a confirmation: the key is deleted and a new wallet is made", async () => {
  await page.goto("/");
  const old = await walletAddress(page);
  const menu = await openWalletMenu(page);
  await menu.getByRole("button", { name: "Reset wallet" }).click();
  const confirm = menu.getByRole("group", { name: "Confirm the reset" });
  await expect(confirm).toContainText("deletes the key from this browser");
  await confirm.getByRole("button", { name: "Reset wallet" }).click();
  const setup = await followSetup(page);
  expect(setup.address).not.toBe(old);
  expect(setup.links).toHaveLength(2);
  expect(await balance(setup.address)).toBe(SETUP_FUNDS);
  // The old wallet keeps its funds on chain; this browser no longer holds it.
  expect(await balance(old)).toBeGreaterThan(0n);
  const stored = await captureStorage(new SecretScanner(canarySeed), page);
  expect(stored).not.toContain(old);
  await page.reload();
  expect(await walletAddress(page)).toBe(setup.address);
});
