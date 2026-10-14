/**
 * Live Bazaar run: every cataloging and integrity rule exercised against a Rail402 on the public
 * Stellar testnet. Each case settles a real payment over HTTP, built from a seller's own 402 response
 * exactly as a stock client builds it, and records the facilitator's EXTENSION-RESPONSES outcome and
 * the listing it produced. No API key is sent.
 *
 *   node --conditions=@rail402/source tools/conformance/src/live-bazaar.ts \
 *     --facilitator https://… [--seller https://…|local] [--only id,id] [--write [--allow-branch <branch>]]
 *
 * Sellers:
 * - `--seller <url>`: a deployed demo seller (apps/demo-seller) whose payTo holds a USDC trustline and
 *   sets the seller's host as its home_domain, and whose stellar.toml lists it. Listings persist
 *   between runs: a resource that is already listed
 *   reports `recorded` instead of `awaiting_origin_verification`, and the checks accept either.
 * - `--seller local` (the default): the same demo seller, started by the run on 127.0.0.1 with a
 *   fresh payTo that holds a USDC trustline and names 127.0.0.1 as its home_domain.
 * - A second seller always runs locally for the second-asset and upto cases: a route priced in the
 *   TEST6 test token (6 decimals) and an upto route priced at its cap in USDC, declared with the
 *   Rail402 seller helpers on the stock express middleware.
 * Resources on 127.0.0.1 are cataloged only by a facilitator started with
 * `DISCOVERY_ALLOW_LOOPBACK=true` (a local conformance run); against any other facilitator the second
 * seller's cases are skipped with that reason.
 *
 * Fresh buyer accounts are created for each run. The second seller that claims the demo seller's MCP
 * tool is one fixed testnet account derived from the operator's sponsor seed (the file
 * RAIL402_SPONSOR_SECRET_FILE names), so reruns reuse its one listing instead of adding another to the
 * catalog each time; without that file it is a fresh account. With --write the run is recorded as
 * schemaVersion 2 evidence.
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
  NETWORK,
  TESTNET_FRIENDBOT_URL,
  TESTNET_RPC_URL,
  Treasury,
  USDC_TESTNET_ADDRESS,
  gitCommit,
  log,
  operatorAccount,
  versions,
} from "./testnet.ts";
import {
  harnessProvenance,
  recheckProvenance,
  runFileName,
  writeEvidence,
  type CheckId,
} from "./evidence.ts";
import {
  CaseRecorder,
  buildEvidence,
  readTarget,
  settledTransaction,
  type CaseContext,
  type CaseSpec,
} from "./harness.ts";
import { checkTest6OnChain, test6Asset, test6Faucet } from "./test-token.ts";

const { values: args } = parseArgs({
  options: {
    facilitator: { type: "string", default: "http://localhost:8080" },
    seller: { type: "string", default: "local" },
    only: { type: "string" },
    write: { type: "boolean", default: false },
    "allow-branch": { type: "string" },
  },
});

// Evidence is recorded only from a clean commit on main, checked before any testnet funds are spent.
const provenance = args.write ? harnessProvenance({ allowBranch: args["allow-branch"] }) : undefined;

const FACILITATOR = args.facilitator.replace(/\/+$/, "");
const net = new LocalNetwork(TESTNET_RPC_URL, TESTNET_FRIENDBOT_URL);
/** How long to wait for the facilitator's background origin check. */
const ORIGIN_CHECK_WAIT_MS = 90_000;
/** How long to wait for a published listing to reach the search index. */
const SEARCH_INDEX_WAIT_MS = 120_000;
/**
 * The second seller: derived from the operator's sponsor seed (`operatorAccount`), so reruns reuse its
 * listing and nobody else can sign for it; a fresh account without the seed file.
 */
const SECOND_SELLER_ACCOUNT = operatorAccount("live-bazaar second seller");
const SECOND_SELLER = SECOND_SELLER_ACCOUNT.keypair;
const TEST6 = test6Asset();
/** The TEST6 route's price in whole tokens: 10000 base units at 6 decimals. */
const TEST6_PRICE = "0.01";
/** The upto route's cap; the seller charges `UPTO_CHARGE` base units of it after serving. */
const UPTO_CAP = "$0.01";
const UPTO_CHARGE = 40_000n;
/** What both of the second seller's routes are about, for search. */
const TIDES_QUERY = "tide tables for a harbour";

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
  const signed = await net.payment(payer, requirements as unknown as PaymentRequirementsLike);
  return { payload: payloadOf(required, requirements, signed.payload), requirements };
}

