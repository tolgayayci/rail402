/**
 * The clean-environment docs check: follows the published seller and buyer quickstarts with nothing
 * but Node.js, npm and the network, then waits for the seller's listing in the Bazaar.
 *
 *   node main.ts [--docs https://docs.rail402.dev | <docs directory>] [--facilitator <url>]
 *                [--public-url https://<host that reaches the seller's port, 4021>]
 *                [--listing-timeout 900] [--out record.json] [--work <dir>]
 *
 * Steps, each timed: fetch the two quickstart pages; install the seller and the buyer exactly as the
 * pages say; create the seller's receiving account and a funded buyer with the pages' own
 * create-account.ts (testnet Friendbot and the testnet exchange); start the page's seller.ts; pay it
 * with the page's buyer.ts; poll /discovery/resources?payTo=… until the resource is listed. Without
 * --public-url the seller runs on localhost, which the Bazaar never lists, and the listing step is
 * recorded as skipped. Secrets live only in the child processes' environment and are never printed or
 * recorded. It needs no checkout of the repository: copy this directory, or use its Dockerfile.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  behindTlsProxy,
  codeBlocks,
  installSteps,
  parseAccount,
  parseSettlement,
  pinnedVersions,
  redactSeeds,
  substitute,
  titledBlock,
  type InstallStep,
} from "./docs.ts";

const PAGES = { seller: "quickstart/sellers", buyer: "quickstart/buyers" } as const;
const DEFAULT_DOCS = "https://docs.rail402.dev";
const DEFAULT_FACILITATOR = "https://testnet.rail402.dev";

interface Step {
  readonly name: string;
  readonly ms: number;
  readonly ok: boolean;
  readonly detail?: unknown;
}

const { values } = parseArgs({
  options: {
    docs: { type: "string", default: DEFAULT_DOCS },
    facilitator: { type: "string" },
    "public-url": { type: "string" },
    "listing-timeout": { type: "string", default: "900" },
    out: { type: "string" },
    work: { type: "string" },
    keep: { type: "boolean", default: false },
  },
  strict: true,
});

const publicUrl = values["public-url"]?.replace(/\/+$/, "");
if (publicUrl !== undefined && !/^https:\/\/[^/]+$/.test(publicUrl)) {
  throw new Error("--public-url is an https origin that reaches the seller's port");
}
const work = values.work ?? mkdtempSync(join(tmpdir(), "rail402-docs-check-"));
const steps: Step[] = [];
const started = Date.now();
const children: ChildProcess[] = [];

async function step<T>(name: string, run: () => Promise<T>, describe?: (value: T) => unknown): Promise<T> {
  const begin = Date.now();
  try {
    const value = await run();
    steps.push({
      name,
      ms: Date.now() - begin,
      ok: true,
      ...(describe === undefined ? {} : { detail: describe(value) }),
    });
    process.stderr.write(`ok    ${name} (${String(Date.now() - begin)} ms)\n`);
    return value;
  } catch (error) {
    const reason = redactSeeds(error instanceof Error ? error.message : String(error));
    steps.push({ name, ms: Date.now() - begin, ok: false, detail: reason });
    process.stderr.write(`fail  ${name}: ${reason}\n`);
    throw error;
  }
}

/** Runs a command to completion; its output is returned, never echoed (it may hold a secret). */
function run(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env?: Record<string, string>; readonly timeoutMs?: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 300_000);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else
        reject(
          new Error(
            `${command} ${args.join(" ")} exited ${String(code)}: ${redactSeeds(output).slice(-800)}`,
          ),
        );
    });
  });
}

/** A page as Markdown: the published `.md` of a docs URL, or the MDX source in a docs directory. */
async function page(path: string): Promise<{ readonly text: string; readonly source: string }> {
  const docs = values.docs;
  if (/^https?:\/\//.test(docs)) {
    const url = `${docs.replace(/\/+$/, "")}/${path}.md`;
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) throw new Error(`${url}: HTTP ${String(response.status)}`);
    return { text: await response.text(), source: url };
  }
  const variables =
    (JSON.parse(readFileSync(join(docs, "docs.json"), "utf8")) as { variables?: Record<string, string> })
      .variables ?? {};
  const file = join(docs, `${path}.mdx`);
  return { text: substitute(readFileSync(file, "utf8"), variables), source: file };
}

async function install(directory: string, plan: readonly InstallStep[]): Promise<void> {
  for (const [tool, ...args] of plan) {
    await run(tool, [...args, ...(args[0] === "install" ? ["--no-audit", "--no-fund"] : [])], {
      cwd: directory,
    });
  }
}

function installedVersion(directory: string, name: string): string | undefined {
  try {
    return (
      JSON.parse(readFileSync(join(directory, "node_modules", name, "package.json"), "utf8")) as {
        version: string;
      }
    ).version;
  } catch {
    return undefined;
  }
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, everyMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check().catch(() => false)) return;
    if (Date.now() > deadline) throw new Error(`gave up after ${String(Math.round(timeoutMs / 1000))} s`);
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}

