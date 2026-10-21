/**
 * Live Playground run on the public Stellar testnet: Chromium drives the Playground's real page, as a
 * visitor would. The first visit makes a test wallet on its own and funds it (Friendbot, a USDC
 * trustline, USDC from the testnet exchange); its key file, saved from the wallet menu, gives the
 * canary seed. The Lab plays each mode to its proof (a fixed price with `exact`, pay for what you use
 * with `upto`, an agent paying an MCP tool), a cap typed below the price is refused, every refusal of
 * "Try a refusal" ends with its code (the policy checks, the session budget, the same payment sent
 * twice, a seller charging over the cap), a listing is paid from the Bazaar, and private addresses and
 * a cross-origin redirect pasted into the Lab are refused. Every transaction the page shows is read
 * back from the chain in Node and proven to open in stellar.expert; every refusal is checked to leave
 * the payer's balance where it was; and a canary scan finds neither the wallet's key nor any payment
 * in anything the browser sent, stored, logged or showed.
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
 *   demo seller's MCP tools are paid once by a separate buyer first, so the Bazaar lists them for the
 *   agent (air_quality) and the Bazaar case (hourly_forecast). Needs no secrets.
 * - hosted, local page (`--bazaar` and `--seller`): the Playground server runs here, in its hosted
 *   configuration, against a deployed Rail402 and demo seller. Its lab sellers are paid to `--pay-to`
 *   (a fresh account when it is not given). The redirecting seller would listen on this machine,
 *   which only a local Playground's relay may reach, so the redirect case is skipped.
 * - deployed (`--playground`): a Playground that is already running, read from its `/api/config`.
 *
 * Cases earlier runs recorded that this one no longer has, because the page no longer offers them:
 * `sell-listed` (the Lab no longer pays the sandbox seller route; the integration suite still proves
 * the route settles, is cataloged and found) and `overcharge-release` (the page no longer shows the
 * session budget's held amount; the integration suite proves a refused hold returns after expiry).
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
import { METERED_PRICES, PRICES, TOOL_PRICES, createSeller } from "@rail402.dev/demo-seller";
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
  OVERCHARGE_REFUSAL_CODE,
  PRIVATE_ADDRESS_TARGETS,
  REPLAY_REFUSAL_CODES,
  type CheckId,
} from "../../../apps/playground/src/shared/lab.ts";
import { LAB_STEPS } from "../../../apps/playground/e2e/expected.ts";
import {
  exportKeyFile,
  followSetup,
  hashOfLink,
  labEnd,
  payListing,
  runLab,
  saveReport,
  tryRefusal,
  walletAddress,
  type LabEnd,
} from "../../../apps/playground/e2e/page.ts";
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
  lastRefusal,
  parseReport,
  reportedTransactions,
  sdkEventCount,
  until,
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

const atomic = (amount: string): bigint => {
  const [whole = "0", fraction = ""] = amount.split(".");
  return BigInt(whole) * 10n ** BigInt(DECIMALS) + BigInt(fraction.padEnd(DECIMALS, "0"));
};
/** Demo seller prices of the runs, in base units. */
const WEATHER = atomic(PRICES.weather);
const HISTORY_WEEK = 7n * atomic(METERED_PRICES.perDay);
const FORECAST_SIX_HOURS = 6n * atomic(METERED_PRICES.perHour);
const AIR_QUALITY = atomic(TOOL_PRICES.airQuality);
/** A cap below the weather route's price, typed into the Lab. */
const BELOW_PRICE = "0.0001";

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
 * The demo seller's MCP tools are paid once first, so the Bazaar lists them for the agent and the Bazaar.
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

  // The agent and the Bazaar case find the tools in the Bazaar: a tool's first settlement, by any
  // buyer, lists it.
  log("paying the demo seller's MCP tools once so the Bazaar lists them");
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
    const tools = [
      {
        toolName: "hourly_forecast",
        arguments: { city: "Ankara", hours: 1 },
        query: "hourly weather forecast",
      },
      { toolName: "air_quality", arguments: { city: "Ankara" }, query: "air quality" },
    ] as const;
    for (const tool of tools) {
      await primer.pay(
        { kind: "mcp", url: `${demoUrl}/mcp`, toolName: tool.toolName, arguments: { ...tool.arguments } },
        { maxAmount: { amount: "0.01", asset: "USDC" } },
      );
    }
    for (const tool of tools) {
      await until(
        async () => {
          const page = await primer.search(tool.query, { type: "mcp" });
          return page.hits.some(
            (hit) => hit.toolName === tool.toolName && hit.listingId !== null && hit.trust !== "settled",
          )
            ? true
            : undefined;
        },
        `the Bazaar to list the demo seller's ${tool.toolName} tool`,
        CATALOG_WAIT_MS,
        3_000,
      );
    }
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

    /** The wallet the page makes, and the seed its key file holds: the canary of the scan. */
    let payer = "";
    let canarySeed = "";
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

    /** A Lab run played to its end, with the run report the page saved. */
    const lab = async (name: string, run: () => Promise<LabEnd>): Promise<LabEnd & { report: RunReport }> => {
      const end = await run();
      const text = await saveReport(page);
      reports.push({ name, text });
      await snapshot(name);
      return { ...end, report: parseReport(text) };
    };

    // --- onboarding -----------------------------------------------------------------------------------
    await recorder.run(
      spec(
        "onboarding",
        "The first visit makes a test wallet on its own and funds it: Friendbot, then a USDC trustline and USDC from the testnet exchange; a reload keeps it",
        [],
      ),
      async (context) => {
        await page.goto("/");
        const setup = await followSetup(page);
        payer = setup.address;
        // The dialog links Friendbot's transaction and the purchase; the trustline is checked by the balance.
        strictEqual(setup.links.length, 2, "the dialog links two setup transactions");
        const classic = [];
        for (const link of setup.links) {
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
        // The key is never on the page: its key file, saved after a confirmation, is the canary.
        const keyFile = await exportKeyFile(page);
        strictEqual(Keypair.fromSecret(keyFile.seed).publicKey(), payer, "the key file holds this wallet");
        canarySeed = keyFile.seed;
        await page.reload();
        strictEqual(await walletAddress(page), payer, "a reload keeps the wallet");
        await snapshot("onboarding");
        noProblems();
        context.observe("payer", payer);
        context.observe("dialog", setup.titles);
        context.observe("classicTransactions", classic);
      },
    );
    const funded = payer !== "" && (await balance(payer).catch(() => 0n)) > 0n;
    if (!funded || canarySeed === "")
      throw new Error("the wallet could not be made and funded; nothing else can run");

    // --- the Lab: pay a fixed price --------------------------------------------------------------------
    await recorder.run(
      spec(
        "pay-exact",
        "Lab, pay a fixed price: one exact payment played step by step, settled on chain and sponsored",
        ["scheme-exact", "fees-sponsored"],
        "exact",
      ),
      async (context) => {
        const before = await balance(payer);
        const result = await lab("exact-normal", () => runLab(page, "/"));
        steps(result, LAB_STEPS["exact-normal"]);
        strictEqual(result.proof?.paid, `${PRICES.weather} ${config.asset.symbol}`, "the proof's amount");
        await settled(
          context,
          { txLink: result.proof.txLink, report: result.report },
          {
            scheme: "exact",
            amount: WEATHER,
            to: demoPayTo,
          },
        );
        strictEqual(await balance(payer), before - WEATHER, "the payer paid the price once");
        strictEqual(sdkEventCount(result.report, "signed"), 1, "one authorization was signed");
        noProblems();
        context.observe("steps", result.steps);
        context.observe("proof", { paid: result.proof.paid, tiles: result.proof.tiles });
      },
    );

    await recorder.run(
      spec(
        "cap-below-price",
        "Lab: a cap typed below the price is refused before anything is signed",
        ["rejection-codes"],
        "exact",
      ),
      async (context) => {
        const before = await balance(payer);
        const result = await lab("exact-low-cap", () => runLab(page, "/", { cap: BELOW_PRICE }));
        steps(result, LAB_STEPS["exact-low-cap"]);
        const code = "payment_per_call_cap_exceeded";
        strictEqual(result.verdict?.facts["Code"], code);
        strictEqual(result.verdict.facts["Signed"], "nothing");
        refusedRun(context, result.report, `playground lab: pay with a cap of ${BELOW_PRICE}`, code);
        strictEqual(sdkEventCount(result.report, "reserved"), 0, "nothing reserved");
        strictEqual(sdkEventCount(result.report, "signed"), 0, "nothing signed");
        strictEqual(await balance(payer), before);
        noProblems();
        context.observe("balancesUnchanged", true);
        context.observe("steps", result.steps);
      },
    );

    await recorder.run(
      spec(
        "replay",
        "Lab, try a refusal: the same payment sent twice is refused the second time and charged once",
        ["rejection-codes"],
        "exact",
      ),
      async (context) => {
        const before = await balance(payer);
        const result = await lab("replay", () => tryRefusal(page, "Send it twice"));
        steps(result, LAB_STEPS.replay);
        strictEqual(result.verdict?.txLinks.length, 1, "the verdict links the one payment");
        await settled(
          context,
          { txLink: result.verdict.txLinks[0], report: result.report },
          {
            scheme: "exact",
            amount: WEATHER,
            to: demoPayTo,
          },
        );
        const code = result.report.summary?.code ?? "";
        ok(Object.keys(REPLAY_REFUSAL_CODES).includes(code), `the resend was refused: ${code}`);
        strictEqual(result.verdict.facts["Code"], code);
        refusedRun(context, result.report, "playground lab: the same PAYMENT-SIGNATURE sent again", code);
        strictEqual(sdkEventCount(result.report, "signed"), 1, "one authorization was signed");
        strictEqual(await balance(payer), before - WEATHER, "charged once");
        noProblems();
        context.observe("steps", result.steps);
      },
    );

    // --- the Lab: pay for what you use -----------------------------------------------------------------
    await recorder.run(
      spec(
        "pay-upto",
        "Lab, pay for what you use: an upto authorization of 0.01 settles the 0.0021 used",
        ["scheme-upto", "fees-sponsored"],
        "upto",
      ),
      async (context) => {
        const before = await balance(payer);
        const result = await lab("upto-normal", () => runLab(page, "/?mode=upto"));
        steps(result, LAB_STEPS["upto-normal"]);
        await settled(
          context,
          { txLink: result.proof?.txLink, report: result.report },
          {
            scheme: "upto",
            amount: HISTORY_WEEK,
            to: demoPayTo,
          },
        );
        strictEqual(await balance(payer), before - HISTORY_WEEK, "the payer paid what was used");
        ok(
          result.proof?.tiles.some((tile) => tile.endsWith("of your cap never taken")) === true,
          "the proof says how much of the cap was never taken",
        );
        noProblems();
        context.observe("steps", result.steps);
        context.observe("proof", { paid: result.proof.paid, tiles: result.proof.tiles });
      },
    );

    await recorder.run(
      spec(
        "overcharge",
        "Lab, try a refusal: a seller asking to settle twice the authorized cap is refused, and nothing moves",
        ["scheme-upto", "rejection-codes"],
        "upto",
      ),
      async (context) => {
        const before = await balance(payer);
        const result = await lab("overcharge", () => tryRefusal(page, "Seller charges over the cap"));
        steps(result, LAB_STEPS.overcharge);
        strictEqual(result.verdict?.facts["Code"], OVERCHARGE_REFUSAL_CODE);
        strictEqual(result.verdict.txLinks.length, 0, "no transaction");
        strictEqual(reportedTransactions(result.report).length, 0, "no transaction was read");
        refusedRun(
          context,
          result.report,
          "playground lab: settle 0.02 against a 0.01 upto cap",
          OVERCHARGE_REFUSAL_CODE,
        );
        strictEqual(await balance(payer), before, "nothing moved");
        noProblems();
        context.observe("balancesUnchanged", true);
        context.observe("steps", result.steps);
      },
    );

    // --- the Lab: let an agent pay ---------------------------------------------------------------------
    await recorder.run(
      spec(
        "agent-mcp",
        "Lab, let an agent pay: a scripted agent finds an MCP tool in the Bazaar, checks its budget and pays it with the rail402-mcp tools",
        ["mcp", "discovery", "scheme-exact"],
        "exact",
      ),
      async (context) => {
        const before = await balance(payer);
        const result = await lab("agent-normal", () => runLab(page, "/?mode=agent"));
        steps(result, LAB_STEPS["agent-normal"]);
        await settled(
          context,
          { txLink: result.proof?.txLink, report: result.report },
          {
            scheme: "exact",
            amount: AIR_QUALITY,
            to: demoPayTo,
          },
        );
        strictEqual(await balance(payer), before - AIR_QUALITY);
        const search = result.report.events.find(
          (event) => event.kind === "bazaar" && event.phase === "search",
        );
        ok(search !== undefined, "the agent searched the Bazaar");
        noProblems();
        context.observe("search", { query: search.query, results: search.top?.length ?? 0 });
        context.observe("steps", result.steps);
      },
    );

    // --- the Bazaar: try a listing with the wallet -----------------------------------------------------
    await recorder.run(
      spec(
        "bazaar-mcp",
        "Bazaar: an MCP tool found by a plain-words search is paid from its listing's form with the arguments it declares",
        ["mcp", "discovery", "scheme-upto"],
        "upto",
      ),
      async (context) => {
        const before = await balance(payer);
        const paid = await payListing(page, {
          query: "hourly weather forecast",
          shows: "hourly_forecast",
          fields: { city: "Izmir", hours: "6" },
        });
        await snapshot("bazaar-mcp");
        ok(paid.txLink !== undefined, `the result card links the transaction: ${paid.result}`);
        ok(paid.result.includes("Izmir"), "the result card shows what came back");
        // The payment plays in the Lab, whose report is the run's event log.
        await page.getByRole("link", { name: "Watch this payment in the Lab →" }).click();
        const watched = await lab("bazaar-mcp", () => labEnd(page));
        strictEqual(watched.proof?.txLink, paid.txLink, "the Lab plays the same payment");
        await settled(
          context,
          { txLink: paid.txLink, report: watched.report },
          {
            scheme: "upto",
            amount: FORECAST_SIX_HOURS,
            to: demoPayTo,
          },
        );
        strictEqual(await balance(payer), before - FORECAST_SIX_HOURS);
        noProblems();
        context.observe("result", paid.result);
      },
    );

    // --- the Lab: refusals before signing --------------------------------------------------------------
    const checkCase = async (id: string, check: CheckId, menuTitle: string, title: string) => {
      await recorder.run(spec(id, title, ["rejection-codes"]), async (context) => {
        const before = await balance(payer);
        const result = await lab(id, () => tryRefusal(page, menuTitle));
        const code = CHECK_EXPECTED_CODES[check];
        const facts = result.verdict?.facts ?? {};
        strictEqual(result.verdict?.badge, "Refused as expected", JSON.stringify(facts));
        strictEqual(facts["Code"], code);
        refusedRun(context, result.report, `playground lab, try a refusal: ${menuTitle}`, code);
        const after = await balance(payer);
        if (check === "session-budget") {
          // The first payment fits the window and is paid; the second would exceed it. The verdict links
          // the first payment's transaction, which the chain shows paying the price to the demo seller.
          steps(result, LAB_STEPS["check-session-budget"]);
          strictEqual(facts["Signed"], "1 payment");
          strictEqual(after, before - WEATHER, "only the first payment moved funds");
          strictEqual(result.verdict.txLinks.length, 1, "the verdict links the first payment");
          const hash = await settled(
            context,
            { txLink: result.verdict.txLinks[0] },
            {
              scheme: "exact",
              amount: WEATHER,
              to: demoPayTo,
            },
          );
          context.observe("paidBeforeRefusal", { amount: WEATHER.toString(), transaction: hash });
        } else {
          steps(result, LAB_STEPS["check-before-signing"]);
          strictEqual(result.verdict.txLinks.length, 0, "the verdict links no transaction");
          strictEqual(facts["Signed"], "nothing");
          strictEqual(facts["Your balance"], "unchanged");
          strictEqual(sdkEventCount(result.report, "signed"), 0, "nothing signed");
          strictEqual(after, before, "the balance did not move");
          context.observe("balancesUnchanged", true);
        }
        noProblems();
      });
    };
    await checkCase(
      "refusal-network",
      "network",
      "Another network",
      "A 402 asking for payment on stellar:pubnet is refused",
    );
    await checkCase(
      "refusal-asset",
      "asset",
      "Unknown asset",
      "A 402 priced in an asset outside the policy is refused",
    );
    await checkCase("refusal-amount", "amount", "Zero amount", "A 402 asking for an amount of 0 is refused");
    await checkCase(
      "refusal-recipient",
      "recipient",
      "Recipient not allowed",
      "A payTo on the buyer's deny list is refused",
    );
    await checkCase(
      "refusal-per-call-cap",
      "per-call-cap",
      "Cap below the price",
      "A price above the per-call cap is refused",
    );
    await checkCase(
      "refusal-session",
      "session-budget",
      "Session budget used up",
      "A payment past the session budget is refused",
    );

    // --- egress: URLs pasted into the Lab ----------------------------------------------------------------
    const egressCase = async (id: string, title: string, url: string, expected: RegExp) => {
      await recorder.run(spec(id, title, ["rejection-codes"]), async (context) => {
        const before = await balance(payer);
        const result = await lab(id, () => runLab(page, "/", { url }));
        const code = result.verdict?.facts["Code"] ?? "";
        ok(expected.test(code), `refused with ${code}`);
        steps(result, LAB_STEPS["egress-refused"]);
        strictEqual(result.verdict?.facts["Signed"], "nothing");
        strictEqual(sdkEventCount(result.report, "signed"), 0, "nothing signed");
        refusedRun(context, result.report, `playground lab: pay ${url}`, code);
        strictEqual(await balance(payer), before, "the balance did not move");
        context.observe("balancesUnchanged", true);
        noProblems();
      });
    };
    const [loopbackTarget, metadataTarget] = PRIVATE_ADDRESS_TARGETS;
    const literalSpec = spec(
      "ssrf-literal",
      "Lab, a pasted URL: a loopback address literal is refused by the relay",
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
      "Lab, a pasted URL: the cloud metadata address is refused by the relay",
      metadataTarget ?? "",
      /^egress_destination_not_allowed$/,
    );
    const redirectSpec = spec(
      "redirect",
      "Lab, a pasted URL: a seller redirecting to another origin is refused, and that origin receives nothing",
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
    const scan = new SecretScanner(canarySeed);
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
        const seedOnly = new SecretScanner(canarySeed);
        captureExchanges(scan, traffic.exchanges, chain, seedOnly);
        const seedFindings = seedOnly.findings();
        const plantedSeedFound = seedFoundInPlantedRpcBody(
          canarySeed,
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
        const planted = new SecretScanner(canarySeed);
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

/** The swimlane is the one the page must draw for this run, row by row. */
function steps(result: LabEnd, expected: readonly string[]): void {
  strictEqual(JSON.stringify(result.steps), JSON.stringify(expected), "the swimlane's steps, in order");
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