/** A signed upto payment for a 402's upto option, by `@rail402.dev/upto`'s client. */
async function payUpto(payer: Keypair, required: PaymentRequired) {
  const requirements = required.accepts.find((option) => option.scheme === "upto");
  if (requirements === undefined) throw new Error("the 402 offers no upto option");
  const client = new UptoStellarClient(createEd25519Signer(payer.secret(), NETWORK), {
    rpcConfig: { url: TESTNET_RPC_URL },
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
  log(`facilitator ${FACILITATOR} (version ${target.healthVersion})`);
  await checkTest6OnChain(net.server);

  log("opening a treasury: Friendbot XLM, then 5 USDC from the testnet XLM/USDC pool");
  const treasury = await new Treasury(net).open("5");
  const buyers = await treasury.accounts(8, "0.2");
  const attacker = await treasury.adopt(SECOND_SELLER);
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
  log(`demo seller ${demo.url}, second seller ${second.url}`);

  try {
    await demoSellerCases(demo.url, buyer, attacker);
    await secondSellerCases(second.url, secondPayTo.publicKey(), treasury);
  } finally {
    await second.close();
    await demo.close();
  }

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
        `--facilitator ${FACILITATOR} --seller ${args.seller}`,
      config: {
        seller: args.seller === "local" ? "demo seller started by the run on 127.0.0.1" : demo.url,
        secondSeller: "started by the run on 127.0.0.1",
        "test6.price": `${TEST6_PRICE} TEST6 (${String(TEST6.decimals)} decimals) at GET ${TEST6_PATH}`,
        "upto.cap": `${UPTO_CAP.slice(1)} USDC at GET ${UPTO_PATH}`,
        "upto.charge": `${UPTO_CHARGE.toString()} base units`,
        apiKey: "none",
        mcpClaimantAccount: SECOND_SELLER_ACCOUNT.origin,
      },
      accounts: {
        treasury: treasury.keypair.publicKey(),
        ...(args.seller === "local" ? { sellerPayTo: demoPayTo.publicKey() } : {}),
        secondSellerPayTo: secondPayTo.publicKey(),
        mcpClaimant: SECOND_SELLER.publicKey(),
        test6: TEST6.contract,
      },
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
  if (recorder.failed > 0) process.exitCode = 1;
}

// --- the demo seller ------------------------------------------------------------------------------

async function demoSellerCases(seller: string, buyer: (i: number) => Keypair, attacker: Keypair) {
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
      strictEqual((await get(`payTo=${sellerPayTo}&network=stellar:pubnet&limit=100`)).pagination.total, 0);
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
}

// --- the second seller: another asset and upto ----------------------------------------------------

async function secondSellerCases(url: string, payTo: string, treasury: Treasury) {
  const test6Url = `${url}${TEST6_PATH}`;
  const uptoUrl = `${url}${UPTO_PATH}`;
  const specs = {
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

  // The facilitator catalogs this seller's resources only when it accepts loopback origins.
  const loopback = await (async () => {
    const [probe] = await treasury.accounts(1, "0.1");
    if (probe === undefined) throw new Error("no probe account");
    const { payload, requirements } = await payUpto(probe, await paymentRequired(`${uptoUrl}?harbour=Izmir`));
    const result = await settle(payload, { ...requirements, amount: "1" });
    return outcomeCode(result.outcome) !== "bazaar_resource_unsafe";
  })();
  if (!loopback) {
    const reason =
      "the facilitator does not catalog resources on 127.0.0.1 (DISCOVERY_ALLOW_LOOPBACK is off), where the run's second seller listens";
    for (const entry of Object.values(specs)) recorder.skip(entry, reason);
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
    const found = await settled(outcome?.listingId ?? "", "published");
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
    strictEqual(found.accepts[0].asset, USDC_TESTNET_ADDRESS);
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
