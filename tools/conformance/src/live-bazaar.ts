/**
 * Live Bazaar run: every cataloging and integrity rule exercised against a deployed Rail402 on the
 * public Stellar testnet, through a public seller (apps/demo-seller). Each case settles a real payment
 * over HTTP, built from the seller's own 402 response exactly as a stock client builds it, and records
 * the facilitator's EXTENSION-RESPONSES outcome and the listing it produced. No API key is sent.
 *
 *   node tools/conformance/src/live-bazaar.ts \
 *     --facilitator https://… --seller https://… [--write]
 *
 * Listings persist between runs: a resource that is already listed reports `recorded` instead of
 * `awaiting_origin_verification`, and the checks accept either. Fresh buyer accounts are created for
 * each run, so the script needs no secrets. The second seller that claims the seller's MCP tool is one
 * fixed testnet account derived from a public label, so reruns reuse its one listing instead of adding
 * another to the catalog each time.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ok, strictEqual } from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { LocalNetwork, type PaymentRequirementsLike } from "@rail402.dev/testkit";
import {
  NETWORK,
  TESTNET_FRIENDBOT_URL,
  TESTNET_RPC_URL,
  Treasury,
  gitCommit,
  log,
  versions,
} from "./testnet.ts";

const { values: args } = parseArgs({
  options: {
    facilitator: { type: "string", default: "http://localhost:8080" },
    seller: { type: "string", default: "http://localhost:4021" },
    write: { type: "boolean", default: false },
  },
});

const FACILITATOR = args.facilitator.replace(/\/+$/, "");
const SELLER = args.seller.replace(/\/+$/, "");
const net = new LocalNetwork(TESTNET_RPC_URL, TESTNET_FRIENDBOT_URL);
/** How long to wait for the facilitator's background origin check. */
const ORIGIN_CHECK_WAIT_MS = 90_000;
/** A testnet-only account anyone can derive: it only ever receives test payments. */
const SECOND_SELLER = Keypair.fromRawEd25519Seed(
  createHash("sha256").update("rail402 live-bazaar: second seller").digest(),
);

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
  stellar?: { checkedAt: string; domain?: { host: string; claimsOwner: boolean } };
}

