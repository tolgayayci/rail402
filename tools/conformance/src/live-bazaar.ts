/**
 * Live Bazaar run: every cataloging and integrity rule exercised against a Rail402 on the public
 * Stellar network. Each case settles a real payment over HTTP, built from a seller's own 402 response
 * exactly as a stock client builds it, and records the facilitator's EXTENSION-RESPONSES outcome and
 * the listing it produced.
 *
 *   node --conditions=@rail402/source tools/conformance/src/live-bazaar.ts \
 *     --facilitator https://… [--seller https://…|local] [--network testnet|pubnet] [--only id,id] \
 *     [--write [--allow-branch <branch>]]
 *
 * Sellers:
 * - `--seller <url>`: a deployed demo seller (apps/demo-seller) whose payTo holds a USDC trustline and
 *   sets the seller's host as its home_domain, and whose stellar.toml lists it. Listings persist
 *   between runs: a resource that is already listed
 *   reports `recorded` instead of `awaiting_origin_verification`, and the checks accept either.
 * - `--seller local` (the default on testnet): the same demo seller, started by the run on 127.0.0.1
 *   with a fresh payTo that holds a USDC trustline and names 127.0.0.1 as its home_domain.
 * - A second seller always runs locally on testnet for the second-asset and upto cases: a route priced
 *   in the TEST6 test token (6 decimals) and an upto route priced at its cap in USDC, declared with the
 *   Rail402 seller helpers on the stock express middleware.
 * Resources on 127.0.0.1 are cataloged only by a facilitator started with
 * `DISCOVERY_ALLOW_LOOPBACK=true` (a local conformance run); against any other facilitator the second
 * seller's cases, and the redirect case whose seller listens there, are skipped with that reason.
 *
 * The catalog's URL and pricing defences are exercised black-box: a payment the seller's 402 asked for
 * that echoes a resource URL on a private, loopback, link-local or metadata address, with credentials,
 * in another scheme, on a public name that resolves to a private address, or spelled with encoded dot
 * segments and separators (also in the route template), and payments whose amount or asset is not the
 * one the seller's 402 asks for. Each refusal must carry its documented code and a non-empty reason; a
 * listing it reaches must never be published with the forged URL or price.
 *
 * Testnet: fresh buyer accounts are created for each run from Friendbot and the testnet pool. The
 * second seller that claims the demo seller's MCP tool is one fixed testnet account derived from the
 * operator's sponsor seed (the file RAIL402_SPONSOR_SECRET_FILE names), so reruns reuse its one
 * listing instead of adding another to the catalog each time; without that file it is a fresh account.
 *
 * Pubnet (`--network pubnet`): a deployed Rail402 and a public seller, both https. The run funds from
 * the operator treasury through the whole-run ledger and caps (`network.ts`): it refuses to start
 * without the pubnet settings and RAIL402_PUBNET_RUN_CONFIRM, sends the API key from
 * RAIL402_FACILITATOR_API_KEY_FILE as a Bearer token, counts every /settle against the caps before it is
 * sent, pays in pubnet USDC only, and returns every account's funds to the treasury at the end. Its
 * extra cases assert the pubnet catalog policy: plain http and `mcp://` tools are refused.
 *
 * With --write the run is recorded as schemaVersion 2 evidence.
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { parseArgs } from "node:util";
import { ok, strictEqual } from "node:assert/strict";
import express from "express";
import { Operation, type Keypair } from "@stellar/stellar-sdk";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { paymentMiddleware } from "@x402/express";
import { bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme as ExactStellarServer } from "@x402/stellar/exact/server";
import { lookup } from "node:dns/promises";
import { createServer } from "node:http";
import { isPublicAddress } from "@rail402.dev/safe-fetch";
import { createSeller } from "@rail402.dev/demo-seller";
import {
  UptoStellarServerScheme,
  checkSellerOrigin,
  exact,
  httpRoute,
  param,
  setUptoCharge,
  upto,
} from "@rail402.dev/sdk/seller";
import { UptoStellarScheme as UptoStellarClient } from "@rail402.dev/upto/client";
import { LocalNetwork, type PaymentRequirementsLike } from "@rail402.dev/testkit";
import {
  TESTNET_FRIENDBOT_URL,
  TESTNET_RPC_URL,
  Treasury,
  gitCommit,
  log,
  operatorAccount,
  versions,
} from "./testnet.ts";
import {
  NETWORK_OPTION,
  ProfileError,
  ProfileNetwork,
  assertSwept,
  feeCeilingStroops,
  parseNetworkId,
  profileEvidence,
  resolveProfile,
  startRun,
  sweepObservation,
  withRun,
  type Funder,
  type SweepResult,
} from "./network.ts";
import {
  harnessProvenance,
  recheckProvenance,
  runFileName,
  writeEvidence,
  type CheckId,
  type SkipCategory,
} from "./evidence.ts";
import {
  CaseRecorder,
  buildEvidence,
  readTarget,
  settledTransaction,
  type CaseContext,
  type CaseSpec,
  type Target,
} from "./harness.ts";
import { checkTest6OnChain, test6Asset, test6Faucet } from "./test-token.ts";

const { values: args } = parseArgs({
  options: {
    facilitator: { type: "string", default: "http://localhost:8080" },
    seller: { type: "string", default: "local" },
    only: { type: "string" },
    write: { type: "boolean", default: false },
    "allow-branch": { type: "string" },
    ...NETWORK_OPTION,
  },
});

const PROFILE = resolveProfile(parseNetworkId(args.network));
const NETWORK = PROFILE.caip2;
const PUBNET = PROFILE.id === "pubnet";
const USDC_ADDRESS = PROFILE.usdc.contract;
/** The other network: a filter on it matches none of this run's listings. */
const OTHER_NETWORK = PUBNET ? "stellar:testnet" : "stellar:pubnet";
if (PUBNET) {
  // A pubnet catalog never reaches loopback, and its listings are https only: both ends are public.
  for (const [flag, value] of [
    ["--facilitator", args.facilitator],
    ["--seller", args.seller],
  ] as const) {
    if (!URL.canParse(value) || new URL(value).protocol !== "https:") {
      throw new ProfileError(
        "pubnet_target_missing",
        `a pubnet run needs ${flag} as the https URL of a public deployment`,
      );
    }
  }
}

// Evidence is recorded only from a clean commit on main, checked before any testnet funds are spent.
const provenance = args.write ? harnessProvenance({ allowBranch: args["allow-branch"] }) : undefined;

const FACILITATOR = args.facilitator.replace(/\/+$/, "");
const net: LocalNetwork = PUBNET
  ? new ProfileNetwork(PROFILE)
  : new LocalNetwork(TESTNET_RPC_URL, TESTNET_FRIENDBOT_URL);
const RPC_URL = PROFILE.rpcUrls[0] ?? TESTNET_RPC_URL;
/** How long to wait for the facilitator's background origin check. */
const ORIGIN_CHECK_WAIT_MS = 90_000;
/** How long to wait for a published listing to reach the search index. */
const SEARCH_INDEX_WAIT_MS = 120_000;
/**
 * The second seller: derived from the operator's sponsor seed (`operatorAccount`), so reruns reuse its
 * listing and nobody else can sign for it; a fresh account without the seed file.
 */
const SECOND_SELLER_ACCOUNT = PUBNET ? undefined : operatorAccount("live-bazaar second seller");
const TEST6 = test6Asset();
/** The TEST6 route's price in whole tokens: 10000 base units at 6 decimals. */
const TEST6_PRICE = "0.01";
/** The upto route's cap; the seller charges `UPTO_CHARGE` base units of it after serving. */
const UPTO_CAP = "$0.01";
const UPTO_CHARGE = 40_000n;
/** What both of the second seller's routes are about, for search. */
const TIDES_QUERY = "tide tables for a harbour";
/** Buyer accounts; each pays a handful of the run's settlements. */
const BUYERS = PUBNET ? 2 : 10;
/** Payments one pubnet buyer is funded for, at the seller's highest price. */
const PAYMENTS_PER_BUYER = 20;
/** The most settlements a pubnet run sends: its cases need fewer, a retry or two included. */
const PUBNET_MAX_SETTLEMENTS = 70;

