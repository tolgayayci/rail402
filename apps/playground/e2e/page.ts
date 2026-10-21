/**
 * What a visitor does on the Playground, through the page only: the wallet the page makes on a first
 * visit, its menu and key file, a Lab run played to its proof or its verdict, a refusal tried from
 * the Lab, and a listing paid from the Bazaar. Every function reads back what the page shows. Shared
 * by the browser tests and the live Playground evidence run; it uses plain Playwright calls only, so
 * it runs with or without the test runner.
 */
import { readFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

/** How long a run may take, from Run to its proof or verdict (chain reads included). */
export const RUN_TIMEOUT_MS = 300_000;
/** How long the first-visit wallet setup may take: a key, Friendbot, a trustline and a purchase. */
export const SETUP_TIMEOUT_MS = 240_000;

const text = async (locator: Locator): Promise<string> => ((await locator.textContent()) ?? "").trim();

/**
 * Runs `body` in the page over the elements a CSS selector matches (`items`) with `names`. The code is
 * sent as text, as the page's DOM types are not loaded in this Node project.
 */
function overElements<T>(page: Page, selector: string, names: readonly string[], body: string): Promise<T> {
  const script = `((items, names) => ${body})([...document.querySelectorAll(${JSON.stringify(selector)})], ${JSON.stringify(names)})`;
  return page.evaluate<T>(script);
}

/** The attributes of each element a CSS selector matches, in the order named; a missing one is "". */
export function attributesOf(page: Page, selector: string, names: readonly string[]): Promise<string[][]> {
  return overElements(
    page,
    selector,
    names,
    "items.map((item) => names.map((name) => item.getAttribute(name) ?? ''))",
  );
}

/** The computed style properties of each element a CSS selector matches, by name. */
export function stylesOf(
  page: Page,
  selector: string,
  properties: readonly string[],
): Promise<Record<string, string>[]> {
  return overElements(
    page,
    selector,
    properties,
    "items.map((item) => { const style = getComputedStyle(item); return Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name)])); })",
  );
}

/** The text the clipboard holds (the context must grant clipboard-read). */
export async function clipboardText(page: Page): Promise<string> {
  return String(await page.evaluate("navigator.clipboard.readText()"));
}

const HASH_LINK = /\/tx\/([0-9a-f]{64})$/;

/** The transaction hash of an explorer link's href. */
export function hashOfLink(href: string): string {
  const hash = HASH_LINK.exec(href)?.[1];
  if (hash === undefined) throw new Error(`not an explorer transaction link: ${href}`);
  return hash;
}

// --- wallet -----------------------------------------------------------------------------------------

/** What the first-visit dialog showed while it made the wallet. */
export interface SetupResult {
  readonly address: string;
  /** The explorer links of the setup transactions, in the order the dialog showed them. */
  readonly links: readonly string[];
  /** The dialog's titles, in the order they appeared. */
  readonly titles: readonly string[];
}

/**
 * Follows the wallet dialog from its first frame until it closes on its own, collecting the setup
 * transactions' links while they show (the dialog closes shortly after the last step). Throws with the
 * dialog's code and reason when the setup stops.
 */
export async function followSetup(page: Page, timeoutMs = SETUP_TIMEOUT_MS): Promise<SetupResult> {
  const dialog = page.locator(".wallet-dialog[role=dialog]");
  await dialog.waitFor({ state: "visible", timeout: 60_000 });
  const links: string[] = [];
  const titles: string[] = [];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await dialog.getAttribute("data-status", { timeout: 1_000 }).catch(() => null);
    if (status === null) break;
    // The dialog may close between two reads: each one waits a moment only, never for good.
    const title = (
      (await dialog
        .locator("#wallet-dialog-title")
        .textContent({ timeout: 1_000 })
        .catch(() => "")) ?? ""
    ).trim();
    if (title !== "" && titles.at(-1) !== title) titles.push(title);
    const hrefs = await attributesOf(page, ".wallet-dialog a.setup-tx", ["href"]).catch(() => []);
    for (const [href = ""] of hrefs) if (href !== "" && !links.includes(href)) links.push(href);
    if (status === "failed") {
      const notice = (
        (await dialog
          .locator(".notice")
          .textContent({ timeout: 1_000 })
          .catch(() => "")) ?? ""
      ).trim();
      throw new Error(`the wallet setup stopped: ${notice}`);
    }
    if (Date.now() > deadline) throw new Error(`the wallet setup took longer than ${String(timeoutMs)} ms`);
    await page.waitForTimeout(150);
  }
  return { address: await walletAddress(page), links, titles };
}

/** The wallet pill in the header. */
export const walletPill = (page: Page): Locator => page.locator("#wallet-pill");

