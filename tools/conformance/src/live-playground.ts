/**
 * Live Playground run on the public Stellar testnet: Chromium drives the Playground's real page, as a
 * visitor would. A test wallet is imported and funded through the wallet panel; every lab scenario
 * and experiment runs (pay with `exact`, a cap below the price, the same payment sent twice, pay per
 * use with `upto`, a seller charging over the cap, an agent paying an MCP tool, selling through the
 * sandbox route); the refusal checks run from the Pay page; private addresses and a cross-origin
 * redirect are refused. Every transaction the page shows is read back from the chain in Node and
 * proven to open in stellar.expert; every refusal is checked to leave the payer's balance where it
 * was; and a canary scan finds neither the wallet's key nor any payment in anything the browser sent,
 * stored, logged or showed.
 *
 *   node --conditions=@rail402/source tools/conformance/src/live-playground.ts [--skip-build] \
 *     [--only id,id] [--bazaar https://… --seller https://… [--pay-to G…] | --playground https://…] \
 *     [--write [--allow-branch <branch>]]
 *
 * Three ways to run it:
 * - local (the default), a rehearsal whose services live only as long as the run: Rail402
 *   (apps/rail402) as a local process in memory against the public testnet RPC, with a
 *   Friendbot-funded fee sponsor and loopback discovery; the demo seller (apps/demo-seller) on
 *   loopback; and the Playground server in local mode, its lab sellers paid to a fresh account. The
 *   demo seller's MCP tool is paid once by a separate buyer first, so the Bazaar lists it for the
 *   agent. Needs no secrets.
 * - hosted, local page (`--bazaar` and `--seller`): the Playground server runs here, in its hosted
 *   configuration, against a deployed Rail402 and demo seller. Its lab sellers are paid to `--pay-to`
 *   (a fresh account when it is not given). They listen on this machine, which a hosted catalog
 *   refuses to reach, so the sandbox listing and the redirect case are skipped.
 * - deployed (`--playground`): a Playground that is already running, read from its `/api/config`.
 *
 * The page is the production build (`vite build`, skipped with --skip-build or --playground), served
 * by the Playground server with its real CSP. Without --write the evidence document is printed; with
 * --write it is recorded, from a clean commit on main, as
 * tools/conformance/evidence/live-playground-local-stellar-testnet.json (local) or
 * tools/conformance/evidence/live-playground-stellar-testnet.json (against a deployed Rail402).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ok, strictEqual } from "node:assert/strict";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { Keypair, Operation, StrKey, rpc } from "@stellar/stellar-sdk";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { METERED_PRICES, PRICES, createSeller } from "@rail402.dev/demo-seller";
import { KeyHolder, createBuyer, exactScheme, inspectTransaction, uptoScheme } from "@rail402.dev/sdk";
import { TESTNET } from "@rail402.dev/stellar";
import { LocalNetwork, SecretScanner, ServiceProcess, startDecoyOrigin } from "@rail402.dev/testkit";
import {
  CONFIG_PATH,
  parsePublicConfig,
  type PublicConfig,
} from "../../../apps/playground/src/shared/public-config.ts";
import {
  CHECK_EXPECTED_CODES,
  LAB_PRICES,
  PRIVATE_ADDRESS_TARGETS,
} from "../../../apps/playground/src/shared/lab.ts";
import { LAB_BADGES, LAB_ROWS } from "../../../apps/playground/e2e/expected.ts";
import {
  Traffic,
  addPaymentNeedles,
  captureExchanges,
  seedFoundInPlantedRpcBody,
  captureStorage,
  samplePaymentHeader,
  uncodedRelayFailures,
  watchProblems,
  type PageProblem,
} from "../../../apps/playground/e2e/support.ts";
import {
  EVIDENCE_DIR,
  evidenceFileName,
  harnessProvenance,
  recheckProvenance,
  writeEvidence,
  type EvidenceRejection,
} from "./evidence.ts";
import {
  CaseRecorder,
  baseUrl,
  buildEvidence,
  readTarget,
  settledTransaction,
  supportedSigners,
  type CaseContext,
  type CaseSpec,
} from "./harness.ts";
import { checkStellarExpert, type ExplorerCheck } from "./live-agent-checks.ts";
import { livePlaygroundProblems } from "./live-playground-checks.ts";
import {
  hashOfLink,
  importAndFund,
  lastRefusal,
  meterLabel,
  payUrl,
  reconcileNow,
  reportedTransactions,
  runCheck,
  runLab,
  sdkEventCount,
  until,
  type CheckTitleId,
  type LabResult,
  type RunReport,
} from "./live-playground-page.ts";
import {
  NETWORK,
  TESTNET_FRIENDBOT_URL,
  TESTNET_RPC_URL,
  Treasury,
  USDC,
  gitCommit,
  log,
  versions,
} from "./testnet.ts";

const { values: args } = parseArgs({
  options: {
    "skip-build": { type: "boolean", default: false },
    only: { type: "string" },
    write: { type: "boolean", default: false },
    "allow-branch": { type: "string" },
    bazaar: { type: "string" },
    seller: { type: "string" },
    "pay-to": { type: "string" },
    playground: { type: "string" },
  },
});

type Mode = "local" | "hosted" | "deployed";
const mode: Mode =
  args.playground !== undefined
    ? "deployed"
    : args.bazaar !== undefined || args.seller !== undefined
      ? "hosted"
      : "local";
const httpsUrl = (flag: string, value: string | undefined): string => {
  if (value === undefined || !URL.canParse(value) || new URL(value).protocol !== "https:") {
    throw new Error(`${flag} must be an https URL`);
  }
  return baseUrl(value);
};
if (mode === "deployed" && (args.bazaar !== undefined || args.seller !== undefined)) {
  throw new Error(
    "--playground reads its Rail402 and demo seller from the Playground: drop --bazaar and --seller",
  );
}
const hostedUrls =
  mode === "hosted"
    ? { bazaar: httpsUrl("--bazaar", args.bazaar), seller: httpsUrl("--seller", args.seller) }
    : undefined;
const deployedUrl = mode === "deployed" ? httpsUrl("--playground", args.playground) : undefined;
if (args["pay-to"] !== undefined && (mode !== "hosted" || !StrKey.isValidEd25519PublicKey(args["pay-to"]))) {
  throw new Error("--pay-to takes a G… account, with --bazaar and --seller");
}

// Evidence is recorded only from a clean commit on main, checked before any testnet funds are spent.
const provenance = args.write ? harnessProvenance({ allowBranch: args["allow-branch"] }) : undefined;

// Standard output carries the evidence document only.
console.log = (...values: unknown[]) => {
  console.error(...values);
};

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PLAYGROUND = join(ROOT, "apps/playground");
const PASSPHRASE = "Test SDF Network ; September 2015";
const DECIMALS = 7;
/** How long the Bazaar may take to list the primed MCP tool (settlement, then the origin check). */
const CATALOG_WAIT_MS = 180_000;
/** How long a refused hold may take to come back: the greedy route's 60 s expiry plus reconciliation. */
const RELEASE_WAIT_MS = 300_000;