/** Base units of a 7-decimal asset as a decimal amount. */
function units(baseUnits: bigint): string {
  const whole = baseUnits / 10_000_000n;
  const fraction = (baseUnits % 10_000_000n).toString().padStart(7, "0").replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole.toString()}.${fraction}`;
}

// ---------------------------------------------------------------------------------------------

interface Outcome {
  status: string;
  code: string;
  reason?: string;
  rejectedReason?: string;
  listingId?: string;
  version?: number;
  dropped?: string[];
}

interface ListingSummary {
  id: string;
  network: string;
  trust: string;
  owner: string;
  version: number;
  settlements: number;
  stellar?: {
    checkedAt: string;
    domain?: { host: string; claimsOwner: boolean; homeDomainMatches: boolean };
  };
}

/** A discovery item; from the detail route, one listing with its state. */
interface Listing {
  resource: string;
  type: string;
  accepts: { scheme: string; payTo: string; amount: string; asset: string; network: string }[];
  description?: string;
  state: string;
  extensions: Record<string, Record<string, unknown>> & { bazaar: Record<string, unknown> };
  rail402: {
    trust: string;
    settlements: number;
    method?: string;
    listings: ListingSummary[];
    options: { listing: string; symbol?: string; name?: string; decimals?: number; receivable?: boolean }[];
  };
}

/** The listing behind a single-network item, such as every detail response. */
function only(item: Listing): ListingSummary {
  const [first] = item.rail402.listings;
  ok(first !== undefined && item.rail402.listings.length === 1, "one listing");
  return first;
}

const recorder = new CaseRecorder(args.only?.split(",").map((id) => id.trim()));
/** The running case, and the settlements it made so far. */
let current: CaseContext | undefined;
let settlements: unknown[] = [];
/** Transaction hashes already in the evidence, so a repeated settlement is recorded once. */
const recorded = new Set<string>();

async function check(spec: CaseSpec, run: () => Promise<void>) {
  await recorder.run(spec, async (context) => {
    current = context;
    settlements = [];
    try {
      await run();
    } finally {
      current = undefined;
    }
  });
}

const spec = (id: string, title: string, checks: CheckId[] = ["discovery"]): CaseSpec => ({
  id,
  title,
  checks,
});

// ---------------------------------------------------------------------------------------------

/** A seller's unpaid 402 for a request. */
async function paymentRequired(url: string, init?: RequestInit): Promise<PaymentRequired> {
  const response = await fetch(url, init);
  strictEqual(response.status, 402, `${url} answers 402`);
  return decodePaymentRequiredHeader(response.headers.get("payment-required") ?? "");
}

type Payload = Record<string, unknown> & { payload: Record<string, unknown> };

/** A signed exact payment for a 402, as a stock client builds it, echoing resource and extensions. */
async function payFor(payer: Keypair, required: PaymentRequired, requirements = required.accepts[0]) {
  if (requirements === undefined) throw new Error("the 402 offers no payment option");
  // A pubnet run pays in USDC only: an option in any other asset is never signed.
  if (PUBNET && requirements.asset !== USDC_ADDRESS) {
    throw new ProfileError(
      "pubnet_asset_not_allowed",
      `a pubnet run pays in USDC (${USDC_ADDRESS}) only, not ${requirements.asset}`,
    );
  }
  const signed = await net.payment(payer, requirements as unknown as PaymentRequirementsLike);
  return { payload: payloadOf(required, requirements, signed.payload), requirements };
}

/** A signed upto payment for a 402's upto option, by `@rail402.dev/upto`'s client. */
async function payUpto(payer: Keypair, required: PaymentRequired) {
  const requirements = required.accepts.find((option) => option.scheme === "upto");
  if (requirements === undefined) throw new Error("the 402 offers no upto option");
  const client = new UptoStellarClient(createEd25519Signer(payer.secret(), NETWORK), {
    rpcConfig: { url: RPC_URL },
  });
  const created = await client.createPaymentPayload(2, requirements);
  return { payload: payloadOf(required, requirements, created.payload), requirements };
}

function payloadOf(
  required: PaymentRequired,
  requirements: PaymentRequirements,
  signed: Record<string, unknown>,
): Payload {
  return {
    x402Version: 2,
    resource: required.resource,
    accepted: requirements,
    payload: signed,
    ...(required.extensions === undefined ? {} : { extensions: required.extensions }),
  };
}

interface Settled {
  transaction: string;
  amount?: string;
  outcome: Outcome | undefined;
}

/**
 * Settles through the facilitator and returns its result with the decoded Bazaar outcome. A new
 * on-chain settlement is read back from the chain into the case's evidence.
 */
async function settle(payload: Payload, requirements: PaymentRequirements, decimals = 7): Promise<Settled> {
  const response = await fetch(`${FACILITATOR}/settle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: requirements }),
  });
  const body = (await response.json()) as {
    success: boolean;
    transaction: string;
    payer?: string;
    amount?: string;
  };
  ok(body.success, `settlement succeeds: ${JSON.stringify(body)}`);
  const header = response.headers.get("extension-responses") ?? "";
  ok(Buffer.byteLength(header) <= 4_096, `EXTENSION-RESPONSES is ${String(header.length)} bytes`);
  const outcome =
    header === ""
      ? undefined
      : (JSON.parse(Buffer.from(header, "base64").toString()) as { bazaar?: Outcome }).bazaar;
  if (body.transaction !== "" && !recorded.has(body.transaction)) {
    recorded.add(body.transaction);
    current?.transaction(
      await settledTransaction(net, body.transaction, {
        scheme: requirements.scheme,
        asset: requirements.asset,
        decimals,
        amount: body.amount ?? requirements.amount,
        payerType: body.payer?.startsWith("C") === true ? "C" : "G",
      }),
    );
  }
  settlements.push({
    transaction: body.transaction,
    ...(body.amount === undefined ? {} : { amount: body.amount }),
    ...(outcome === undefined ? {} : { outcome }),
    headerBytes: header.length,
  });
  current?.observe("settlements", settlements);
  return {
    transaction: body.transaction,
    ...(body.amount === undefined ? {} : { amount: body.amount }),
    outcome,
  };
}

async function listing(id: string): Promise<Listing> {
  const response = await fetch(`${FACILITATOR}/discovery/resources/${id}`);
  strictEqual(response.status, 200, `listing ${id} exists`);
  return (await response.json()) as Listing;
}