/** A discovery item; from the detail route, one listing with its state. */
interface Listing {
  resource: string;
  type: string;
  accepts: { payTo: string; amount: string; network: string }[];
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

interface CaseResult {
  id: string;
  rule: string;
  passed: boolean;
  elapsedMs: number;
  settlements: { transaction: string; outcome?: Outcome; headerBytes: number }[];
  listing?: { id: string; state: string; trust: string; resource: string; version: number };
  versions?: { version: number; cause: string; state: string }[];
  error?: string;
}

const results: CaseResult[] = [];
let current: CaseResult | undefined;

async function check(id: string, rule: string, run: () => Promise<void>): Promise<void> {
  const result: CaseResult = { id, rule, passed: false, elapsedMs: 0, settlements: [] };
  current = result;
  const started = performance.now();
  try {
    await run();
    result.passed = true;
    log(`PASS ${id}`);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    log(`FAIL ${id}: ${result.error}`);
  }
  result.elapsedMs = Math.round(performance.now() - started);
  results.push(result);
  current = undefined;
}

// ---------------------------------------------------------------------------------------------

/** The seller's unpaid 402 for a request. */
async function paymentRequired(path: string, init?: RequestInit): Promise<PaymentRequired> {
  const response = await fetch(`${SELLER}${path}`, init);
  strictEqual(response.status, 402, `${path} answers 402`);
  return decodePaymentRequiredHeader(response.headers.get("payment-required") ?? "");
}

type Payload = Record<string, unknown> & { payload: { transaction: string } };

/** A signed payment for the seller's 402, as a stock client builds it, echoing resource and extensions. */
async function payFor(payer: Keypair, required: PaymentRequired, requirements = required.accepts[0]) {
  if (requirements === undefined) throw new Error("the 402 offers no payment option");
  const signed = await net.payment(payer, requirements as unknown as PaymentRequirementsLike);
  const payload: Payload = {
    x402Version: 2,
    resource: required.resource,
    accepted: requirements,
    payload: signed.payload,
    ...(required.extensions === undefined ? {} : { extensions: required.extensions }),
  };
  return { payload, requirements };
}

/** Settles through the facilitator and returns its result with the decoded Bazaar outcome. */
async function settle(payload: Payload, requirements: PaymentRequirements) {
  const response = await fetch(`${FACILITATOR}/settle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: requirements }),
  });
  const body = (await response.json()) as { success: boolean; transaction: string; errorReason?: string };
  ok(body.success, `settlement succeeds: ${JSON.stringify(body)}`);
  const header = response.headers.get("extension-responses") ?? "";
  ok(Buffer.byteLength(header) <= 4_096, `EXTENSION-RESPONSES is ${String(header.length)} bytes`);
  const outcome =
    header === ""
      ? undefined
      : (JSON.parse(Buffer.from(header, "base64").toString()) as { bazaar?: Outcome }).bazaar;
  current?.settlements.push({
    transaction: body.transaction,
    ...(outcome === undefined ? {} : { outcome }),
    headerBytes: header.length,
  });
  return { transaction: body.transaction, outcome };
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
  if (current !== undefined) {
    current.listing = {
      id: only(found).id,
      state: found.state,
      trust: only(found).trust,
      resource: found.resource,
      version: only(found).version,
    };
    current.versions = history.versions.map(({ version, cause, state }) => ({ version, cause, state }));
  }
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

// ---------------------------------------------------------------------------------------------

async function main() {
  const health = (await (await fetch(`${FACILITATOR}/health`)).json()) as { version?: string };
  log(`facilitator ${FACILITATOR} (version ${health.version ?? "unknown"}), seller ${SELLER}`);
  const weather = await paymentRequired("/weather?city=Ankara");
  const sellerPayTo = weather.accepts[0]?.payTo ?? "";

  log("opening a treasury: Friendbot XLM, then 5 USDC from the testnet XLM/USDC pool");
  const treasury = await new Treasury(net).open("5");
  const buyers = await treasury.accounts(8, "0.2");
  const attacker = await treasury.adopt(SECOND_SELLER);
  const buyer = (i: number) => buyers[i % buyers.length] as Keypair;

  let weatherId = "";
  await check(
    "http-listed",
    "an HTTP resource is cataloged after settlement and listed once its own 402 confirms it",
    async () => {
      const { payload, requirements } = await payFor(buyer(0), weather);
      const { outcome } = await settle(payload, requirements);
      expectCataloged(outcome);
      weatherId = outcome?.listingId ?? "";
      const found = await settled(weatherId, "published");
      ok(["origin_verified", "domain_verified"].includes(only(found).trust), only(found).trust);
      strictEqual(only(found).owner, sellerPayTo, "bound to the settled payTo");
      strictEqual(found.resource, `${SELLER}/weather`);
      const history = await record(found);
      strictEqual(history[0]?.cause, "settlement");
      ok(history.some((version) => version.cause === "origin_verification" && version.state === "published"));
    },
  );

  await check(
    "duplicate-settlement",
    "a repeated settlement is recorded once and creates no listing",
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

  await check("settlement-reused", "one settlement catalogs at most one resource", async () => {
    const { payload, requirements } = await payFor(buyer(2), weather);
    await settle(payload, requirements);
    const users = await paymentRequired("/users/7");
    const replay = { ...payload, resource: users.resource, extensions: users.extensions };
    const { outcome } = await settle(replay, requirements);
    strictEqual(outcomeCode(outcome), "bazaar_settlement_reused");
    ok((outcome?.rejectedReason ?? "").trim() !== "");
  });

  await check(
    "route-template",
    "a route with parameters is one listing under its route template",
    async () => {
      const first = await payFor(buyer(3), await paymentRequired("/users/42"));
      const created = await settle(first.payload, first.requirements);
      expectCataloged(created.outcome);
      const id = created.outcome?.listingId ?? "";
      const found = await settled(id, "published");
      strictEqual(found.resource, `${SELLER}/users/:id`);
      strictEqual(found.extensions.bazaar["routeTemplate"], "/users/:id");
      const second = await payFor(buyer(4), await paymentRequired("/users/7"));
      const again = await settle(second.payload, second.requirements);
      strictEqual(again.outcome?.listingId, id, "another path of the route joins the same listing");
      await record(await listing(id));
    },
  );

  await check("post-body", "a POST resource with a JSON body is listed with its method", async () => {
    const init = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };
    const { payload, requirements } = await payFor(buyer(5), await paymentRequired("/translate", init));
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

  await check("owner-conflict", "a different payTo cannot take over or modify a listing", async () => {
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
    "forged-metadata",
    "metadata echoed by a buyer never changes a listing on its own",
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

  await check("soft-drop", "invalid optional metadata is dropped without failing the payment", async () => {
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
  });

  await check(
    "schema-rejected",
    "metadata is validated against its schema; a rejection never fails the payment",
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
    "header-bounded",
    "an outcome quoting a huge buyer input stays within any HTTP client's header limit",
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

  await check("not-x402", "a URL that is not an x402 resource is never listed", async () => {
    const health = { ...weather, resource: { ...weather.resource, url: `${SELLER}/health` } };
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
    ok(!listed.items.some((item) => item.resource === `${SELLER}/health`), "not in discovery");
  });

  await check(
    "mcp-tool",
    "MCP tools are keyed by resource URL and tool name, scoped to their owner",
    async () => {
      const tool = declareDiscoveryExtension({
        toolName: "forecast",
        description: "Weather forecast for a city",
        inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      });
      const mcp = {
        ...weather,
        resource: { url: `${SELLER}/mcp`, description: "Forecast tool" },
        extensions: tool,
      };
      const first = await payFor(buyer(4), mcp);
      const own = await settle(first.payload, first.requirements);
      ok(["cataloged", "recorded"].includes(outcomeCode(own.outcome)), JSON.stringify(own.outcome));
      const found = await listing(own.outcome?.listingId ?? "");
      strictEqual(found.type, "mcp");
      strictEqual(found.state, "published");
      await record(found);
      // Another seller declaring the same tool gets its own listing and cannot touch the first.
      const claim = { ...weather.accepts[0], payTo: attacker.publicKey() } as PaymentRequirements;
      const second = {
        ...mcp,
        resource: {
          ...mcp.resource,
          description: "Conformance run: a second seller declaring the same tool",
        },
      };
      const other = await payFor(buyer(5), second, claim);
      const theirs = await settle(other.payload, other.requirements);
      ok(theirs.outcome?.listingId !== own.outcome?.listingId, "a separate listing");
      strictEqual(only(await listing(own.outcome?.listingId ?? "")).owner, sellerPayTo);
    },
  );

  await check(
    "stellar-facts",
    "a listing carries its token's on-chain facts, whether payTo can receive it, and its domain's SEP-1 claim",
    async () => {
      const deadline = Date.now() + ORIGIN_CHECK_WAIT_MS;
      let found = await listing(weatherId);
      while (only(found).trust !== "domain_verified" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        found = await listing(weatherId);
      }
      strictEqual(only(found).trust, "domain_verified", "the seller's stellar.toml lists its payTo");
      const stellar = only(found).stellar;
      ok(stellar !== undefined, "facts were read");
      strictEqual(stellar.domain?.claimsOwner, true);
      strictEqual(stellar.domain.host, new URL(SELLER).host);
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
    "discovery",
    "GET /discovery/resources filters by type, payTo, network and extensions and pages stably",
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
        identified.items.some((item) => item.resource === `${SELLER}/translate`),
        "the POST route declares payment-identifier",
      );
      ok(
        identified.items.every((item) => item.extensions["payment-identifier"] !== undefined),
        "every match declares it",
      );
      ok(!identified.items.some((item) => item.resource === `${SELLER}/weather`), "GET /weather does not");
    },
  );

  // ---------------------------------------------------------------------------------------------
  const passed = results.filter((result) => result.passed).length;
  const catalog = (await (
    await fetch(`${FACILITATOR}/discovery/resources?payTo=${sellerPayTo}&limit=100`)
  ).json()) as {
    items: Listing[];
  };
  const evidence = {
    run: "live-bazaar",
    date: new Date().toISOString(),
    network: NETWORK,
    facilitator: FACILITATOR,
    facilitatorVersion: health.version ?? "unknown",
    seller: SELLER,
    sellerPayTo,
    apiKey: "none",
    harnessCommit: gitCommit(),
    packages: versions(["@x402/core", "@x402/extensions", "@x402/stellar", "@stellar/stellar-sdk"]),
    command: `node tools/conformance/src/live-bazaar.ts --facilitator ${FACILITATOR} --seller ${SELLER}`,
    summary: {
      cases: results.length,
      passed,
      failed: results.length - passed,
      settlements: results.flatMap((result) => result.settlements).length,
    },
    cases: results,
    catalog: catalog.items.map((item) => ({
      resource: item.resource,
      type: item.type,
      extensions: Object.keys(item.extensions),
      listings: item.rail402.listings.map(({ id, network, trust, version, settlements }) => ({
        id,
        network,
        trust,
        version,
        settlements,
      })),
    })),
  };
  const output = `${JSON.stringify(evidence, null, 2)}\n`;
  process.stdout.write(output);
  if (args.write) {
    const directory = new URL("../evidence/", import.meta.url);
    mkdirSync(directory, { recursive: true });
    writeFileSync(new URL("live-bazaar-stellar-testnet.json", directory), output);
    log("evidence written to tools/conformance/evidence/live-bazaar-stellar-testnet.json");
  }
  if (passed !== results.length) process.exit(1);
}

main().catch((error: unknown) => {
  log(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