/** The wallet's address, from the header pill once the wallet is ready. */
export async function walletAddress(page: Page): Promise<string> {
  const pill = walletPill(page);
  await pill.and(page.locator('[data-status="ready"]')).waitFor({ timeout: 60_000 });
  const label = (await pill.getAttribute("aria-label")) ?? "";
  const address = /^Test wallet (G[A-Z2-7]{55})$/.exec(label)?.[1];
  if (address === undefined) throw new Error(`the wallet pill names no address: ${label}`);
  return address;
}

/** Opens the wallet menu from the pill and returns it. */
export async function openWalletMenu(page: Page): Promise<Locator> {
  const menu = page.getByRole("dialog", { name: "Test wallet" });
  if (!(await menu.isVisible())) await walletPill(page).click();
  await menu.waitFor({ state: "visible" });
  return menu;
}

/** Closes the wallet menu with Escape, which hands focus back to the pill. */
export async function closeWalletMenu(page: Page): Promise<void> {
  const menu = page.getByRole("dialog", { name: "Test wallet" });
  if (await menu.isVisible()) await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
}

/**
 * Saves the key file from the wallet menu, after its confirmation, and returns the seed it holds: the
 * key is never shown on the page, only written to this file.
 */
export async function exportKeyFile(page: Page): Promise<{ readonly seed: string; readonly name: string }> {
  const menu = await openWalletMenu(page);
  await menu.getByRole("button", { name: /download the key file$/ }).click();
  const confirm = menu.getByRole("group", { name: "Confirm the key download" });
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    confirm.getByRole("button", { name: "Download the key file" }).click(),
  ]);
  const saved = readFileSync(await download.path(), "utf8").trim();
  const seed = /\bS[A-Z2-7]{55}\b/.exec(saved)?.[0];
  if (seed === undefined) throw new Error("the key file holds no secret seed");
  await menu.getByRole("status").filter({ hasText: "Saved as" }).waitFor();
  await closeWalletMenu(page);
  return { seed, name: download.suggestedFilename() };
}

// --- the Lab ------------------------------------------------------------------------------------------

/** What the inspector shows at the end of a run: the proof of a payment, or a verdict. */
export interface LabEnd {
  /** Each swimlane row as `step lane look`, in drawing order. */
  readonly steps: readonly string[];
  readonly proof: ProofShown | undefined;
  readonly verdict: VerdictShown | undefined;
}

export interface ProofShown {
  /** `0.001 USDC`. */
  readonly paid: string;
  readonly txLink: string;
  /** The proof's tiles, such as `0.0079 of your cap never taken`. */
  readonly tiles: readonly string[];
  /** Role and what each party did, such as `Seller: received 0.001 USDC`. */
  readonly parties: readonly string[];
}

export interface VerdictShown {
  readonly badge: string;
  readonly title: string;
  /** The verdict's facts: Code, Refused by, Signed, Your balance, Expected. */
  readonly facts: Readonly<Record<string, string>>;
  readonly txLinks: readonly string[];
}

/** The stage's swimlane rows as `step lane look`. */
export async function labSteps(page: Page): Promise<string[]> {
  const rows = await attributesOf(page, ".swimlane-steps li.lane-step", [
    "data-step",
    "data-lane",
    "data-look",
  ]);
  return rows.map((row) => row.join(" "));
}

/** The inspector's end panel: a proof or a verdict. */
export function endPanel(page: Page): Locator {
  return page.locator(".inspector").locator(".proof, .verdict");
}

/** Waits for the run on the stage to end (every step played) and reads what it shows. */
export async function labEnd(page: Page, timeoutMs = RUN_TIMEOUT_MS): Promise<LabEnd> {
  await endPanel(page).first().waitFor({ state: "visible", timeout: timeoutMs });
  const steps = await labSteps(page);
  const proofPanel = page.locator(".inspector .proof");
  if ((await proofPanel.count()) > 0) {
    return { steps, proof: await readProof(proofPanel), verdict: undefined };
  }
  return { steps, proof: undefined, verdict: await readVerdict(page.locator(".inspector .verdict")) };
}

async function readProof(panel: Locator): Promise<ProofShown> {
  const paid = (await text(panel.locator(".proof-number"))).replace(/\s+/g, " ");
  const txLink = (await panel.locator("a.proof-tx").getAttribute("href")) ?? "";
  // Each tile is a bold figure followed by its words.
  const tiles: string[] = [];
  for (const tile of await panel.locator(".proof-tile").all()) {
    const figure = await text(tile.locator("b"));
    const words = (await text(tile)).slice(figure.length);
    tiles.push(`${figure} ${words}`.replace(/\s+/g, " ").trim());
  }
  const parties: string[] = [];
  for (const party of await panel.locator(".proof-party").all()) {
    parties.push(
      `${await text(party.locator(".proof-party-role"))}: ${await text(party.locator(".proof-party-did"))}`,
    );
  }
  return { paid, txLink, tiles, parties };
}