const atomic = (amount: string): bigint => {
  const [whole = "0", fraction = ""] = amount.split(".");
  return BigInt(whole) * 10n ** BigInt(DECIMALS) + BigInt(fraction.padEnd(DECIMALS, "0"));
};
/** Demo seller prices of the runs, in base units. */
const WEATHER = atomic(PRICES.weather);
const HISTORY_WEEK = 7n * atomic(METERED_PRICES.perDay);
const FORECAST_SIX_HOURS = 6n * atomic(METERED_PRICES.perHour);
const SELL = BigInt(LAB_PRICES.sell.atomic);

// --- services ---------------------------------------------------------------------------------------

interface Services {
  /** The Playground's origin, as the browser opens it. */
  readonly playgroundUrl: string;
  /** The Playground server this run started; undefined against a deployed one. */
  readonly server: ServiceProcess | undefined;
  /** A loopback seller that redirects every call to the decoy origin; local runs only. */
  readonly redirect: { readonly url: string; readonly decoyRequests: () => number } | undefined;
  /** The fee sponsor of a local Rail402. */
  readonly sponsor: string | undefined;
  readonly treasury: string | undefined;
  readonly cleanups: (() => Promise<void>)[];
}

/** The Playground server as a child process: the page's production build, its real headers and CSP. */
async function startPlayground(env: Record<string, string>, publicHost: string): Promise<ServiceProcess> {
  const port = await freePort();
  const server = await ServiceProcess.start({
    entry: join(PLAYGROUND, "src/main.ts"),
    port,
    env: { PUBLIC_URL: `http://${publicHost}:${String(port)}`, LOG_LEVEL: "trace", ...env },
  });
  await server.waitForLog("rail402-playground listening", 60_000);
  return server;
}

/**
 * Local: Rail402, the demo seller and the Playground server on this machine, on the public testnet.
 * The demo seller's MCP tool is paid once first, so the Bazaar lists it for the agent scenario.
 */