const record: Record<string, unknown> = {
  kind: "docs-check",
  startedAt: new Date(started).toISOString(),
  docs: values.docs,
  publicUrl: publicUrl ?? null,
  node: process.version,
};
let exitCode = 0;
try {
  const [sellerPage, buyerPage] = await step(
    "fetch the quickstart pages",
    async () => Promise.all([page(PAGES.seller), page(PAGES.buyer)]),
    (pages) => pages.map((item) => item.source),
  );
  const sellerBlocks = codeBlocks(sellerPage.text);
  const buyerBlocks = codeBlocks(buyerPage.text);
  const sellerInstall = installSteps(sellerBlocks, PAGES.seller);
  const buyerInstall = installSteps(buyerBlocks, PAGES.buyer);
  const createAccount = titledBlock(buyerBlocks, "create-account.ts", PAGES.buyer).body;
  let sellerSource = titledBlock(sellerBlocks, "seller.ts", PAGES.seller).body;
  const buyerSource = titledBlock(buyerBlocks, "buyer.ts", PAGES.buyer).body;
  if (publicUrl !== undefined) sellerSource = behindTlsProxy(sellerSource);
  const facilitator =
    values.facilitator ??
    /url: process\.env\.FACILITATOR_URL \?\? "([^"]+)"/.exec(sellerSource)?.[1] ??
    DEFAULT_FACILITATOR;
  record["facilitator"] = facilitator;
  record["pinned"] = { seller: pinnedVersions(sellerInstall), buyer: pinnedVersions(buyerInstall) };

  const sellerDir = join(work, "x402-seller");
  const buyerDir = join(work, "x402-buyer");
  await step("install the seller as the page says", async () => {
    await run("mkdir", ["-p", sellerDir], { cwd: work });
    await install(sellerDir, sellerInstall);
    writeFileSync(join(sellerDir, "seller.ts"), sellerSource);
  });
  await step("install the buyer as the page says", async () => {
    await run("mkdir", ["-p", buyerDir], { cwd: work });
    await install(buyerDir, buyerInstall);
    writeFileSync(join(buyerDir, "create-account.ts"), createAccount);
    writeFileSync(join(buyerDir, "buyer.ts"), buyerSource);
    writeFileSync(join(sellerDir, "create-account.ts"), createAccount);
  });
  record["installed"] = Object.fromEntries(
    ["@x402/express", "@x402/fetch", "@x402/core", "@x402/stellar", "@stellar/stellar-sdk"].map((name) => [
      name,
      installedVersion(name === "@x402/express" ? sellerDir : buyerDir, name) ?? null,
    ]),
  );

  const seller = await step(
    "create the receiving account (create-account.ts, trustline only)",
    async () =>
      parseAccount(await run("node", ["create-account.ts"], { cwd: sellerDir, timeoutMs: 120_000 })),
    (account) => ({ payTo: account.publicKey }),
  );
  const buyer = await step(
    "create a funded buyer (create-account.ts 1)",
    async () =>
      parseAccount(await run("node", ["create-account.ts", "1"], { cwd: buyerDir, timeoutMs: 120_000 })),
    (account) => ({ payer: account.publicKey }),
  );
  record["accounts"] = { payTo: seller.publicKey, payer: buyer.publicKey };

  const port = /app\.listen\((\d+)\)/.exec(sellerSource)?.[1];
  if (port === undefined) throw new Error("seller.ts does not listen on a fixed port");
  record["sellerPort"] = Number(port);
  const local = `http://127.0.0.1:${port}`;
  await step("start seller.ts", async () => {
    const child = spawn("node", ["seller.ts"], {
      cwd: sellerDir,
      env: { ...process.env, PAY_TO: seller.publicKey, FACILITATOR_URL: facilitator },
      stdio: "ignore",
    });
    children.push(child);
    await waitFor(async () => (await fetch(`${local}/weather?city=Ankara`)).status === 402, 60_000, 1_000);
  });

  const resource = `${publicUrl ?? "http://localhost:4021"}/weather?city=Ankara`;
  const settlement = await step(
    "pay with buyer.ts",
    async () =>
      parseSettlement(
        await run("node", ["buyer.ts"], {
          cwd: buyerDir,
          env: { BUYER_SECRET: buyer.secret, RESOURCE_URL: resource },
          timeoutMs: 120_000,
        }),
      ),
    (paid) => paid,
  );
  record["settlement"] = settlement;
  if (settlement.status !== 200 || !settlement.success) throw new Error("the payment did not succeed");

  if (publicUrl === undefined) {
    steps.push({
      name: "wait for the listing",
      ms: 0,
      ok: true,
      detail: "skipped: no --public-url (localhost is never listed)",
    });
  } else {
    const listing = await step(
      "wait for the listing in /discovery/resources",
      async () => {
        let found: unknown;
        await waitFor(
          async () => {
            const url = `${facilitator}/discovery/resources?payTo=${seller.publicKey}&limit=20`;
            const body = (await (await fetch(url)).json()) as {
              items?: {
                resource: string;
                rail402?: { listings?: { id: string; owner: string; trust: string; version: number }[] };
              }[];
            };
            found = body.items
              ?.filter((item) => item.resource.startsWith(`${publicUrl}/weather`))
              .flatMap((item) =>
                (item.rail402?.listings ?? []).filter((entry) => entry.owner === seller.publicKey),
              )[0];
            return found !== undefined;
          },
          Number(values["listing-timeout"]) * 1000,
          10_000,
        );
        return found;
      },
      (value) => value,
    );
    record["listing"] = listing;
  }
} catch {
  exitCode = 1;
} finally {
  for (const child of children) child.kill("SIGTERM");
  record["steps"] = steps;
  record["totalMs"] = Date.now() - started;
  record["ok"] = exitCode === 0;
  const text = `${redactSeeds(JSON.stringify(record, null, 2))}\n`;
  if (values.out !== undefined) writeFileSync(values.out, text);
  process.stdout.write(text);
  if (!values.keep && values.work === undefined) rmSync(work, { recursive: true, force: true });
}
process.exitCode = exitCode;