async function readVerdict(panel: Locator): Promise<VerdictShown> {
  const facts: Record<string, string> = {};
  for (const fact of await panel.locator("dl.fact-list > .fact").all()) {
    facts[await text(fact.locator("dt"))] = (await text(fact.locator("dd"))).replace(/\s+/g, " ");
  }
  const txLinks: string[] = [];
  for (const link of await panel.locator(".verdict-txs a").all()) {
    const href = await link.getAttribute("href");
    if (href !== null) txLinks.push(href);
  }
  return {
    badge: await text(panel.locator(".verdict-eyebrow span")),
    title: await text(panel.locator(".verdict-title")),
    facts,
    txLinks,
  };
}

/** The Lab's Run button, by its words before, during and after a run. */
export const runButton = (page: Page): Locator =>
  page.getByRole("button", { name: /^(Run|Run again|Running)$/ });

/**
 * Opens the Lab on `path` (`/`, `/?mode=upto`, `/?mode=agent`), fills the URL and the cap when given,
 * runs it, and waits for its end.
 */
export async function runLab(
  page: Page,
  path: string,
  fill: { readonly url?: string; readonly cap?: string } = {},
): Promise<LabEnd> {
  await page.goto(path);
  await walletAddress(page);
  if (fill.url !== undefined) await page.getByLabel("URL to pay").fill(fill.url);
  if (fill.cap !== undefined) await page.getByLabel("Cap").fill(fill.cap);
  await runButton(page).click();
  return labEnd(page);
}

/** Opens the Lab, chooses a refusal from "Try a refusal" (which runs it at once) and waits for its end. */
export async function tryRefusal(page: Page, title: string): Promise<LabEnd> {
  await page.goto("/");
  await walletAddress(page);
  await page.getByRole("button", { name: /^Try a refusal/ }).click();
  const menu = page.getByRole("group", { name: "Payments that must be refused" });
  await menu.getByRole("button", { name: new RegExp(`^${title}\\b`) }).click();
  return labEnd(page);
}

/** Saves the shown run's report through the end panel's button and returns its text. */
export async function saveReport(page: Page): Promise<string> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    endPanel(page).getByRole("button", { name: "Save the run report" }).click(),
  ]);
  const saved = readFileSync(await download.path(), "utf8");
  const report = JSON.parse(saved) as { format?: unknown };
  if (report.format !== "rail402-playground-run") throw new Error("the download is not a run report");
  return saved;
}

// --- the Bazaar ---------------------------------------------------------------------------------------

/** What paying a listing from the Bazaar's panel showed. */
export interface BazaarPayment {
  /** The result card's text. */
  readonly result: string;
  /** The transaction link of a paid call, or the links a refusal showed. */
  readonly txLink: string | undefined;
  /** The code of a refused call. */
  readonly code: string | undefined;
}

/** A listing's row in the Bazaar, by a text it shows (its name or URL). */
export function listingRow(page: Page, shows: string | RegExp): Locator {
  return page.locator("li.listing-row").filter({ hasText: shows }).first();
}

/**
 * Searches the Bazaar in plain words, presses Try on the first row showing `shows`, fills the
 * listing's form, pays it and waits for the result card.
 */
export async function payListing(
  page: Page,
  options: {
    readonly query: string;
    readonly shows: string | RegExp;
    readonly fields: Readonly<Record<string, string>>;
    readonly cap?: string;
  },
): Promise<BazaarPayment> {
  await page.goto("/bazaar");
  await walletAddress(page);
  await page.getByRole("searchbox", { name: "Search the Bazaar" }).fill(options.query);
  const row = listingRow(page, options.shows);
  await row.waitFor({ state: "visible", timeout: 60_000 });
  await row.getByRole("button", { name: /^Try / }).click();
  const panel = page.locator(".listing-panel");
  for (const [name, value] of Object.entries(options.fields)) {
    await panel.getByLabel(new RegExp(`^${name}\\b`)).fill(value);
  }
  if (options.cap !== undefined) await panel.getByLabel("Cap", { exact: true }).fill(options.cap);
  await panel.getByRole("button", { name: /^Pay .* and call$/ }).click();
  const result = panel.locator(".try-outcome .try-result");
  await result.waitFor({ state: "visible", timeout: RUN_TIMEOUT_MS });
  const link = result.locator("a.try-tx").first();
  const code = result.locator(".try-result-code code");
  return {
    result: (await text(result)).replace(/\s+/g, " "),
    txLink: (await link.count()) > 0 ? ((await link.getAttribute("href")) ?? undefined) : undefined,
    code: (await code.count()) > 0 ? await text(code) : undefined,
  };
}