/** Waits until the facilitator's origin check has moved the listing out of `pending`. */
async function settled(id: string, want: string): Promise<Listing> {
  const deadline = Date.now() + ORIGIN_CHECK_WAIT_MS;
  for (;;) {
    const found = await listing(id);
    if (found.state === want || Date.now() > deadline) {
      strictEqual(found.state, want, `listing ${id} state`);
      return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

/**
 * The published listing once the catalog read its Stellar facts: a background round after it was
 * published, so a listing just published carries no token facts yet.
 */
async function withFacts(id: string): Promise<Listing> {
  const deadline = Date.now() + ORIGIN_CHECK_WAIT_MS;
  for (;;) {
    const found = await settled(id, "published");
    if (only(found).stellar !== undefined || Date.now() > deadline) {
      ok(only(found).stellar !== undefined, `listing ${id} facts were read`);
      return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

async function record(found: Listing) {
  const history = (await (
    await fetch(`${FACILITATOR}/discovery/resources/${only(found).id}/versions`)
  ).json()) as {
    versions: { version: number; cause: string; state: string }[];
  };
  current?.observe("listing", {
    id: only(found).id,
    state: found.state,
    trust: only(found).trust,
    resource: found.resource,
    version: only(found).version,
  });
  current?.observe(
    "versions",
    history.versions.map(({ version, cause, state }) => ({ version, cause, state })),
  );
  return history.versions;
}

const outcomeCode = (outcome: Outcome | undefined) => outcome?.code ?? "none";

/** A new resource waits for its origin; one listed by an earlier run is recorded. */
function expectCataloged(outcome: Outcome | undefined) {
  ok(
    ["awaiting_origin_verification", "recorded"].includes(outcomeCode(outcome)),
    `cataloging outcome: ${JSON.stringify(outcome)}`,
  );
  ok(outcome?.listingId !== undefined, "the outcome names the listing");
}

interface SearchItem {
  resource: string;
  accepts: { scheme: string; asset: string; amount: string }[];
}

/** `GET /discovery/search` with `params`; the resources it answers. */
async function search(params: Record<string, string>): Promise<SearchItem[]> {
  const response = await fetch(`${FACILITATOR}/discovery/search?${new URLSearchParams(params).toString()}`);
  strictEqual(response.status, 200, `search ${JSON.stringify(params)} answers 200`);
  return ((await response.json()) as { resources: SearchItem[] }).resources;
}

/** Repeats a search until `resource` is among its results, as the index catches up with the catalog. */
async function searchUntilFound(params: Record<string, string>, resource: string): Promise<SearchItem[]> {
  const deadline = Date.now() + SEARCH_INDEX_WAIT_MS;
  for (;;) {
    const found = await search(params);
    if (found.some((item) => item.resource === resource)) return found;
    if (Date.now() > deadline) throw new Error(`search ${JSON.stringify(params)} never returned ${resource}`);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}

// --- sellers -------------------------------------------------------------------------------------

interface RunningSeller {
  readonly url: string;
  close(): Promise<void>;
}

async function listen(app: express.Express): Promise<RunningSeller> {
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

const TEST6_PATH = "/tides";
const UPTO_PATH = "/metered-tides";

/**
 * The second seller: the stock express middleware with the exact and upto server schemes and the
 * bazaar extension. One route is priced in TEST6; one upto route is priced at its cap in USDC and
 * charges `UPTO_CHARGE` after serving.
 */
function secondSeller(payTo: string): express.Express {
  const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: FACILITATOR }))
    .register(NETWORK, new ExactStellarServer())
    .register(NETWORK, new UptoStellarServerScheme())
    .registerExtension(bazaarResourceServerExtension);
  const query = {
    harbour: param.string({ description: "Harbour name", required: true, example: "Izmir", maxLength: 80 }),
  };
  const output = { example: { harbour: "Izmir", highWater: "06:12", lowWater: "12:31" } };
  const test6 = httpRoute({
    method: "GET",
    path: TEST6_PATH,
    description: "Tide tables for a harbour, priced in the TEST6 test token",
    payment: exact({
      network: NETWORK,
      payTo,
      price: { amount: TEST6_PRICE, asset: TEST6.contract, decimals: TEST6.decimals },
    }),
    query,
    output,
  });
  const metered = httpRoute({
    method: "GET",
    path: UPTO_PATH,
    description: "Metered tide tables for a harbour, charged per use up to the price",
    payment: upto({ network: NETWORK, payTo, maxPrice: UPTO_CAP }),
    query,
    output,
  });
  const app = express();
  app.use(paymentMiddleware({ [test6.key]: test6.config, [metered.key]: metered.config }, resourceServer));
  const tides = (harbour: unknown) => ({
    harbour: typeof harbour === "string" ? harbour.slice(0, 80) : "Izmir",
    highWater: "06:12",
    lowWater: "12:31",
  });
  app.get(TEST6_PATH, (request, response) => {
    response.json(tides(request.query["harbour"]));
  });
  app.get(UPTO_PATH, (request, response) => {
    setUptoCharge(response, UPTO_CHARGE);
    response.json(tides(request.query["harbour"]));
  });
  return app;
}

// ---------------------------------------------------------------------------------------------

async function main() {
  const target = await readTarget(FACILITATOR);
  log(`facilitator ${FACILITATOR} (version ${target.healthVersion}) on ${NETWORK}`);
  if (PUBNET) await pubnetRun(target);
  else await testnetRun(target);
}

/** The testnet run: Friendbot-funded accounts, a local or deployed demo seller, and a second seller. */
async function testnetRun(target: Target) {
  await checkTest6OnChain(net.server);
  const claimant = SECOND_SELLER_ACCOUNT;
  if (claimant === undefined) throw new Error("the testnet run needs its second seller's account");

  log("opening a treasury: Friendbot XLM, then 5 USDC from the testnet XLM/USDC pool");
  const treasury = await new Treasury(net).open("5");
  const buyers = await treasury.accounts(BUYERS, "0.2");
  const attacker = await treasury.adopt(claimant.keypair);
  const buyer = (i: number) => buyers[i % buyers.length] as Keypair;
  const [demoPayTo, secondPayTo] = await treasury.accounts(2, "0");
  if (demoPayTo === undefined || secondPayTo === undefined) throw new Error("no seller accounts");

  const demo =
    args.seller === "local"
      ? await listen(
          createSeller({
            payTo: demoPayTo.publicKey(),
            facilitator: new HTTPFacilitatorClient({ url: FACILITATOR }),
          }),
        )
      : { url: args.seller.replace(/\/+$/, ""), close: () => Promise.resolve() };
  if (args.seller === "local") {
    // SEP-1 works both ways: the seller's stellar.toml lists payTo, and payTo names the seller's host.
    await treasury.net.classic(
      treasury.keypair,
      [Operation.setOptions({ homeDomain: new URL(demo.url).hostname, source: demoPayTo.publicKey() })],
      [demoPayTo],
    );
  }
  const second = await listen(secondSeller(secondPayTo.publicKey()));
  const redirecting = await redirectingSeller();
  log(`demo seller ${demo.url}, second seller ${second.url}, redirecting seller ${redirecting.url}`);

  try {
    const weatherId = await demoSellerCases(demo.url, buyer, attacker);
    // Whether this facilitator catalogs resources on 127.0.0.1, where the run's own sellers listen.
    const loopback = await acceptsLoopback(demo.url, buyer(0), redirecting.url);
    await securityCases(demo.url, buyer, weatherId, {
      loopback,
      redirecting,
      test6Payer: async () => {
        const [payer] = await treasury.accounts(1, "0", false);
        if (payer === undefined) throw new Error("no payer");
        await test6Faucet(net, treasury.keypair, payer.publicKey());
        return payer;
      },
    });
    await secondSellerCases(second.url, secondPayTo.publicKey(), treasury, loopback);
  } finally {
    await redirecting.close();
    await second.close();
    await demo.close();
  }

  writeRun(target, {
    config: {
      seller: args.seller === "local" ? "demo seller started by the run on 127.0.0.1" : demo.url,
      secondSeller: "started by the run on 127.0.0.1",
      redirectingSeller: "started by the run on 127.0.0.1",
      "test6.price": `${TEST6_PRICE} TEST6 (${String(TEST6.decimals)} decimals) at GET ${TEST6_PATH}`,
      "upto.cap": `${UPTO_CAP.slice(1)} USDC at GET ${UPTO_PATH}`,
      "upto.charge": `${UPTO_CHARGE.toString()} base units`,
      apiKey: "none",
      mcpClaimantAccount: claimant.origin,
    },
    accounts: {
      treasury: treasury.keypair.publicKey(),
      ...(args.seller === "local" ? { sellerPayTo: demoPayTo.publicKey() } : {}),
      secondSellerPayTo: secondPayTo.publicKey(),
      mcpClaimant: claimant.keypair.publicKey(),
      test6: TEST6.contract,
    },
  });
}

/**
 * The pubnet run: a deployed Rail402 and a public demo seller. Every account is derived from the
 * operator treasury and funded through the run's ledger; at the end its USDC goes back and the accounts
 * are merged into the treasury.
 */
async function pubnetRun(target: Target) {
  const seller = args.seller.replace(/\/+$/, "");
  // The seller's prices bound what the buyers are funded with: reading them spends nothing.
  const prices = await Promise.all(
    [`${seller}/weather?city=Ankara`, `${seller}/users/42`].map(async (url) =>
      BigInt((await paymentRequired(url)).accepts[0]?.amount ?? "0"),
    ),
  );
  const price = prices.reduce((most, amount) => (amount > most ? amount : most), 0n);
  if (price <= 0n) throw new Error(`${seller} answers no priced 402`);
  const perBuyer = price * BigInt(PAYMENTS_PER_BUYER);
  const funder = await startRun("live-bazaar", PROFILE, net, {
    usdc: units(perBuyer * BigInt(BUYERS)),
    facilitators: [FACILITATOR],
  });
  // What the run needs at most, checked against the caps before anything is sent; each settlement is
  // debited again when its /settle is sent.
  try {
    funder.meter.ensure(
      {
        newAccounts: BUYERS + 1,
        settlements: PUBNET_MAX_SETTLEMENTS,
        usdcBaseUnits: perBuyer * BigInt(BUYERS),
        xlmStroops: feeCeilingStroops(PROFILE, "exact") * BigInt(PUBNET_MAX_SETTLEMENTS),
      },
      `up to ${String(PUBNET_MAX_SETTLEMENTS)} settlements`,
    );
  } catch (error) {
    // Nothing was sent: the claimed run ends here, and its ledger refuses any later debit.
    funder.finish();
    throw error;
  }
  const accounts: { buyers: Keypair[]; claimant?: Keypair } = { buyers: [] };
  const sweep: SweepResult = await withRun(funder, async () => {
    accounts.buyers = await funder.accounts(BUYERS, units(perBuyer), true, { role: "buyer" });
    // The claimant is paid to (it holds a USDC trustline) but spends nothing.
    [accounts.claimant] = await funder.accounts(1, "0", true, { role: "claimant" });
    if (accounts.claimant === undefined) throw new Error("no claimant account");
    const buyer = (i: number) => accounts.buyers[i % accounts.buyers.length] as Keypair;
    const weatherId = await demoSellerCases(seller, buyer, accounts.claimant);
    await securityCases(seller, buyer, weatherId, { loopback: false });
    skipSecondSeller(
      "the second seller listens on 127.0.0.1, which a pubnet catalog never reaches, and its TEST6 route has no pubnet deployment",
      "environment",
    );
  });
  await recorder.run(
    {
      id: "sweep-back",
      title: "the run's USDC is back in the operator treasury and its accounts are merged",
      checks: ["pubnet-config"],
    },
    (context) => {
      context.observe("sweep", sweepObservation(sweep));
      assertSwept(sweep);
      return Promise.resolve();
    },
  );
  writeRun(target, {
    config: {
      seller,
      secondSeller: "none: a pubnet catalog never reaches a seller on 127.0.0.1",
      apiKey: PROFILE.facilitator.apiKeyFile === undefined ? "none" : "bearer, from a file",
      asset: `${USDC_ADDRESS} (USDC only)`,
      buyers: `${String(BUYERS)} accounts of ${units(perBuyer)} USDC, derived from the treasury`,
      mcpClaimantAccount: "derived from the treasury (live-bazaar/claimant)",
    },
    accounts: {
      treasury: funder.keypair.publicKey(),
      ...(accounts.claimant === undefined ? {} : { mcpClaimant: accounts.claimant.publicKey() }),
    },
    profile: { funder, sweep },
  });
}

/** Builds the run's evidence; prints it, or with --write records it. */
function writeRun(
  target: Target,
  run: {
    readonly config: Record<string, string>;
    readonly accounts: Record<string, string>;
    readonly profile?: { readonly funder: Funder; readonly sweep: SweepResult };
  },
) {
  const evidence = buildEvidence(
    {
      kind: "live-bazaar",
      // Without --write the document is printed only; its commit may then describe a dirty tree.
      provenance: provenance ?? { commit: gitCommit().replace(/-dirty$/, ""), dirty: false },
      network: NETWORK,
      target,
      packages: versions([
        "@x402/core",
        "@x402/express",
        "@x402/extensions",
        "@x402/stellar",
        "@stellar/stellar-sdk",
        "@rail402.dev/sdk",
        "@rail402.dev/upto",
      ]),
      command:
        `node --conditions=@rail402/source tools/conformance/src/live-bazaar.ts ` +
        `--facilitator ${FACILITATOR} --seller ${args.seller}${PUBNET ? " --network pubnet" : ""}`,
      config: run.config,
      accounts: run.accounts,
      ...(run.profile === undefined
        ? {}
        : { profile: profileEvidence(PROFILE, run.profile.funder, run.profile.sweep) }),
      startedAt: recorder.startedAt,
    },
    recorder.cases,
  );
  if (provenance === undefined) {
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } else {
    recheckProvenance(provenance, { allowBranch: args["allow-branch"] });
    const file = runFileName(evidence);
    log(`evidence written to ${writeEvidence(evidence, { allowBranch: args["allow-branch"], file })}`);
  }
  log(
    `${String(evidence.summary.passed)} passed, ${String(evidence.summary.failed)} failed, ${String(evidence.summary.skipped)} skipped`,
  );
  if (recorder.failed > 0) process.exitCode = 1;
}

// --- the demo seller ------------------------------------------------------------------------------

/** The demo seller's cases; returns the id of its `GET /weather` listing. */
async function demoSellerCases(
  seller: string,
  buyer: (i: number) => Keypair,
  attacker: Keypair,
): Promise<string> {
  const weather = await paymentRequired(`${seller}/weather?city=Ankara`);
  const sellerPayTo = weather.accepts[0]?.payTo ?? "";

  let weatherId = "";
  await check(
    spec(
      "http-listed",
      "an HTTP resource is cataloged after settlement and listed once its own 402 confirms it",
    ),
    async () => {
      const { payload, requirements } = await payFor(buyer(0), weather);
      const { outcome } = await settle(payload, requirements);
      expectCataloged(outcome);
      weatherId = outcome?.listingId ?? "";
      const found = await settled(weatherId, "published");
      ok(["origin_verified", "domain_verified"].includes(only(found).trust), only(found).trust);
      strictEqual(only(found).owner, sellerPayTo, "bound to the settled payTo");
      strictEqual(found.resource, `${seller}/weather`);
      const history = await record(found);
      strictEqual(history[0]?.cause, "settlement");
      ok(history.some((version) => version.cause === "origin_verification" && version.state === "published"));
    },
  );

  await check(
    spec("duplicate-settlement", "a repeated settlement is recorded once and creates no listing", [
      "discovery",
      "idempotency",
    ]),
    async () => {
      const { payload, requirements } = await payFor(buyer(1), weather);
      const first = await settle(payload, requirements);
      const before = only(await listing(weatherId)).settlements;
      const again = await settle(payload, requirements);
      strictEqual(again.transaction, first.transaction);
      strictEqual(outcomeCode(again.outcome), "recorded");
      strictEqual(again.outcome?.listingId, weatherId);
      strictEqual(only(await listing(weatherId)).settlements, before, "counted once");
    },
  );

  await check(spec("settlement-reused", "one settlement catalogs at most one resource"), async () => {
    const { payload, requirements } = await payFor(buyer(2), weather);
    await settle(payload, requirements);
    const users = await paymentRequired(`${seller}/users/7`);
    const replay = { ...payload, resource: users.resource, extensions: users.extensions };
    const { outcome } = await settle(replay, requirements);
    strictEqual(outcomeCode(outcome), "bazaar_settlement_reused");
    ok((outcome?.rejectedReason ?? "").trim() !== "");
  });

  await check(
    spec("route-template", "a route with parameters is one listing under its route template"),
    async () => {
      const first = await payFor(buyer(3), await paymentRequired(`${seller}/users/42`));
      const created = await settle(first.payload, first.requirements);
      expectCataloged(created.outcome);
      const id = created.outcome?.listingId ?? "";
      const found = await settled(id, "published");
      strictEqual(found.resource, `${seller}/users/:id`);
      strictEqual(found.extensions.bazaar["routeTemplate"], "/users/:id");
      const second = await payFor(buyer(4), await paymentRequired(`${seller}/users/7`));
      const again = await settle(second.payload, second.requirements);
      strictEqual(again.outcome?.listingId, id, "another path of the route joins the same listing");
      await record(await listing(id));
    },
  );

  await check(spec("post-body", "a POST resource with a JSON body is listed with its method"), async () => {
    const init = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };
    const { payload, requirements } = await payFor(
      buyer(5),
      await paymentRequired(`${seller}/translate`, init),
    );
    const { outcome } = await settle(payload, requirements);
    expectCataloged(outcome);
    let found = await settled(outcome?.listingId ?? "", "published");
    strictEqual(found.rail402.method, "POST");
    // Its 402 also declares payment-identifier, which the origin check lists with the resource.
    const deadline = Date.now() + ORIGIN_CHECK_WAIT_MS;
    while (found.extensions["payment-identifier"] === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      found = await listing(outcome?.listingId ?? "");
    }
    ok(found.extensions["payment-identifier"] !== undefined, "payment-identifier is listed");
    await record(found);
  });

  await check(spec("owner-conflict", "a different payTo cannot take over or modify a listing"), async () => {
    const before = await listing(weatherId);
    // The attacker is paid for a payment that claims the seller's resource.
    const claim = { ...weather.accepts[0], payTo: attacker.publicKey() } as PaymentRequirements;
    const { payload, requirements } = await payFor(buyer(6), weather, claim);
    const { outcome } = await settle(payload, requirements);
    strictEqual(outcomeCode(outcome), "bazaar_owner_conflict");
    strictEqual(outcome?.listingId, weatherId);
    ok((outcome.rejectedReason ?? "").trim() !== "");
    // The seller's own 402 names the seller, so the claim fails and nothing changes.
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    const after = await listing(weatherId);
    strictEqual(only(after).owner, sellerPayTo);
    strictEqual(only(after).version, only(before).version, "no new version");
    strictEqual(after.state, "published");
  });

  await check(
    spec("forged-metadata", "metadata echoed by a buyer never changes a listing on its own"),
    async () => {
      const { payload, requirements } = await payFor(buyer(7), weather);
      const forged = {
        ...payload,
        resource: { ...weather.resource, description: "Free weather, no payment needed" },
      };
      const { outcome } = await settle(forged, requirements);
      strictEqual(outcomeCode(outcome), "awaiting_origin_verification");
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      strictEqual((await listing(weatherId)).description, "Current weather for a city");
    },
  );

  await check(
    spec("soft-drop", "invalid optional metadata is dropped without failing the payment"),
    async () => {
      const { payload, requirements } = await payFor(buyer(0), weather);
      const noisy = {
        ...payload,
        resource: {
          ...weather.resource,
          serviceName: "A service name far longer than thirty-two characters",
          tags: ["\u0000"],
        },
      };
      const { transaction, outcome } = await settle(noisy, requirements);
      ok(/^[0-9a-f]{64}$/.test(transaction));
      ok(outcome?.dropped?.includes("serviceName") === true, `dropped: ${JSON.stringify(outcome?.dropped)}`);
      ok(outcome.dropped.includes("tags"));
    },
  );

  await check(
    spec("schema-rejected", "metadata is validated against its schema; a rejection never fails the payment", [
      "discovery",
      "rejection-codes",
    ]),
    async () => {
      const { payload, requirements } = await payFor(buyer(1), weather);
      const bazaar = weather.extensions?.["bazaar"] as Record<string, unknown>;
      const external = {
        ...payload,
        extensions: { bazaar: { ...bazaar, schema: { $ref: "https://example.com/schema.json" } } },
      };
      const { transaction, outcome } = await settle(external, requirements);
      ok(/^[0-9a-f]{64}$/.test(transaction), "the payment settled");
      strictEqual(outcomeCode(outcome), "bazaar_schema_external_reference");
      ok((outcome?.rejectedReason ?? "").trim() !== "");
    },
  );

  await check(
    spec(
      "header-bounded",
      "an outcome quoting a huge buyer input stays within any HTTP client's header limit",
    ),
    async () => {
      const { payload, requirements } = await payFor(buyer(2), weather);
      const bazaar = weather.extensions?.["bazaar"] as { info: { input: Record<string, unknown> } } & Record<
        string,
        unknown
      >;
      const huge = {
        ...payload,
        extensions: {
          bazaar: {
            ...bazaar,
            info: { ...bazaar.info, input: { ...bazaar.info.input, type: "x".repeat(20_000) } },
          },
        },
      };
      const { transaction, outcome } = await settle(huge, requirements);
      ok(/^[0-9a-f]{64}$/.test(transaction), "the payment settled");
      strictEqual(outcome?.status, "rejected");
      ok((outcome.rejectedReason ?? "").length <= 300);
    },
  );

  await check(spec("not-x402", "a URL that is not an x402 resource is never listed"), async () => {
    const health = { ...weather, resource: { ...weather.resource, url: `${seller}/health` } };
    const { payload, requirements } = await payFor(buyer(3), health);
    const { outcome } = await settle(payload, requirements);
    ok(outcome?.listingId !== undefined, JSON.stringify(outcome));
    const found = await settled(outcome.listingId, "quarantined");
    await record(found);
    const listed = (await (
      await fetch(`${FACILITATOR}/discovery/resources?payTo=${sellerPayTo}&limit=100`)
    ).json()) as {
      items: { resource: string }[];
    };
    ok(!listed.items.some((item) => item.resource === `${seller}/health`), "not in discovery");
  });

  await check(
    spec(
      "mcp-tool",
      "an MCP tool is listed once its own unpaid call confirms it, keyed by endpoint and tool name and scoped to its owner",
      ["discovery", "mcp"],
    ),
    async () => {
      const endpoint = `${seller}/mcp`;
      // The tool's own 402, read with an unpaid tools/call as the catalog's origin check does.
      const probed = await checkSellerOrigin(endpoint, {
        toolName: "forecast",
        arguments: { city: "Istanbul" },
        network: NETWORK,
        allowLoopback: new URL(endpoint).hostname === "127.0.0.1",
      });
      const tool = probed.paymentRequired;
      ok(tool !== undefined, `the tool asks for payment: ${JSON.stringify(probed.findings)}`);
      const first = await payFor(buyer(4), tool);
      const own = await settle(first.payload, first.requirements);
      expectCataloged(own.outcome);
      const found = await settled(own.outcome?.listingId ?? "", "published");
      strictEqual(found.type, "mcp");
      ok(only(found).trust !== "settled", `trust ${only(found).trust}: confirmed by the tool itself`);
      await record(found);
      // Another payTo declaring the same tool gets its own listing, which the tool's own 402 never
      // confirms: it is quarantined and never listed, and the seller's listing is untouched.
      const claim = { ...first.requirements, payTo: attacker.publicKey() };
      const second = {
        ...tool,
        resource: {
          ...tool.resource,
          description: "Conformance run: a second seller declaring the same tool",
        },
      };
      const other = await payFor(buyer(5), second, claim);
      const theirs = await settle(other.payload, other.requirements);
      ok(theirs.outcome?.listingId !== undefined, JSON.stringify(theirs.outcome));
      ok(theirs.outcome.listingId !== own.outcome?.listingId, "a separate listing");
      await settled(theirs.outcome.listingId, "quarantined");
      const mine = await listing(own.outcome?.listingId ?? "");
      strictEqual(only(mine).owner, sellerPayTo);
      strictEqual(mine.description, found.description);
    },
  );

  await check(
    spec(
      "stellar-facts",
      "a listing carries its token's on-chain facts, whether payTo can receive it, and its domain's SEP-1 claim",
    ),
    async () => {
      const deadline = Date.now() + ORIGIN_CHECK_WAIT_MS;
      let found = await listing(weatherId);
      while (only(found).trust !== "domain_verified" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        found = await listing(weatherId);
      }
      strictEqual(
        only(found).trust,
        "domain_verified",
        "the seller's stellar.toml lists its payTo and the payTo's home_domain names the seller's host",
      );
      const stellar = only(found).stellar;
      ok(stellar !== undefined, "facts were read");
      strictEqual(stellar.domain?.claimsOwner, true);
      strictEqual(stellar.domain.homeDomainMatches, true);
      strictEqual(stellar.domain.host, new URL(seller).host);
      const [option] = found.rail402.options;
      strictEqual(option?.listing, weatherId);
      strictEqual(option.symbol, "USDC");
      strictEqual(option.decimals, 7);
      ok(option.name?.startsWith("USDC:G") === true, `SAC name ${String(option.name)}`);
      strictEqual(option.receivable, true, "the seller holds a USDC trustline");
      const history = await record(found);
      ok(history.some((version) => version.cause === "domain_verification"));
    },
  );

  await check(
    spec(
      "discovery",
      "GET /discovery/resources filters by type, payTo, network and extensions and pages stably",
    ),
    async () => {
      const get = async (query: string) =>
        (await (await fetch(`${FACILITATOR}/discovery/resources?${query}`)).json()) as {
          items: Listing[];
          pagination: { total: number; asOf: string };
        };
      const mine = await get(`payTo=${sellerPayTo}&limit=100`);
      ok(mine.pagination.total >= 4, `the seller has ${String(mine.pagination.total)} listings`);
      ok(mine.items.every((item) => item.accepts.some((option) => option.payTo === sellerPayTo)));
      strictEqual(
        (await get(`payTo=${sellerPayTo}&type=mcp&limit=100`)).items.every((i) => i.type === "mcp"),
        true,
      );
      strictEqual(
        (await get(`payTo=${sellerPayTo}&type=http&limit=100`)).items.every((i) => i.type === "http"),
        true,
      );
      strictEqual(
        (await get(`payTo=${sellerPayTo}&network=${NETWORK}&limit=100`)).pagination.total,
        mine.pagination.total,
      );
      strictEqual((await get(`payTo=${sellerPayTo}&network=${OTHER_NETWORK}&limit=100`)).pagination.total, 0);
      strictEqual(
        (await get(`payTo=${sellerPayTo}&extensions=bazaar&limit=100`)).pagination.total,
        mine.pagination.total,
      );
      // Every page of one pagination is pinned to the first page's asOf.
      const asOf = encodeURIComponent(mine.pagination.asOf);
      const pages = [];
      for (let offset = 0; offset < mine.pagination.total; offset += 2) {
        pages.push(
          ...(await get(`payTo=${sellerPayTo}&limit=2&offset=${String(offset)}&asOf=${asOf}`)).items,
        );
      }
      strictEqual(
        pages.map((item) => only(item).id).join(),
        mine.items.map((item) => only(item).id).join(),
        "pages of two join into the full list, in the same order",
      );
      // The seller's POST route declares payment-identifier in its 402; its other routes do not.
      const identified = await get(`payTo=${sellerPayTo}&extensions=payment-identifier&limit=100`);
      ok(
        identified.items.some((item) => item.resource === `${seller}/translate`),
        "the POST route declares payment-identifier",
      );
      ok(
        identified.items.every((item) => item.extensions["payment-identifier"] !== undefined),
        "every match declares it",
      );
      ok(!identified.items.some((item) => item.resource === `${seller}/weather`), "GET /weather does not");
      current?.observe(
        "catalog",
        mine.items.map((item) => ({
          resource: item.resource,
          type: item.type,
          extensions: Object.keys(item.extensions),
          listings: item.rail402.listings.map(({ id, network, trust, version, settlements: count }) => ({
            id,
            network,
            trust,
            version,
            settlements: count,
          })),
        })),
      );
    },
  );
  return weatherId;
}

// --- URL and pricing defences ---------------------------------------------------------------------

/**
 * A seller on 127.0.0.1 that answers every request with a 302 to the run's canary server, which counts
 * what reaches it: a catalog that followed the redirect would show there.
 */
async function redirectingSeller(): Promise<RunningSeller & { canaryHits: () => number }> {
  let hits = 0;
  const canary = createServer((_request, response) => {
    hits++;
    response.writeHead(200, { "content-type": "text/plain" }).end("canary");
  });
  await new Promise<void>((resolve) => canary.listen(0, "127.0.0.1", resolve));
  const canaryUrl = `http://127.0.0.1:${String((canary.address() as AddressInfo).port)}/latest/meta-data/`;
  const app = express();
  app.use((_request, response) => {
    response.redirect(302, canaryUrl);
  });
  const seller = await listen(app);
  return {
    url: seller.url,
    canaryHits: () => hits,
    close: async () => {
      canary.closeAllConnections();
      await new Promise((resolve) => canary.close(resolve));
      await seller.close();
    },
  };
}

/**
 * Pays the 402 a seller answered `required` with, as a stock client does, but echoes `url` as the
 * resource (and `extensions`, when given): the payment settles, and the catalog alone judges the URL.
 */
async function claim(
  payer: Keypair,
  required: PaymentRequired,
  url: string,
  options: {
    readonly extensions?: Record<string, unknown>;
    readonly requirements?: PaymentRequirements;
    readonly decimals?: number;
  } = {},
): Promise<Settled> {
  const { payload, requirements } = await payFor(payer, required, options.requirements);
  return settle(
    {
      ...payload,
      resource: { ...required.resource, url },
      ...(options.extensions === undefined ? {} : { extensions: options.extensions }),
    },
    requirements,
    options.decimals,
  );
}

/** The outcome is the documented refusal `code`, with a non-empty reason, recorded as a rejection. */
function expectRefused(outcome: Outcome | undefined, code: string, operation: string) {
  strictEqual(outcomeCode(outcome), code, `${operation}: ${JSON.stringify(outcome)}`);
  const reason = outcome?.rejectedReason ?? "";
  ok(reason.trim() !== "", `${operation}: the outcome carries a reason`);
  current?.rejection({ surface: "bazaar", operation, code, reason });
}

/**
 * Whether the facilitator catalogs resources on 127.0.0.1: a payment that names the run's redirecting
 * seller is refused as unsafe by a facilitator that does not. Recorded in no case.
 */
async function acceptsLoopback(seller: string, payer: Keypair, redirecting: string): Promise<boolean> {
  const weather = await paymentRequired(`${seller}/weather?city=Ankara`);
  const { outcome } = await claim(payer, weather, `${redirecting}/probe`);
  const accepted = outcomeCode(outcome) !== "bazaar_resource_unsafe";
  log(`the facilitator ${accepted ? "catalogs" : "refuses"} resources on 127.0.0.1`);
  return accepted;
}

interface SecurityOptions {
  /** The facilitator catalogs resources on 127.0.0.1 (a local conformance run). */
  readonly loopback: boolean;
  /** The run's redirecting seller (testnet runs; it listens on 127.0.0.1). */
  readonly redirecting?: RunningSeller & { canaryHits: () => number };
  /** A fresh payer holding TEST6 (testnet runs). */
  readonly test6Payer?: () => Promise<Keypair>;
}

/** Private, link-local, metadata, IPv6 and encoded-IP hosts, each refused as `bazaar_resource_unsafe`. */
const PRIVATE_URLS = [
  "https://10.0.0.1/weather",
  "https://172.16.0.1/weather",
  "https://192.168.1.10/weather",
  "https://100.64.0.1/weather",
  "https://169.254.169.254/latest/meta-data/",
  "https://[fd00:ec2::254]/latest/meta-data/",
  "https://[fe80::1]/weather",
  "https://[::ffff:10.0.0.1]/weather",
  // 10.0.0.1 and 169.254.169.254 spelled as one decimal and one hex number.
  "https://167772161/weather",
  "https://0xa9fea9fe/latest/meta-data/",
  "https://metadata.google.internal/computeMetadata/v1/",
  "https://intranet/weather",
] as const;

/** Loopback hosts: refused as unsafe by every catalog that does not run a local conformance run. */
const LOOPBACK_URLS = [
  "https://127.0.0.1/weather",
  "https://127.1/weather",
  "https://localhost/weather",
  "https://[::1]/weather",
] as const;

/** A public DNS name whose answer is the link-local metadata address. */
const PRIVATE_NAME = "169.254.169.254.nip.io";

async function securityCases(
  seller: string,
  buyer: (i: number) => Keypair,
  weatherId: string,
  options: SecurityOptions,
) {
  const host = new URL(seller).host;
  const weather = await paymentRequired(`${seller}/weather?city=Ankara`);
  let next = 0;
  const payer = () => buyer(next++);

  await check(
    spec(
      "unsafe-private-address",
      "a resource on a private, carrier-grade NAT, link-local, metadata, IPv6 unique-local or local-only host, also spelled as a decimal, hex or IPv4-mapped address, is refused",
      ["discovery", "rejection-codes"],
    ),
    async () => {
      for (const url of PRIVATE_URLS) {
        const { outcome } = await claim(payer(), weather, url);
        expectRefused(outcome, "bazaar_resource_unsafe", `catalog ${url}`);
      }
      current?.observe("urls", PRIVATE_URLS);
    },
  );

  const loopbackSpec = spec("unsafe-loopback", "a resource on a loopback host is refused", [
    "discovery",
    "rejection-codes",
  ]);
  if (options.loopback) {
    recorder.skip(
      loopbackSpec,
      "this facilitator catalogs 127.0.0.1 on purpose (DISCOVERY_ALLOW_LOOPBACK, a local conformance run); the run against a deployed Rail402 proves the refusal",
      "not-applicable",
    );
  } else {
    await check(loopbackSpec, async () => {
      for (const url of LOOPBACK_URLS) {
        const { outcome } = await claim(payer(), weather, url);
        expectRefused(outcome, "bazaar_resource_unsafe", `catalog ${url}`);
      }
    });
  }

  await check(
    spec("unsafe-credentials", "a resource URL carrying credentials is refused", [
      "discovery",
      "rejection-codes",
    ]),
    async () => {
      for (const url of [`https://user:secret@${host}/weather`, `https://token@${host}/weather`]) {
        const { outcome } = await claim(payer(), weather, url);
        expectRefused(
          outcome,
          "bazaar_resource_invalid",
          `catalog ${url.replace(/\/\/[^@]*@/, "//<credentials>@")}`,
        );
        ok(/credentials/i.test(outcome?.rejectedReason ?? ""), "the reason names the credentials");
      }
    },
  );

  await check(
    spec("unsafe-scheme", "a resource URL in a scheme other than http(s) is refused", [
      "discovery",
      "rejection-codes",
    ]),
    async () => {
      for (const url of ["file:///etc/passwd", `gopher://${host}/weather`, `ftp://${host}/weather`]) {
        const { outcome } = await claim(payer(), weather, url);
        expectRefused(outcome, "bazaar_resource_invalid", `catalog ${url}`);
      }
    },
  );

  const httpsSpec = spec("pubnet-https-only", "on pubnet a resource served over plain http is refused", [
    "discovery",
    "rejection-codes",
  ]);
  if (!PUBNET) {
    recorder.skip(
      httpsSpec,
      "the https-only rule applies on stellar:pubnet; testnet lists http resources",
      "not-applicable",
    );
  } else {
    await check(httpsSpec, async () => {
      const url = `http://${host}/weather`;
      const { outcome } = await claim(payer(), weather, url);
      expectRefused(outcome, "bazaar_resource_invalid", `catalog ${url}`);
    });
  }

  const originlessSpec = spec(
    "pubnet-mcp-originless",
    "on pubnet an MCP tool under an mcp:// URL, which has no origin to check, is refused",
    ["discovery", "mcp", "rejection-codes"],
  );
  if (!PUBNET) {
    recorder.skip(
      originlessSpec,
      "testnet lists an mcp:// tool on settlement at trust settled, as documented; pubnet refuses it",
      "not-applicable",
    );
  } else {
    await check(originlessSpec, async () => {
      const probed = await checkSellerOrigin(`${seller}/mcp`, {
        toolName: "forecast",
        arguments: { city: "Istanbul" },
        network: NETWORK,
        allowLoopback: false,
      });
      const tool = probed.paymentRequired;
      ok(tool !== undefined, `the tool asks for payment: ${JSON.stringify(probed.findings)}`);
      const url = `mcp://${host}/forecast`;
      const { outcome } = await claim(payer(), tool, url);
      expectRefused(outcome, "bazaar_resource_unverifiable", `catalog ${url}`);
    });
  }

  const dnsSpec = spec(
    "ssrf-private-name",
    "a resource on a public DNS name that resolves to a private address is never fetched into a listing: it is held, never published",
    ["discovery"],
  );
  const resolved = await lookup(PRIVATE_NAME, { all: true }).catch(() => []);
  if (resolved.length === 0 || resolved.some((entry) => isPublicAddress(entry.address))) {
    recorder.skip(dnsSpec, `${PRIVATE_NAME} does not resolve to a private address from here`, "environment");
  } else {
    await check(dnsSpec, async () => {
      const url = `https://${PRIVATE_NAME}/latest/meta-data/`;
      const { outcome } = await claim(payer(), weather, url);
      // The name is public, so the payment proposes a listing; the origin check resolves it, refuses
      // the address and keeps retrying, so the listing is never published.
      expectCataloged(outcome);
      const id = outcome?.listingId ?? "";
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      const found = await listing(id);
      ok(found.state !== "published", `listing ${id} is ${found.state}`);
      const listed = await listedResources(weather.accepts[0]?.payTo ?? "");
      ok(!listed.includes(found.resource), "not in discovery");
      current?.observe(
        "resolved",
        resolved.map((entry) => entry.address),
      );
      await record(found);
    });
  }

  const redirectSpec = spec(
    "ssrf-redirect",
    "a resource whose server redirects is never followed: the redirect target is never requested and the listing is withdrawn",
    ["discovery"],
  );
  const redirecting = options.redirecting;
  if (!options.loopback || redirecting === undefined) {
    recorder.skip(
      redirectSpec,
      "needs a seller that redirects, which this run serves on 127.0.0.1, and this catalog does not reach 127.0.0.1; the local run proves it",
      "environment",
    );
  } else {
    await check(redirectSpec, async () => {
      const url = `${redirecting.url}/latest`;
      const { outcome } = await claim(payer(), weather, url);
      expectCataloged(outcome);
      const found = await settled(outcome?.listingId ?? "", "quarantined");
      const history = await record(found);
      const last = history.at(-1) as { reason?: string } | undefined;
      strictEqual(last?.reason, "origin_not_payment_required", "withdrawn: the origin did not answer 402");
      strictEqual(redirecting.canaryHits(), 0, "the redirect target was never requested");
    });
  }

  await check(
    spec(
      "traversal-dot-segments",
      "percent-encoded dot segments in a resource path are resolved before the catalog keys it: the spelling joins the listing it names",
      ["discovery"],
    ),
    async () => {
      ok(weatherId !== "", "needs the http-listed listing");
      for (const path of ["/x/%2e%2e/weather", "/x/%2E%2E/weather", "/x/.%2e/weather", "/x/./../weather"]) {
        const { outcome } = await claim(payer(), weather, `${seller}${path}`);
        ok(
          ["awaiting_origin_verification", "recorded"].includes(outcomeCode(outcome)),
          `${path}: ${JSON.stringify(outcome)}`,
        );
        strictEqual(outcome?.listingId, weatherId, `${path} is the GET /weather listing`);
      }
    },
  );

  await check(
    spec(
      "traversal-encoded-separators",
      "double-encoded dot segments, an encoded slash, backslash or NUL stay literal: the path never climbs and the listing is withdrawn",
      ["discovery"],
    ),
    async () => {
      const paths = ["/x/%252e%252e/weather", "/weather%2f..%2fadmin", "/x/%5c..%5cweather", "/weather%00"];
      const ids: string[] = [];
      for (const path of paths) {
        const { outcome } = await claim(payer(), weather, `${seller}${path}`);
        expectCataloged(outcome);
        const id = outcome?.listingId ?? "";
        ok(id !== weatherId, `${path} is not the GET /weather listing`);
        ids.push(id);
      }
      const resources = [];
      for (const id of ids) {
        // The seller has no such route: its 404 withdraws the listing, which is never published.
        const found = await settled(id, "quarantined");
        ok(!/\/\.\.?(?:\/|$)/.test(new URL(found.resource).pathname), `${found.resource} has no dot segment`);
        ok(/%[0-9A-F]{2}/.test(found.resource), `${found.resource} keeps its escapes`);
        resources.push(found.resource);
      }
      current?.observe("resources", resources);
    },
  );

  await check(
    spec(
      "traversal-route-template",
      "a route template that is unsafe once percent-decoded is dropped: the payment lists the concrete path it paid",
      ["discovery"],
    ),
    async () => {
      const users = await paymentRequired(`${seller}/users/42`);
      const bazaar = users.extensions?.["bazaar"] as Record<string, unknown> | undefined;
      ok(bazaar !== undefined, "the route declares the bazaar extension");
      const resources: string[] = [];
      for (const routeTemplate of [
        "/%2e%2e/:id",
        "/users%2f..%2f:id",
        "/users/%252e%252e%252f:id",
        "/users/%5c:id",
      ]) {
        const { outcome } = await claim(payer(), users, users.resource.url, {
          extensions: { ...users.extensions, bazaar: { ...bazaar, routeTemplate } },
        });
        ok(
          outcome?.dropped?.includes("routeTemplate") === true,
          `${routeTemplate}: ${JSON.stringify(outcome)}`,
        );
        const found = await listing(outcome.listingId ?? "");
        strictEqual(found.resource, `${seller}/users/42`, `${routeTemplate}: the concrete path`);
        resources.push(found.resource);
      }
      current?.observe("resources", resources);
    },
  );

  await check(
    spec(
      "forged-price",
      "a payment for less than the seller's price never lists that price: the listing keeps the price of the seller's own 402",
      ["discovery"],
    ),
    async () => {
      ok(weatherId !== "", "needs the http-listed listing");
      const asked = weather.accepts[0];
      if (asked === undefined) throw new Error("the 402 offers no payment option");
      const forged: PaymentRequirements = { ...asked, amount: "1" };
      const { outcome } = await claim(payer(), weather, weather.resource.url, { requirements: forged });
      if (outcomeCode(outcome) === "bazaar_settlement_below_minimum") {
        expectRefused(outcome, "bazaar_settlement_below_minimum", "catalog a payment of 1 base unit");
      } else {
        ok(
          ["awaiting_origin_verification", "recorded"].includes(outcomeCode(outcome)),
          JSON.stringify(outcome),
        );
        strictEqual(outcome?.listingId, weatherId);
      }
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      const found = await listing(weatherId);
      strictEqual(found.state, "published");
      ok(
        found.accepts.every((option) => option.amount !== "1"),
        `the forged price is not listed: ${JSON.stringify(found.accepts)}`,
      );
      ok(
        found.accepts.some((option) => option.amount === asked.amount && option.asset === asked.asset),
        "the seller's own price is listed",
      );
      current?.observe("accepts", found.accepts);
    },
  );

  const assetSpec = spec(
    "forged-asset",
    "a payment in an asset the seller's 402 does not ask for never lists that asset",
    ["discovery", "second-asset"],
  );
  const test6Payer = options.test6Payer;
  if (test6Payer === undefined) {
    recorder.skip(assetSpec, "a pubnet run pays in USDC only, its one allowed asset", "not-applicable");
  } else {
    await check(assetSpec, async () => {
      ok(weatherId !== "", "needs the http-listed listing");
      const asked = weather.accepts[0];
      if (asked === undefined) throw new Error("the 402 offers no payment option");
      const forged: PaymentRequirements = { ...asked, asset: TEST6.contract, amount: "1000" };
      const { outcome } = await claim(await test6Payer(), weather, weather.resource.url, {
        requirements: forged,
        decimals: TEST6.decimals,
      });
      ok(
        ["awaiting_origin_verification", "recorded", "bazaar_settlement_below_minimum"].includes(
          outcomeCode(outcome),
        ),
        JSON.stringify(outcome),
      );
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      const found = await listing(weatherId);
      strictEqual(found.state, "published");
      ok(
        found.accepts.every((option) => option.asset !== TEST6.contract),
        `TEST6 is not listed: ${JSON.stringify(found.accepts)}`,
      );
      current?.observe("accepts", found.accepts);
    });
  }
}

/** The resources discovery lists for a payTo. */
async function listedResources(payTo: string): Promise<string[]> {
  const response = await fetch(`${FACILITATOR}/discovery/resources?payTo=${payTo}&limit=100`);
  strictEqual(response.status, 200);
  return ((await response.json()) as { items: { resource: string }[] }).items.map((item) => item.resource);
}

// --- the second seller: another asset and upto ----------------------------------------------------

const SECOND_SELLER_SPECS = {
  secondAsset: spec(
    "second-asset",
    "a resource priced in a 6-decimal SEP-41 token is listed with the token's on-chain facts and found by its asset and price",
    ["discovery", "second-asset"],
  ),
  upto: spec(
    "upto-listing",
    "an upto resource is listed under the upto scheme, priced at its cap, whatever the settlement charged",
    ["discovery", "scheme-upto"],
  ),
  zero: spec(
    "upto-offchain-zero",
    "an upto payment settled for zero without a transaction catalogs nothing",
    ["discovery", "scheme-upto"],
  ),
  usd: spec(
    "usd-filter",
    "a price ceiling in US dollars matches USD-pegged assets only, never the TEST6 test token",
    ["discovery", "second-asset"],
  ),
};

function skipSecondSeller(reason: string, category: SkipCategory) {
  for (const entry of Object.values(SECOND_SELLER_SPECS)) recorder.skip(entry, reason, category);
}

async function secondSellerCases(url: string, payTo: string, treasury: Treasury, loopback: boolean) {
  const test6Url = `${url}${TEST6_PATH}`;
  const uptoUrl = `${url}${UPTO_PATH}`;
  const specs = SECOND_SELLER_SPECS;

  // The facilitator catalogs this seller's resources only when it accepts loopback origins.
  if (!loopback) {
    skipSecondSeller(
      "the facilitator does not catalog resources on 127.0.0.1 (DISCOVERY_ALLOW_LOOPBACK is off), where the run's second seller listens",
      "environment",
    );
    return;
  }

  let test6Listing: Listing | undefined;
  await check(specs.secondAsset, async () => {
    // TEST6 needs no trustline: the payer holds it in the token contract's own storage.
    const [payer] = await treasury.accounts(1, "0", false);
    if (payer === undefined) throw new Error("no payer");
    await test6Faucet(net, treasury.keypair, payer.publicKey());
    const { payload, requirements } = await payFor(payer, await paymentRequired(`${test6Url}?harbour=Izmir`));
    strictEqual(requirements.asset, TEST6.contract, "the 402 asks for TEST6");
    strictEqual(requirements.amount, "10000", "0.01 TEST6 is 10000 base units at 6 decimals");
    const { outcome } = await settle(payload, requirements, TEST6.decimals);
    expectCataloged(outcome);
    const found = await withFacts(outcome?.listingId ?? "");
    strictEqual(only(found).owner, payTo, "bound to the settled payTo");
    strictEqual(found.accepts[0]?.asset, TEST6.contract);
    strictEqual(found.accepts[0].amount, "10000");
    const [option] = found.rail402.options;
    strictEqual(option?.symbol, "TEST6", "the symbol read from the token contract");
    strictEqual(option.decimals, 6, "the decimals read from the token contract");
    strictEqual(option.receivable, undefined, "no receivability claim for a custom token and a G… payTo");
    await record(found);
    test6Listing = found;

    // A ceiling in the asset's own units: 0.01 TEST6 fits, 0.009 does not.
    const query = { query: TIDES_QUERY, payTo };
    const within = await searchUntilFound({ ...query, asset: "TEST6", maxPrice: "0.01" }, found.resource);
    ok(
      within.every((item) => item.accepts.some((accepted) => accepted.asset === TEST6.contract)),
      "every match is priced in TEST6",
    );
    const below = await search({ ...query, asset: "TEST6", maxPrice: "0.009" });
    ok(!below.some((item) => item.resource === found.resource), "a ceiling below the price excludes it");
    current?.observe("search", {
      "asset=TEST6&maxPrice=0.01": within.map((item) => item.resource),
      "asset=TEST6&maxPrice=0.009": below.map((item) => item.resource),
    });
  });

  let uptoListing: Listing | undefined;
  await check(specs.upto, async () => {
    const [payer] = await treasury.accounts(1, "0.1");
    if (payer === undefined) throw new Error("no payer");
    const { payload, requirements } = await payUpto(payer, await paymentRequired(`${uptoUrl}?harbour=Izmir`));
    const cap = BigInt(requirements.amount);
    ok(UPTO_CHARGE < cap, "the charge is part of the cap");
    const result = await settle(payload, { ...requirements, amount: UPTO_CHARGE.toString() });
    strictEqual(result.amount, UPTO_CHARGE.toString(), "the settlement charged part of the cap");
    ok(result.outcome?.listingId !== undefined, JSON.stringify(result.outcome));
    const found = await settled(result.outcome.listingId, "published");
    strictEqual(found.resource, uptoUrl);
    strictEqual(found.accepts[0]?.scheme, "upto", "listed under the upto scheme");
    strictEqual(found.accepts[0].amount, cap.toString(), "priced at the cap, not the amount charged");
    strictEqual(found.accepts[0].asset, USDC_ADDRESS);
    strictEqual(only(found).owner, payTo);
    await record(found);
    uptoListing = found;
  });

  await check(specs.zero, async () => {
    const [payer] = await treasury.accounts(1, "0.1");
    if (payer === undefined) throw new Error("no payer");
    const { payload, requirements } = await payUpto(payer, await paymentRequired(`${uptoUrl}?harbour=Izmir`));
    const before = uptoListing === undefined ? undefined : only(await listing(only(uptoListing).id));
    const result = await settle(payload, { ...requirements, amount: "0" });
    strictEqual(result.amount, "0");
    current?.observe("zeroSettlement", result.transaction === "" ? "offchain" : "onchain");
    // A zero moved nothing, so it proves nothing about the payTo, on chain or off: the resource is not
    // cataloged either way.
    strictEqual(
      outcomeCode(result.outcome),
      result.transaction === "" ? "bazaar_settlement_offchain" : "bazaar_settlement_zero",
    );
    ok((result.outcome?.rejectedReason ?? "").trim() !== "", "the outcome carries a reason");
    if (before !== undefined && uptoListing !== undefined) {
      const after = only(await listing(only(uptoListing).id));
      strictEqual(after.settlements, before.settlements, "the listing counts no settlement");
      strictEqual(after.version, before.version, "no new version");
    }
  });

  await check(specs.usd, async () => {
    if (test6Listing === undefined || uptoListing === undefined) {
      throw new Error("needs the second-asset and upto-listing listings");
    }
    const test6Resource = test6Listing.resource;
    const uptoResource = uptoListing.resource;
    const query = { query: TIDES_QUERY, payTo };
    // Both cost 0.01 of their asset; only the USDC listing has a price in US dollars.
    const usd = await searchUntilFound({ ...query, maxPrice: "1" }, uptoResource);
    ok(!usd.some((item) => item.resource === test6Resource), "TEST6 has no US dollar price");
    const any = await searchUntilFound(query, test6Resource);
    ok(
      any.some((item) => item.resource === uptoResource),
      "without a ceiling both are found",
    );
    current?.observe("search", {
      "maxPrice=1 (USD)": usd.map((item) => item.resource),
      "no ceiling": any.map((item) => item.resource),
    });
  });
}

main().catch((error: unknown) => {
  log(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