async function startLocal(net: LocalNetwork): Promise<Services> {
  const cleanups: (() => Promise<void>)[] = [];
  const sponsor = Keypair.random();
  log("funding the fee sponsor with Friendbot");
  await net.fund(sponsor);
  const models = join(ROOT, ".models");
  log("starting Rail402 against the public testnet RPC");
  const rail402 = await ServiceProcess.start({
    entry: join(ROOT, "apps/rail402/src/main.ts"),
    env: {
      STORE: "memory",
      TESTNET_RPC_URL,
      TESTNET_SPONSOR_SECRET: sponsor.secret(),
      TESTNET_CHANNEL_COUNT: "2",
      TESTNET_MAX_TX_FEE_STROOPS: "1000000",
      TESTNET_MIN_SPONSOR_BALANCE_XLM: "1",
      RATE_LIMIT_PER_MINUTE: "0",
      DISCOVERY_ALLOW_LOOPBACK: "true",
      ORIGIN_CHECK_INTERVAL_MS: "3000",
      SEARCH_EMBEDDINGS: String(existsSync(models)),
      SEARCH_MODEL_DIR: models,
      RAIL402_VERSION: `${versions(["@rail402.dev/playground"])["@rail402.dev/playground"] ?? "local"}+${gitCommit().slice(0, 12)}`,
    },
  });
  cleanups.push(() => rail402.kill("SIGTERM").then(() => undefined));
  await rail402.listening(180_000);
  await until(
    async () =>
      (await fetch(`${rail402.url}/ready`).catch(() => undefined))?.status === 200 ? true : undefined,
    "Rail402 to become ready",
    180_000,
    2_000,
  );

  log("opening a treasury: Friendbot XLM and USDC from the testnet exchange");
  const treasury = await new Treasury(net).open("1");
  const [demoPayTo, labPayTo] = await treasury.accounts(2, "0");
  const [primerKey] = await treasury.accounts(1, "0.05");
  if (demoPayTo === undefined || labPayTo === undefined || primerKey === undefined)
    throw new Error("no accounts");

  const seller: Server = createSeller({
    payTo: demoPayTo.publicKey(),
    facilitator: new HTTPFacilitatorClient({ url: rail402.url }),
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => seller.once("listening", resolve));
  cleanups.push(() => closeServer(seller));
  const sellerPort = (seller.address() as AddressInfo).port;
  const demoUrl = `http://127.0.0.1:${String(sellerPort)}`;

  // The agent finds the tool in the Bazaar: its first settlement, by any buyer, lists it.
  log("paying the demo seller's MCP tool once so the Bazaar lists it");
  const primer = await createBuyer({
    network: TESTNET,
    signer: KeyHolder.fromSecret(primerKey.secret()),
    rpcUrl: TESTNET_RPC_URL,
    bazaarUrl: rail402.url,
    facilitatorUrl: rail402.url,
    egress: { schemes: ["http:"], ports: [sellerPort], allowPrivateNetwork: "loopback" },
    schemes: [exactScheme(), uptoScheme()],
  });
  try {
    await primer.pay(
      {
        kind: "mcp",
        url: `${demoUrl}/mcp`,
        toolName: "hourly_forecast",
        arguments: { city: "Ankara", hours: 1 },
      },
      { maxAmount: { amount: "0.01", asset: "USDC" } },
    );
    await until(
      async () => {
        const page = await primer.search("hourly weather forecast", { type: "mcp" });
        return page.hits.some(
          (hit) => hit.toolName === "hourly_forecast" && hit.listingId !== null && hit.trust !== "settled",
        )
          ? true
          : undefined;
      },
      "the Bazaar to list the demo seller's tool",
      CATALOG_WAIT_MS,
      3_000,
    );
  } finally {
    await primer.close();
  }

  const decoy = await startDecoyOrigin();
  cleanups.push(() => decoy.close());
  const redirector: Server = createServer((_request, response) => {
    response.writeHead(302, { location: `${decoy.url}/collect` }).end();
  });
  await new Promise<void>((resolve) => redirector.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => closeServer(redirector));

  const server = await startPlayground(
    {
      PLAYGROUND_MODE: "local",
      FACILITATOR_URL: rail402.url,
      BAZAAR_URL: rail402.url,
      DEMO_SELLER_URL: demoUrl,
      PLAYGROUND_PAY_TO: labPayTo.publicKey(),
    },
    "127.0.0.1",
  );
  cleanups.push(() => server.kill().then(() => undefined));
  return {
    playgroundUrl: server.url,
    server,
    redirect: {
      url: `http://127.0.0.1:${String((redirector.address() as AddressInfo).port)}`,
      decoyRequests: () => decoy.requests.length,
    },
    sponsor: sponsor.publicKey(),
    treasury: treasury.keypair.publicKey(),
    cleanups,
  };
}

/**
 * Hosted, local page: the Playground server here, in its hosted configuration, against a deployed
 * Rail402 and demo seller. Its origin is `localhost`, so the private-address targets on 127.0.0.1 are
 * judged as any other private address, not as the Playground calling itself.
 */
async function startHostedPage(
  net: LocalNetwork,
  urls: { readonly bazaar: string; readonly seller: string },
): Promise<Services> {
  let payTo = args["pay-to"];
  if (payTo === undefined) {
    // A fresh lab account with a USDC trustline; its seed is not kept.
    const account = Keypair.random();
    await net.fund(account);
    await net.classic(account, [Operation.changeTrust({ asset: USDC })]);
    payTo = account.publicKey();
  }
  const server = await startPlayground(
    {
      FACILITATOR_URL: urls.bazaar,
      BAZAAR_URL: urls.bazaar,
      DEMO_SELLER_URL: urls.seller,
      PLAYGROUND_PAY_TO: payTo,
    },
    "localhost",
  );
  return {
    playgroundUrl: `http://localhost:${String(server.port)}`,
    server,
    redirect: undefined,
    sponsor: undefined,
    treasury: undefined,
    cleanups: [() => server.kill().then(() => undefined)],
  };
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await closeServer(server);
  return port;
}

/** Builds the page's production bundle, which the Playground server serves. */
function buildPage(): void {
  log("building the page (vite build)");
  const build = spawnSync("pnpm", ["--filter", "@rail402.dev/playground", "build"], {
    cwd: ROOT,
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (build.status !== 0) throw new Error("vite build failed; see its output above");
}

// --- the run ------------------------------------------------------------------------------------------

async function main() {
  if (mode !== "deployed" && !args["skip-build"]) buildPage();
  const net = new LocalNetwork(TESTNET_RPC_URL, TESTNET_FRIENDBOT_URL);
  const recorder = new CaseRecorder(args.only?.split(",").map((id) => id.trim()));
  const services: Services =
    mode === "local"
      ? await startLocal(net)
      : mode === "hosted" && hostedUrls !== undefined
        ? await startHostedPage(net, hostedUrls)
        : {
            playgroundUrl: deployedUrl ?? "",
            server: undefined,
            redirect: undefined,
            sponsor: undefined,
            treasury: undefined,
            cleanups: [],
          };
  let browser: Browser | undefined;
  try {
    const config = await readConfig(services.playgroundUrl);
    strictEqual(config.network, NETWORK, "the Playground serves the testnet");
    const payTo = config.lab.payTo;
    const target = await readTarget(config.urls.facilitator, mode === "local" ? "local" : "hosted");
    const signers = new Set([
      ...supportedSigners(target.supported),
      ...(
        (target.supported as { kinds?: { extra?: { facilitatorAddress?: unknown } }[] }).kinds ?? []
      ).flatMap((kind) =>
        typeof kind.extra?.facilitatorAddress === "string" ? [kind.extra.facilitatorAddress] : [],
      ),
    ]);
    const demoPayTo = await livePayTo(`${config.urls.demoSeller}/weather?city=Ankara`);
    const rpcServer = new rpc.Server(config.urls.rpc);
    const explorerLink = (hash: string) =>
      config.explorerTemplate.replace("{network}", "testnet").replace("{hash}", hash);

    browser = await chromium.launch();
    const context: BrowserContext = await browser.newContext({
      baseURL: services.playgroundUrl,
      acceptDownloads: true,
    });
    const traffic = new Traffic(context);
    const page: Page = await context.newPage();
    const problems: PageProblem[] = [];
    const consoleLines = watchProblems(page, "main", problems);
    const domTexts: { name: string; text: string }[] = [];
    const reports: { name: string; text: string }[] = [];
    const explorerHashes = new Map<string, string>();

    const canary = Keypair.random();
    const payer = canary.publicKey();
    const balance = (account: string) => net.tokenBalance(config.asset.contract, account);
    const snapshot = async (name: string) => {
      domTexts.push({ name, text: await page.locator("body").innerText() });
    };
    /** The page logged no error and broke no CSP rule during the case. */
    const noProblems = () => {
      const found = problems.splice(0);
      strictEqual(found.length, 0, `console errors, page errors or CSP violations: ${JSON.stringify(found)}`);
    };
    const spec = (
      id: string,
      title: string,
      checks: CaseSpec["checks"],
      scheme?: "exact" | "upto",
    ): CaseSpec => ({
      id,
      title,
      checks: ["playground", ...checks],
      ...(scheme === undefined ? {} : { scheme, asset: config.asset.symbol, payer: "G", payTo: "G" }),
    });

    /**
     * A settled payment the page showed: its link is the configured explorer's, the run reported the
     * same transaction, and the chain, read here, shows the payer paying `amount` to `to` with the fee
     * paid by the facilitator.
     */
    const settled = async (
      context: CaseContext,
      /** A check's result has no report of its own: its link is checked against the chain only. */
      result: { txLink: string | undefined; report?: RunReport },
      expected: { scheme: "exact" | "upto"; amount: bigint; to: string },
    ) => {
      ok(result.txLink !== undefined, "the outcome links the transaction");
      const hash = hashOfLink(result.txLink);
      strictEqual(result.txLink, explorerLink(hash), "the link uses the configured explorer");
      if (result.report !== undefined) {
        ok(reportedTransactions(result.report).includes(hash), "the run reported the transaction it links");
      }
      const transaction = await settledTransaction(net, hash, {
        scheme: expected.scheme,
        asset: config.asset.contract,
        decimals: config.asset.decimals,
        amount: expected.amount,
        payerType: "G",
      });
      ok(
        transaction.transfers.some(
          (transfer) =>
            transfer.from === payer &&
            transfer.to === expected.to &&
            transfer.amount === expected.amount.toString(),
        ),
        `the chain shows ${expected.amount.toString()} from the payer to ${expected.to}`,
      );
      ok(signers.has(transaction.feeSource), "the fee was paid by an account the facilitator advertises");
      const inspected = await inspectTransaction(hash, {
        network: TESTNET,
        server: rpcServer,
        facilitator: { url: config.urls.facilitator },
      });
      strictEqual(inspected.x402.shape, expected.scheme, "the transaction has the shape of the scheme");
      context.transaction(transaction);
      context.observe("feeSourceAdvertised", inspected.facilitator?.attributed ?? null);
      explorerHashes.set(hash, result.txLink);
      return hash;
    };

    /** A refusal the page reported: its code and layer, nothing reserved or signed, no balance moved. */
    const refusedRun = (context: CaseContext, report: RunReport, operation: string, code: string) => {
      const refusal = lastRefusal(report);
      const summary = report.summary;
      strictEqual(summary?.code, code, "the run ended with the expected code");
      const reason = summary.reason ?? "";
      ok(reason.trim() !== "", "the run gave a reason");
      const rejection: EvidenceRejection = {
        surface: refusal?.layer === "facilitator" ? "facilitator" : "http",
        operation,
        code,
        reason,
      };
      context.rejection(rejection);
      context.observe("layer", refusal?.layer ?? null);
      return refusal;
    };

    const lab = async (name: string, scenario: string, experiment: string): Promise<LabResult> => {
      const result = await runLab(page, scenario, experiment);
      reports.push({ name, text: result.reportText });
      await snapshot(name);
      return result;
    };

    // --- onboarding -----------------------------------------------------------------------------------
    await recorder.run(
      spec(
        "onboarding",
        "The wallet panel imports a testnet key and sets it up: Friendbot, a USDC trustline, USDC from the testnet exchange",
        [],
      ),
      async (context) => {
        const links = await importAndFund(page, canary.secret(), payer);
        strictEqual(links.length, 3, "three setup transactions");
        const classic = [];
        for (const link of links) {
          const hash = hashOfLink(link);
          strictEqual(link, explorerLink(hash));
          const response = await rpcServer.getTransaction(hash);
          strictEqual(response.status, rpc.Api.GetTransactionStatus.SUCCESS, `${hash} succeeded`);
          classic.push({ hash, ledger: response.ledger, explorerUrl: link });
          explorerHashes.set(hash, link);
        }
        strictEqual(
          await balance(payer),
          atomic(config.onboarding.buyAmount),
          "the wallet holds the bought USDC",
        );
        await snapshot("onboarding");
        noProblems();
        context.observe("payer", payer);
        context.observe("classicTransactions", classic);
      },
    );
    const funded = (await balance(payer).catch(() => 0n)) > 0n;
    if (!funded) throw new Error("the wallet could not be funded; nothing else can run");

    // --- lab: pay for an API --------------------------------------------------------------------------
    await recorder.run(
      spec(
        "pay-exact",
        "Lab, pay for an API: one exact payment, settled on chain and sponsored",
        ["scheme-exact", "fees-sponsored"],
        "exact",
      ),
      async (context) => {
        const before = await balance(payer);
        const result = await lab("pay-normal", "pay", "normal");
        assertRows(result, LAB_ROWS["pay-normal"], LAB_BADGES["pay-normal"]);
        await settled(context, result, { scheme: "exact", amount: WEATHER, to: demoPayTo });
        strictEqual(await balance(payer), before - WEATHER, "the payer paid the price once");
        strictEqual(sdkEventCount(result.report, "signed"), 1, "one authorization was signed");
        noProblems();
        context.observe("rows", result.rows);
      },
    );

    await recorder.run(
      spec(
        "cap-below-price",
        "Lab: a per-call cap below the price is refused before anything is signed",
        ["rejection-codes"],
        "exact",
      ),
      async (context) => {
        const before = await balance(payer);
        const result = await lab("pay-low-cap", "pay", "low-cap");
        assertRows(result, LAB_ROWS["pay-low-cap"], LAB_BADGES["pay-low-cap"]);
        strictEqual(result.code, "payment_per_call_cap_exceeded");
        strictEqual(result.txLink, undefined, "no transaction");
        refusedRun(
          context,
          result.report,
          "playground lab: pay with a cap below the price",
          "payment_per_call_cap_exceeded",
        );
        strictEqual(sdkEventCount(result.report, "reserved"), 0, "nothing reserved");
        strictEqual(sdkEventCount(result.report, "signed"), 0, "nothing signed");
        strictEqual(await balance(payer), before);
        noProblems();
        context.observe("balancesUnchanged", true);
        context.observe("rows", result.rows);
      },
    );

    await recorder.run(
      spec(
        "replay",
        "Lab: the same payment sent twice is refused the second time and charged once",
        ["rejection-codes"],
        "exact",
      ),
      async (context) => {
        const before = await balance(payer);
        const result = await lab("pay-replay", "pay", "replay");
        deepRows(result.rows.slice(7), LAB_ROWS["pay-replay-tail"]);
        strictEqual(result.badge, LAB_BADGES["pay-replay"]);
        await settled(context, result, { scheme: "exact", amount: WEATHER, to: demoPayTo });
        const code = result.report.summary?.code ?? "";
        ok(
          [
            "invalid_exact_stellar_payload_nonce_already_used",
            "invalid_exact_stellar_signature_expired",
          ].includes(code),
          `the resend was refused: ${code}`,
        );
        refusedRun(context, result.report, "playground lab: the same PAYMENT-SIGNATURE sent again", code);
        strictEqual(sdkEventCount(result.report, "signed"), 1, "one authorization was signed");
        strictEqual(await balance(payer), before - WEATHER, "charged once");
        noProblems();
        context.observe("rows", result.rows);
      },
    );

    // --- lab: pay per use -----------------------------------------------------------------------------
    await recorder.run(
      spec(
        "pay-upto",
        "Lab, pay per use: an upto authorization of 0.01 settles the 0.0021 used",
        ["scheme-upto", "fees-sponsored"],
        "upto",
      ),
      async (context) => {
        const before = await balance(payer);
        const result = await lab("upto-normal", "upto", "normal");
        assertRows(result, LAB_ROWS["upto-normal"], LAB_BADGES["upto-normal"]);
        await settled(context, result, { scheme: "upto", amount: HISTORY_WEEK, to: demoPayTo });
        strictEqual(await balance(payer), before - HISTORY_WEEK, "the payer paid what was used");
        noProblems();
        context.observe("rows", result.rows);
      },
    );

    let overchargeHeld = false;
    await recorder.run(
      spec(
        "overcharge",
        "Lab: a seller asking to settle twice the authorized cap is refused, and nothing moves",
        ["scheme-upto", "rejection-codes"],
        "upto",
      ),
      async (context) => {
        const before = await balance(payer);
        const result = await lab("upto-overcharge", "upto", "overcharge");
        assertRows(result, LAB_ROWS["upto-overcharge"], LAB_BADGES["upto-overcharge"]);
        const code = "invalid_upto_stellar_payload_settlement_exceeds_amount";
        strictEqual(result.code, code);
        strictEqual(result.txLink, undefined, "no transaction");
        strictEqual(reportedTransactions(result.report).length, 0, "no transaction was read");
        refusedRun(context, result.report, "playground lab: settle 0.02 against a 0.01 upto cap", code);
        strictEqual(await balance(payer), before, "nothing moved");
        const label = await meterLabel(page);
        ok(/ 0\.01 held/.test(label), `the authorization is held until it expires: ${label}`);
        overchargeHeld = true;
        noProblems();
        context.observe("balancesUnchanged", true);
        context.observe("meter", label);
        context.observe("rows", result.rows);
      },
    );

    // --- lab: an agent pays a tool --------------------------------------------------------------------
    await recorder.run(
      spec(
        "agent-mcp",
        "Lab: a scripted agent finds an MCP tool in the Bazaar, checks its budget and pays it with the rail402-mcp tools",
        ["mcp", "discovery", "scheme-upto"],
        "upto",
      ),
      async (context) => {
        const before = await balance(payer);
        const result = await lab("agent-normal", "agent", "normal");
        assertRows(result, LAB_ROWS["agent-normal"], LAB_BADGES["agent-normal"]);
        await settled(context, result, { scheme: "upto", amount: FORECAST_SIX_HOURS, to: demoPayTo });
        strictEqual(await balance(payer), before - FORECAST_SIX_HOURS);
        const search = result.report.events.find(
          (event) => event.kind === "bazaar" && event.phase === "search",
        );
        ok(search !== undefined, "the agent searched the Bazaar");
        noProblems();
        context.observe("search", { query: search.query, results: search.top?.length ?? 0 });
        context.observe("rows", result.rows);
      },
    );

    // --- lab: sell and get listed ---------------------------------------------------------------------
    const sellSpec = spec(
      "sell-listed",
      "Lab, sell: a paid call to the sandbox route settles, is cataloged, origin-checked and found by search",
      ["discovery", "scheme-exact"],
      "exact",
    );
    if (mode === "hosted") {
      recorder.skip(
        sellSpec,
        "the Playground's lab sellers listen on this machine, which a hosted catalog refuses to reach",
      );
    } else {
      await recorder.run(sellSpec, async (context) => {
        ok(payTo !== null, "the lab is on");
        const before = await balance(payer);
        const result = await lab("sell-normal", "sell", "normal");
        assertRows(result, LAB_ROWS["sell-normal"], LAB_BADGES["sell-normal"]);
        await settled(context, result, { scheme: "exact", amount: SELL, to: payTo });
        strictEqual(await balance(payer), before - SELL);
        const listing = result.report.events
          .filter((event) => event.kind === "bazaar" && event.phase === "listing")
          .at(-1)?.listing;
        ok(listing?.id !== undefined, "the run read the listing");
        const search = result.report.events.find(
          (event) => event.kind === "bazaar" && event.phase === "search",
        );
        ok(search?.top?.some((hit) => hit.id === listing.id) === true, "search finds the listing");
        noProblems();
        context.observe("listing", {
          id: listing.id,
          state: listing.state ?? null,
          trust: listing.trust ?? null,
        });
        context.observe("rows", result.rows);
      });
    }

    // --- refusal checks -------------------------------------------------------------------------------
    const checkCase = async (id: string, check: CheckTitleId, title: string) => {
      await recorder.run(spec(id, title, ["rejection-codes"]), async (context) => {
        const before = await balance(payer);
        const result = await runCheck(page, check);
        await snapshot(id);
        const code = CHECK_EXPECTED_CODES[check];
        strictEqual(result.state, "passed", JSON.stringify(result.fields));
        strictEqual(result.fields["Code"], code);
        ok((result.fields["Reason"] ?? "") !== "", "the check shows a reason");
        const after = await balance(payer);
        if (check === "session-budget") {
          // The first payment fits the window and is paid; the second would exceed it. The check links
          // the first payment's transaction, which the chain shows paying the price to the demo seller.
          strictEqual(result.fields["Signed"], "1 authorization(s)");
          strictEqual(after, before - WEATHER, "only the first payment moved funds");
          strictEqual(result.txLinks.length, 1, "the check links the first payment's transaction");
          const hash = await settled(
            context,
            { txLink: result.txLinks[0] },
            { scheme: "exact", amount: WEATHER, to: demoPayTo },
          );
          context.observe("paidBeforeRefusal", { amount: WEATHER.toString(), transaction: hash });
        } else {
          strictEqual(result.txLinks.length, 0, "the check links no transaction");
          strictEqual(result.fields["Signed"], "nothing");
          strictEqual(result.fields["Balance"], "unchanged");
          strictEqual(after, before, "the balance did not move");
          context.observe("balancesUnchanged", true);
        }
        context.rejection({
          surface: "http",
          operation: `playground check: ${title}`,
          code,
          reason: result.fields["Reason"] ?? "",
        });
        context.observe("layer", result.fields["Refused by"] ?? null);
        noProblems();
      });
    };
    await checkCase("refusal-network", "network", "A 402 asking for payment on stellar:pubnet is refused");
    await checkCase("refusal-asset", "asset", "A 402 priced in an asset outside the policy is refused");
    await checkCase("refusal-amount", "amount", "A 402 asking for an amount of 0 is refused");
    await checkCase("refusal-recipient", "recipient", "A payTo on the buyer's deny list is refused");
    await checkCase("refusal-session", "session-budget", "A payment past the session budget is refused");

    // --- egress ---------------------------------------------------------------------------------------
    const egressCase = async (id: string, title: string, url: string, expected: RegExp) => {
      await recorder.run(spec(id, title, ["rejection-codes"]), async (context) => {
        const before = await balance(payer);
        const result = await payUrl(page, url);
        reports.push({ name: id, text: result.reportText });
        await snapshot(id);
        ok(result.code !== undefined && expected.test(result.code), `refused with ${String(result.code)}`);
        strictEqual(result.txLink, undefined, "no transaction");
        strictEqual(sdkEventCount(result.report, "signed"), 0, "nothing signed");
        refusedRun(context, result.report, `playground pay: ${url}`, result.code);
        strictEqual(await balance(payer), before, "the balance did not move");
        context.observe("balancesUnchanged", true);
        noProblems();
      });
    };
    const [loopbackTarget, metadataTarget] = PRIVATE_ADDRESS_TARGETS;
    const literalSpec = spec(
      "ssrf-literal",
      "Pay any URL: a loopback address literal is refused by the relay",
      ["rejection-codes"],
    );
    if (mode === "local") {
      recorder.skip(
        literalSpec,
        "a local Playground lets its relay reach loopback sellers; the run against a deployed Rail402 proves it",
      );
    } else {
      await egressCase(
        literalSpec.id,
        literalSpec.title,
        loopbackTarget ?? "",
        /^egress_destination_not_allowed$/,
      );
    }
    await egressCase(
      "ssrf-metadata",
      "Pay any URL: the cloud metadata address is refused by the relay",
      metadataTarget ?? "",
      /^egress_destination_not_allowed$/,
    );
    const redirectSpec = spec(
      "redirect",
      "Pay any URL: a seller redirecting to another origin is refused, and that origin receives nothing",
      ["rejection-codes"],
    );
    if (services.redirect === undefined) {
      recorder.skip(
        redirectSpec,
        "the redirecting seller listens on this machine, which only a local Playground's relay may reach",
      );
    } else {
      const redirect = services.redirect;
      await egressCase(redirectSpec.id, redirectSpec.title, `${redirect.url}/pay`, /^egress_/);
      await recorder.run(
        spec("redirect-decoy", "The redirect's target origin received no request", ["rejection-codes"]),
        (context) => {
          strictEqual(redirect.decoyRequests(), 0);
          context.observe("decoyRequests", 0);
          return Promise.resolve();
        },
      );
    }

    // --- the refused overcharge's hold comes back -----------------------------------------------------
    await recorder.run(
      spec(
        "overcharge-release",
        "The refused overcharge's held cap returns to the session budget once its authorization expires",
        ["scheme-upto"],
        "upto",
      ),
      async (context) => {
        ok(overchargeHeld, "the overcharge case held the cap");
        const started = Date.now();
        const label = await until(
          async () => {
            await reconcileNow(page);
            const value = await meterLabel(page);
            return / 0 held/.test(value) ? value : undefined;
          },
          "the held cap to return",
          RELEASE_WAIT_MS,
          10_000,
        );
        noProblems();
        context.observe("meter", label);
        context.observe("releasedAfterMs", Date.now() - started);
      },
    );

    // --- explorer -------------------------------------------------------------------------------------
    await recorder.run(
      spec(
        "explorer",
        "Every transaction the page linked opens in stellar.expert (its API answers 200 with the hash and ledger)",
        [],
      ),
      async (context) => {
        const checks: (ExplorerCheck & { pageLink: string })[] = await Promise.all(
          [...explorerHashes].map(async ([hash, pageLink]) => ({
            ...(await checkStellarExpert(hash)),
            pageLink,
          })),
        );
        context.observe("transactions", checks);
        const missing = checks.filter((check) => check.apiStatus !== 200);
        strictEqual(missing.length, 0, `not indexed: ${missing.map((check) => check.hash).join(", ")}`);
        ok(
          checks.every((check) => check.pageLink === check.explorerUrl),
          "the page links stellar.expert",
        );
      },
    );

    // --- secret scan ----------------------------------------------------------------------------------
    const scan = new SecretScanner(canary.secret());
    await recorder.run(
      spec(
        "secret-scan",
        "No channel the browser, the Playground server or this run produced carries the wallet's seed, a signature, a preimage or a payment",
        [],
      ),
      async (context) => {
        await page.goto("/");
        await traffic.settled();
        const payments = addPaymentNeedles(scan, traffic.exchanges, PASSPHRASE);
        ok(payments >= 7, `payments sent: ${String(payments)}`);
        const chain = { rpcUrl: config.urls.rpc, friendbotUrl: config.urls.friendbot };
        // RPC calls and payment-carrying requests are exempt from the payment needles, never from the seed.
        const seedOnly = new SecretScanner(canary.secret());
        captureExchanges(scan, traffic.exchanges, chain, seedOnly);
        const seedFindings = seedOnly.findings();
        const plantedSeedFound = seedFoundInPlantedRpcBody(
          canary.secret(),
          traffic.exchanges,
          chain,
          (seed) => new SecretScanner(seed),
        );
        strictEqual(
          uncodedRelayFailures(traffic.exchanges).length,
          0,
          "every relay failure is a coded refusal",
        );
        if (services.server !== undefined) {
          ok(services.server.logs.length > 0, "the server logged");
          scan.capture("server logs", JSON.stringify(services.server.logs));
          scan.capture("server stderr", services.server.stderr);
        }
        scan.capture("browser console", consoleLines.join("\n"));
        for (const { name, text } of domTexts) scan.capture(`page text: ${name}`, text);
        for (const { name, text } of reports) scan.capture(`run report: ${name}`, text);
        const stored = await captureStorage(scan, page);
        ok(
          stored.includes('"extractable":false') && !stored.includes('"extractable":true'),
          "the wallet key cannot be exported",
        );
        const findings = scan.findings();
        // The scan finds a payment where one does not belong.
        const planted = new SecretScanner(canary.secret());
        addPaymentNeedles(planted, traffic.exchanges, PASSPHRASE);
        planted.capture(
          "planted",
          JSON.stringify({ echo: samplePaymentHeader(traffic.exchanges)?.slice(10, 50) }),
        );
        context.observe("secretScan", {
          channels: scan.channels.length,
          needles: scan.needles,
          payments,
          serverLogs: services.server !== undefined,
          hits: findings.length,
          seedHits: seedFindings.length,
          plantedLeakFound: planted.findings().length > 0,
          plantedSeedFound,
          ...(findings.length === 0 ? {} : { where: findings }),
          ...(seedFindings.length === 0 ? {} : { seedWhere: seedFindings }),
        });
        ok(planted.findings().length > 0, "a planted leak is found");
        ok(plantedSeedFound, "a seed planted in an RPC request body is found");
        strictEqual(findings.length, 0, `leaks: ${JSON.stringify(findings)}`);
        strictEqual(seedFindings.length, 0, `seed leaks: ${JSON.stringify(seedFindings)}`);
      },
    );

    const browserVersion = browser.version();
    const evidence = buildEvidence(
      {
        kind: "live-playground",
        // Without --write the document is printed only; its commit may then describe a dirty tree.
        provenance: provenance ?? { commit: gitCommit().replace(/-dirty$/, ""), dirty: false },
        network: NETWORK,
        target,
        packages: {
          ...versions([
            "@rail402.dev/playground",
            "@rail402.dev/sdk",
            "@rail402.dev/mcp",
            "@x402/core",
            "@x402/stellar",
            "@stellar/stellar-sdk",
            "@playwright/test",
          ]),
          chromium: browserVersion,
        },
        command: commandLine(),
        config: {
          mode: mode === "local" ? "local rehearsal" : mode === "hosted" ? "hosted, local page" : "deployed",
          playground:
            mode === "deployed"
              ? services.playgroundUrl
              : "the Playground server from this commit, on this machine",
          playgroundVersion: config.version,
          playgroundMode: config.mode,
          rail402: mode === "local" ? "local process, public testnet RPC" : config.urls.facilitator,
          bazaar: mode === "local" ? "the same Rail402 (memory store)" : config.urls.bazaar,
          seller: mode === "local" ? "apps/demo-seller on loopback" : config.urls.demoSeller,
          rpc: config.urls.rpc,
          explorer: config.explorerTemplate,
          asset: config.asset.contract,
          perCallDefault: config.caps.perCallDefault,
          sessionTotal: config.caps.sessionTotal,
          browser: `chromium ${browserVersion} (headless)`,
        },
        accounts: {
          payer,
          demoPayTo,
          ...(payTo === null ? {} : { labPayTo: payTo }),
          uptoContract: config.uptoContract,
          ...(services.sponsor === undefined ? {} : { sponsor: services.sponsor }),
          ...(services.treasury === undefined ? {} : { treasury: services.treasury }),
        },
        startedAt: recorder.startedAt,
      },
      recorder.cases,
    );
    // The document itself is a channel too.
    scan.capture("evidence", evidence);
    const leaks = scan.findings();
    if (leaks.length > 0) throw new Error(`the evidence document would leak: ${JSON.stringify(leaks)}`);
    const documentProblems = livePlaygroundProblems(evidence);
    for (const problem of documentProblems) log(`PROBLEM ${problem}`);

    if (provenance === undefined) {
      process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
    } else if (documentProblems.length === 0 && recorder.failed === 0) {
      recheckProvenance(provenance, { allowBranch: args["allow-branch"] });
      const file = evidenceFileName("live-playground", NETWORK, mode === "local" ? "local" : undefined);
      log(`evidence written to ${writeEvidence(evidence, { allowBranch: args["allow-branch"], file })}`);
    } else {
      log(`nothing written to ${EVIDENCE_DIR}: the run has failures`);
    }
    log(
      `${String(evidence.summary.passed)} passed, ${String(evidence.summary.failed)} failed, ${String(evidence.summary.skipped)} skipped`,
    );
    if (recorder.failed > 0 || documentProblems.length > 0) process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => undefined);
    for (const cleanup of services.cleanups.reverse()) {
      try {
        await cleanup();
      } catch {
        // Best effort: the run's outcome is already decided.
      }
    }
  }
}

/** The swimlane and the badge are the ones the page must draw for this run. */
function assertRows(result: LabResult, rows: readonly string[], badge: string): void {
  deepRows(result.rows, rows);
  strictEqual(result.badge, badge, "the outcome badge");
}

function deepRows(actual: readonly string[], expected: readonly string[]): void {
  strictEqual(JSON.stringify(actual), JSON.stringify(expected), "the swimlane's rows, in order");
}

/** The Playground's public configuration, as the page reads it. */
async function readConfig(origin: string): Promise<PublicConfig> {
  const response = await fetch(`${origin}${CONFIG_PATH}`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`GET ${CONFIG_PATH} answered HTTP ${String(response.status)}`);
  const config = parsePublicConfig(await response.json());
  if (config === undefined)
    throw new Error(`${CONFIG_PATH} does not match the Playground's configuration schema`);
  return config;
}

/** The payTo of a seller's live 402 for `url`: its first option on this network. */
async function livePayTo(url: string): Promise<string> {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  await response.body?.cancel().catch(() => undefined);
  const header = response.headers.get("payment-required");
  if (response.status !== 402 || header === null) {
    throw new Error(`${url} answered HTTP ${String(response.status)} without PAYMENT-REQUIRED`);
  }
  const required = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
    accepts?: { network?: string; payTo?: string }[];
  };
  const payTo = required.accepts?.find((option) => option.network === NETWORK)?.payTo;
  if (payTo === undefined) throw new Error(`${url} offers no ${NETWORK} option`);
  return payTo;
}

/** The command that reproduces this run, without machine-local values. */
function commandLine(): string {
  const parts = ["node --conditions=@rail402/source tools/conformance/src/live-playground.ts"];
  if (hostedUrls !== undefined) {
    parts.push(`--bazaar ${hostedUrls.bazaar} --seller ${hostedUrls.seller}`);
    if (args["pay-to"] !== undefined) parts.push(`--pay-to ${args["pay-to"]}`);
  }
  if (deployedUrl !== undefined) parts.push(`--playground ${deployedUrl}`);
  return parts.join(" ");
}

main().catch((error: unknown) => {
  log(`FAILED: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});
