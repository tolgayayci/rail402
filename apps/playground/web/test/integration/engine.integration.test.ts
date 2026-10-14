/**
 * The Playground's engine end to end on the private Stellar network (docker compose --profile stellar
 * up -d), run in Node exactly as the page wires it: over the Playground server's relay, lab sellers
 * and proxies, with Rail402 as facilitator and Bazaar and the demo seller as the paid API (stack.ts).
 *
 * One test wallet is imported and funded through onboarding (Friendbot, trustline, a purchase on the
 * exchange), then every scenario, experiment and refusal check runs against it. Each paid run is
 * checked against the chain independently: what the payer lost, what the seller received, that the
 * fee sponsor (one of the facilitator's advertised signers) paid only fees. Each refusal names its
 * code, signs nothing and moves nothing.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { KeyHolder, createBuyer, exactScheme, uptoScheme } from "@rail402.dev/sdk";
import { TESTNET } from "@rail402.dev/stellar";
import { LocalNetwork, SecretScanner, startDecoyOrigin, type DecoyOrigin } from "@rail402.dev/testkit";
import { CHECK_EXPECTED_CODES, CHECK_IDS, LAB_PRICES } from "../../../src/shared/lab.ts";
import { RELAY_HEADER_PREFIX } from "../../../src/shared/relay-protocol.ts";
import { TRACE_HEADER, decodeTrace } from "../../../src/shared/trace.ts";
import type { LabEvent, SdkPaymentEvent, TxView } from "../../src/engine/events.ts";
import type { RunHandle } from "../../src/engine/types.ts";
import { recordRun, type StackIdentities } from "../fixtures/record.ts";
import { finish as collect, startLocalStack, type LocalStack, type TestEngine } from "./stack.ts";

const net = new LocalNetwork();
const available = await net.available();

const HASH = /^[0-9a-f]{64}$/;
/** Demo seller prices in base units (7 decimals). */
const WEATHER = 10_000n;
const HISTORY_DAY = 3_000n;
const FORECAST_HOUR = 2_000n;
const SELL = BigInt(LAB_PRICES.sell.atomic);

const sdkEvents = (events: readonly LabEvent[]): SdkPaymentEvent[] =>
  events.flatMap((event) => (event.kind === "sdk" ? [event.event] : []));
const sdkTypes = (events: readonly LabEvent[]): string[] => sdkEvents(events).map((event) => event.type);
const txViews = (events: readonly LabEvent[]): TxView[] =>
  events.flatMap((event) => (event.kind === "chain" && event.phase === "tx" ? [event.view] : []));

/** Headers whose value is base64 JSON: scanned decoded (their raw base64 shares runs with public fields). */
const BASE64_JSON_HEADERS = new Set(["payment-required", "payment-response", "extension-responses"]);

function decodedHeader(name: string, value: string): unknown {
  const bare = name.startsWith(RELAY_HEADER_PREFIX) ? name.slice(RELAY_HEADER_PREFIX.length) : name;
  if (bare === TRACE_HEADER) return decodeTrace(value) ?? value;
  if (!BASE64_JSON_HEADERS.has(bare)) return value;
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as unknown;
  } catch {
    return value;
  }
}

/**
 * The signing guard's order, for every run: per call, at most one signature, after that call's
 * reservation; and the signer saw exactly as many authorizations as were signed, each after a
 * reservation. A second signing path, or a signer used outside the guard, breaks it.
 */
function guardedSignatures(events: readonly LabEvent[]): void {
  const reserved = new Set<string>();
  const signedCalls: string[] = [];
  let reservations = 0;
  let auths = 0;
  for (const event of events) {
    if (event.kind === "sdk" && event.event.type === "reserved") {
      reserved.add(event.event.callId);
      reservations++;
    }
    if (event.kind === "sdk" && event.event.type === "signed") {
      expect(reserved.has(event.event.callId), "signed after its reservation").toBe(true);
      signedCalls.push(event.event.callId);
    }
    if (event.kind === "auth") {
      auths++;
      expect(auths, "each authorization the signer saw follows a reservation").toBeLessThanOrEqual(
        reservations,
      );
    }
  }
  expect(new Set(signedCalls).size, "one signature per call").toBe(signedCalls.length);
  expect(auths, "authorizations the signer saw").toBe(signedCalls.length);
}

describe.skipIf(!available)("the Playground engine on the local network", () => {
  const canary = Keypair.random();
  const runIds: string[] = [];
  const finish = async (handle: RunHandle) => {
    runIds.push(handle.runId);
    const run = await collect(handle);
    guardedSignatures(run.events);
    return run;
  };
  let stack: LocalStack;
  let page: TestEngine;
  const payer = canary.publicKey();

  const balance = (holder: string) => net.tokenBalance(stack.usdc.sac, holder).catch(() => 0n);
  const balances = async () => {
    const [mine, demo, lab, sponsor] = await Promise.all([
      balance(payer),
      balance(stack.demoSeller.payTo),
      balance(stack.labPayTo),
      balance(stack.rail402.sponsor),
    ]);
    return { payer: mine, demo, lab, sponsor };
  };

  /** A settled transaction as the engine reported it: sponsored by an advertised signer, one transfer. */
  const settledTx = (events: readonly LabEvent[], to: string, amount: bigint): TxView => {
    const [view] = txViews(events);
    expect(view).toBeDefined();
    expect(view).toMatchObject({
      status: "SUCCESS",
      network: TESTNET,
      feeSourceAdvertised: true,
      transfers: [{ contract: stack.usdc.sac, from: payer, to, amount: amount.toString() }],
    });
    expect(view?.hash).toMatch(HASH);
    expect(view?.feeBump?.feeSource).not.toBe(payer);
    expect(view?.explorerUrl).toBe(`https://stellar.expert/explorer/testnet/tx/${view?.hash ?? ""}`);
    return view as TxView;
  };

  /** Records a run's report as a projection fixture (PLAYGROUND_RECORD_FIXTURES=1). */
  const record = (name: string, runId: string) => {
    const identities: StackIdentities = {
      publicUrl: stack.publicUrl,
      demoSellerUrl: stack.demoSeller.url,
      facilitatorUrl: stack.rail402.url,
      payer,
      demoPayTo: stack.demoSeller.payTo,
      labPayTo: stack.labPayTo,
      sponsor: stack.rail402.sponsor,
      asset: stack.usdc.sac,
      assetIssuer: stack.usdc.issuer.publicKey(),
      uptoContract: stack.upto.address,
    };
    recordRun(name, page.engine.exportRun(runId), identities);
  };

  /** Nothing was reserved or signed, and no transaction was reported. */
  const nothingSigned = (events: readonly LabEvent[]) => {
    expect(sdkTypes(events)).not.toContain("reserved");
    expect(sdkTypes(events)).not.toContain("signed");
    expect(events.filter((event) => event.kind === "auth")).toEqual([]);
    expect(txViews(events)).toEqual([]);
  };

  beforeAll(async () => {
    stack = await startLocalStack(net);
    page = await stack.engine();
  }, 300_000);

  afterAll(async () => {
    await stack.stop();
  });

  it("serves the page a configuration for the local stack", () => {
    expect(page.engine.config).toMatchObject({
      mode: "local",
      network: TESTNET,
      asset: { contract: stack.usdc.sac, symbol: "USDC", decimals: 7 },
      uptoContract: stack.upto.address,
      lab: { enabled: true, payTo: stack.labPayTo },
    });
    expect(page.engine.state().wallet).toEqual({ status: "none", storage: "persistent" });
  });

  it("imports a testnet key and funds it: Friendbot, a trustline and a purchase, each on chain", async () => {
    const imported = await finish(page.engine.wallet.import(canary.secret()));
    expect(imported.summary.status).toBe("ok");
    expect(page.engine.state().wallet).toMatchObject({
      status: "ready",
      address: payer,
      storage: "persistent",
    });

    const funded = await finish(page.engine.wallet.fund());
    expect(funded.summary).toMatchObject({ status: "ok" });
    const steps = funded.events.flatMap((event) => (event.kind === "wallet" ? [event] : []));
    expect(steps.map((step) => step.step)).toEqual(["friendbot", "trustline", "bought"]);
    for (const step of steps) expect(step.transaction).toMatch(HASH);
    expect(await balance(payer)).toBe(10_000_000n);
    expect(page.engine.state().wallet).toMatchObject({
      setup: { account: true, trustline: true, funded: true },
    });
    record("wallet-fund", funded.summary.runId);

    // Funding again skips what is already done: nothing more is bought.
    const again = await finish(page.engine.wallet.fund());
    expect(again.summary.status).toBe("ok");
    expect(
      again.events.filter((event) => event.kind === "wallet" && event.transaction !== undefined),
    ).toEqual([]);
    expect(await balance(payer)).toBe(10_000_000n);
  });

  it("exports the key as a file for the CLI and SDK", async () => {
    const saved = await page.engine.wallet.exportFile();
    await expect.poll(() => page.downloads.length).toBe(1);
    expect(page.downloads[0]?.fileName).toBe(saved.fileName);
    expect(page.downloads[0]?.text).toContain(canary.secret());
  });

  it("pays for an API: one signature under the cap, settled by Rail402, proven on chain", async () => {
    const before = await balances();
    const run = await finish(page.engine.run({ scenario: "pay", experiment: "normal", cap: "0.01" }));
    expect(run.summary).toMatchObject({ status: "ok" });
    const types = sdkTypes(run.events);
    expect(types.filter((type) => type === "signed")).toHaveLength(1);
    expect(types.indexOf("reserved")).toBeLessThan(types.indexOf("signed"));
    expect(types).toContain("settled");
    const tx = settledTx(run.events, stack.demoSeller.payTo, WEATHER);
    const paidRequest = run.events.find(
      (event) => event.kind === "http" && event.phase === "request" && event.paid,
    );
    expect(paidRequest).toMatchObject({ via: "relay", method: "GET" });
    expect(await balances()).toEqual({
      ...before,
      payer: before.payer - WEATHER,
      demo: before.demo + WEATHER,
    });
    expect(await page.engine.inspect(tx.hash)).toMatchObject({ hash: tx.hash, feeSourceAdvertised: true });
  });

  it("refuses a cap below the price before anything is signed", async () => {
    const before = await balances();
    const run = await finish(page.engine.run({ scenario: "pay", experiment: "low-cap", cap: "0.01" }));
    expect(run.summary).toMatchObject({ status: "refused", code: "payment_per_call_cap_exceeded" });
    expect(run.summary.reason).not.toBe("");
    nothingSigned(run.events);
    expect(await balances()).toEqual(before);
  });

  it("sends the same payment twice and is charged once", async () => {
    const before = await balances();
    const run = await finish(page.engine.run({ scenario: "pay", experiment: "replay", cap: "0.01" }));
    expect(run.summary).toMatchObject({ status: "info" });
    const paid = run.events.filter(
      (event) => event.kind === "http" && event.phase === "request" && event.paid,
    );
    expect(paid).toHaveLength(2);
    const responses = run.events.flatMap((event) =>
      event.kind === "http" && event.phase === "response" ? [event] : [],
    );
    const refused = responses.at(-1);
    expect(refused?.status).toBe(402);
    expect([
      "invalid_exact_stellar_payload_nonce_already_used",
      "invalid_exact_stellar_signature_expired",
    ]).toContain(refused?.required?.error);
    expect(sdkTypes(run.events).filter((type) => type === "signed")).toHaveLength(1);
    expect(txViews(run.events)).toHaveLength(1);
    expect(await balances()).toEqual({
      ...before,
      payer: before.payer - WEATHER,
      demo: before.demo + WEATHER,
    });
  });

  it("pays per use: authorizes the cap, settles what was used, returns the rest", async () => {
    const before = await balances();
    const run = await finish(page.engine.run({ scenario: "upto", experiment: "normal", cap: "0.01" }));
    expect(run.summary).toMatchObject({ status: "ok" });
    const charged = HISTORY_DAY * 7n;
    const tx = settledTx(run.events, stack.demoSeller.payTo, charged);
    expect(tx).toMatchObject({ x402Shape: "upto", uptoSettled: { amount: charged.toString() } });
    const events = sdkEvents(run.events);
    expect(events.find((event) => event.type === "reserved")).toMatchObject({ amount: "100000" });
    expect(events.find((event) => event.type === "released")).toMatchObject({
      reason: "settled_below_cap",
      amount: (100_000n - charged).toString(),
    });
    expect(await balances()).toEqual({
      ...before,
      payer: before.payer - charged,
      demo: before.demo + charged,
    });
  });

  it("blocks a seller that charges over the cap: nothing moves, the hold returns after expiry", async () => {
    const before = await balances();
    const run = await finish(page.engine.run({ scenario: "upto", experiment: "overcharge", cap: "0.01" }));
    expect(run.summary).toMatchObject({
      status: "refused",
      code: "invalid_upto_stellar_payload_settlement_exceeds_amount",
    });
    const trace = run.events.flatMap((event) =>
      event.kind === "http" && event.phase === "response" && event.trace?.settle !== undefined
        ? [event.trace.settle]
        : [],
    );
    expect(trace).toEqual([
      expect.objectContaining({
        success: false,
        code: "invalid_upto_stellar_payload_settlement_exceeds_amount",
        requested: LAB_PRICES.greedyCharge.atomic,
      }),
    ]);
    expect(txViews(run.events)).toEqual([]);
    expect(sdkTypes(run.events)).toContain("unresolved");
    expect(await balances()).toEqual(before);
    expect(page.engine.state().unfinished).toBeGreaterThan(0);

    // The authorization expires unused; reconciliation proves it and releases the hold on this run.
    const report = page.engine.exportRun(run.summary.runId);
    expect(report).toBeDefined();
    await expect
      .poll(
        async () => {
          await page.engine.reconcile();
          return sdkEvents(page.engine.exportRun(run.summary.runId)?.events ?? []).find(
            (event) => event.type === "released",
          );
        },
        { timeout: 120_000, interval: 3_000 },
      )
      .toMatchObject({ reason: "expired_unused", amount: LAB_PRICES.greedyCap.atomic });
    expect(page.engine.state().unfinished).toBe(0);
    expect(await balances()).toEqual(before);
  }, 180_000);

  it("lets an agent find a tool in the Bazaar, check its budget and pay it", async () => {
    // The demo seller's tool is cataloged by its first settlement, from any buyer.
    const holder = await net.holder(stack.usdc, "1");
    const demoPort = Number(new URL(stack.demoSeller.url).port);
    const primer = await createBuyer({
      network: TESTNET,
      signer: KeyHolder.fromSecret(holder.secret()),
      rpcUrl: net.rpcUrl,
      bazaarUrl: stack.rail402.url,
      facilitatorUrl: stack.rail402.url,
      policy: {
        assets: [{ asset: stack.usdc.sac, symbol: "USDC", decimals: 7, perCall: "0.05", sessionTotal: "1" }],
        uptoContracts: [stack.upto.address],
      },
      egress: { schemes: ["http:"], ports: [demoPort], allowPrivateNetwork: "loopback" },
      schemes: [exactScheme(), uptoScheme({ contract: stack.upto.address })],
    });
    try {
      await primer.pay(
        {
          kind: "mcp",
          url: `${stack.demoSeller.url}/mcp`,
          toolName: "hourly_forecast",
          arguments: { city: "Ankara", hours: 1 },
        },
        { maxAmount: { amount: "0.01", asset: "USDC" } },
      );
    } finally {
      await primer.close();
    }
    await expect
      .poll(
        async () => {
          await stack.nudgeCatalog();
          const found = await page.engine.search({ query: "hourly weather forecast", type: "mcp" });
          return found.items.find((item) => item.toolName === "hourly_forecast")?.trust;
        },
        { timeout: 60_000, interval: 1_000 },
      )
      .toMatch(/origin_verified|domain_verified/);

    const before = await balances();
    const run = await finish(page.engine.run({ scenario: "agent", experiment: "normal", cap: "0.01" }));
    expect(run.summary).toMatchObject({ status: "ok" });
    const calls = run.events.flatMap((event) =>
      event.kind === "tool" && event.phase === "call" ? [event.name] : [],
    );
    expect(calls).toEqual(["search_stellar_resources", "get_budget", "pay_and_call"]);
    const results = run.events.flatMap((event) =>
      event.kind === "tool" && event.phase === "result" ? [event] : [],
    );
    expect(results.map((result) => result.isError)).toEqual([false, false, false]);
    const mcp = run.events.flatMap((event) =>
      event.kind === "http" && event.phase === "request" && event.rpc !== undefined ? [event.rpc] : [],
    );
    expect(mcp.filter((call) => call.method === "tools/call").map((call) => call.hasPayment)).toEqual([
      false,
      true,
    ]);
    const charged = FORECAST_HOUR * 6n;
    settledTx(run.events, stack.demoSeller.payTo, charged);
    expect(await balances()).toEqual({
      ...before,
      payer: before.payer - charged,
      demo: before.demo + charged,
    });
  }, 180_000);

  it("sells through the sandbox route: settled, cataloged, origin-checked and found by search", async () => {
    // The hosted catalog checks origins on a timer; here the test runs those workers.
    const nudger = setInterval(() => void stack.nudgeCatalog().catch(() => undefined), 500);
    try {
      const before = await balances();
      const first = await finish(page.engine.run({ scenario: "sell", experiment: "normal", cap: "0.01" }));
      expect(first.summary).toMatchObject({ status: "ok" });
      const traced = first.events.flatMap((event) =>
        event.kind === "http" && event.phase === "response" && event.trace?.bazaar !== undefined
          ? [event.trace.bazaar]
          : [],
      );
      expect(traced).toEqual([expect.objectContaining({ code: "awaiting_origin_verification" })]);
      settledTx(first.events, stack.labPayTo, SELL);
      const listings = first.events.flatMap((event) =>
        event.kind === "bazaar" && event.phase === "listing" ? [event.listing] : [],
      );
      expect(listings.at(-1)).toMatchObject({ state: "published", owner: stack.labPayTo, type: "http" });
      const versions = first.events.flatMap((event) =>
        event.kind === "bazaar" && event.phase === "versions" ? event.versions : [],
      );
      expect(versions.length).toBeGreaterThan(0);
      const found = first.events.flatMap((event) =>
        event.kind === "bazaar" && event.phase === "search" ? event.top.map((listing) => listing.id) : [],
      );
      expect(found).toContain(listings.at(-1)?.id);
      expect(await balances()).toEqual({ ...before, payer: before.payer - SELL, lab: before.lab + SELL });

      // Every visitor shares the one listing: a second sale records a settlement on it.
      const second = await finish(page.engine.run({ scenario: "sell", experiment: "normal", cap: "0.01" }));
      expect(second.summary).toMatchObject({ status: "ok" });
      const recorded = second.events.flatMap((event) =>
        event.kind === "http" && event.phase === "response" && event.trace?.bazaar !== undefined
          ? [event.trace.bazaar]
          : [],
      );
      expect(recorded).toEqual([
        expect.objectContaining({ code: "recorded", listingId: listings.at(-1)?.id }),
      ]);
      const mine = await page.engine.list({ payTo: stack.labPayTo });
      expect(mine.items).toHaveLength(1);
    } finally {
      clearInterval(nudger);
    }
  }, 240_000);

  it("checks a seller's endpoint like the catalog would", async () => {
    const report = await page.engine.sellerCheck({ url: `${stack.demoSeller.url}/weather?city=Ankara` });
    expect(report).toMatchObject({ type: "http", status: 402, ok: true });
    expect(report.receivable).toEqual([
      expect.objectContaining({ payTo: stack.demoSeller.payTo, receivable: true }),
    ]);
  });

  describe("refusal checks", () => {
    it.each(CHECK_IDS)("%s: refused with its code, nothing signed", async (check) => {
      const before = await balances();
      const run = await finish(page.engine.check(check));
      record(`check-${check}`, run.summary.runId);
      expect(run.summary).toMatchObject({ status: "refused", code: CHECK_EXPECTED_CODES[check] });
      expect(run.summary.reason).not.toBe("");
      if (check === "session-budget") {
        // The window holds one payment; the second is refused before it is signed.
        expect(sdkTypes(run.events).filter((type) => type === "signed")).toHaveLength(1);
        // The summary names the first payment's transaction, the one the chain events show.
        const settledTxs = run.events.flatMap((event) =>
          event.kind === "chain" && event.phase === "tx" ? [event.view.hash] : [],
        );
        expect(run.summary.transactions).toEqual(settledTxs);
        expect(settledTxs).toHaveLength(1);
        expect(await balances()).toEqual({
          ...before,
          payer: before.payer - WEATHER,
          demo: before.demo + WEATHER,
        });
        return;
      }
      nothingSigned(run.events);
      expect(await balances()).toEqual(before);
    });
  });

  describe("pay any URL", () => {
    let decoy: DecoyOrigin;
    let redirector: Server;
    let redirectorUrl: string;

    beforeAll(async () => {
      decoy = await startDecoyOrigin();
      redirector = createServer((_request, response) => {
        response.writeHead(302, { location: `${decoy.url}/collect` }).end();
      });
      await new Promise<void>((resolve) => redirector.listen(0, "127.0.0.1", resolve));
      redirectorUrl = `http://127.0.0.1:${String((redirector.address() as AddressInfo).port)}`;
    });
    afterAll(async () => {
      await decoy.close();
      redirector.closeAllConnections();
      await new Promise((resolve) => redirector.close(resolve));
    });

    it("pays the demo seller by URL", async () => {
      const before = await balances();
      const run = await finish(
        page.engine.pay({ target: `${stack.demoSeller.url}/weather?city=Izmir`, cap: "0.01" }),
      );
      expect(run.summary).toMatchObject({ status: "ok" });
      settledTx(run.events, stack.demoSeller.payTo, WEATHER);
      expect(await balances()).toEqual({
        ...before,
        payer: before.payer - WEATHER,
        demo: before.demo + WEATHER,
      });
    });

    it("never follows a redirect to another origin, and signs nothing", async () => {
      const before = await balances();
      const run = await finish(page.engine.pay({ target: `${redirectorUrl}/pay`, cap: "0.01" }));
      expect(run.summary.status).not.toBe("ok");
      expect(run.summary.code).toMatch(/^egress_/);
      nothingSigned(run.events);
      expect(decoy.requests).toEqual([]);
      expect(await balances()).toEqual(before);
    });
  });

  it("paid every seller from the payer and never from the fee sponsor", async () => {
    expect(await balance(stack.rail402.sponsor)).toBe(0n);
    expect(page.engine.state().budget).toMatchObject({ awaitingProof: 0, falseClaims: 0 });
  });

  /**
   * The canary scan over everything above. Needles: the imported seed and its key bytes, and every
   * payment the engine sent (PAYMENT-SIGNATURE headers to the relay and the lab sellers, MCP
   * `_meta["x402/payment"]`), with their transactions, authorizations, preimages and signatures.
   * A payment may appear only in the one request that carried it to its seller, and signed
   * transactions only in RPC traffic (simulation and submission). Answers from the chain (RPC, and
   * Friendbot's transaction result) are public ledger data, whose XDR shares byte runs with the
   * payer's public fields, so they are not scanned; what the page sends them is. Every other channel
   * must be clean:
   * the server's trace-level logs, every API answer, every request and answer of the page's traffic,
   * the run events and reports, the engine's state, its stored budget and its stored wallet.
   */
  it("keeps the key and the payments out of every other channel", async () => {
    const scanner = new SecretScanner(canary.secret());
    /** Only the seed and its key bytes: for what the payment needles exempt (RPC calls, payments). */
    const seedOnly = new SecretScanner(canary.secret());
    const passphrase = page.engine.config.networkPassphrase;
    const rpc = new URL(page.engine.config.urls.rpc).origin;
    const friendbot = new URL(page.engine.config.urls.friendbot);
    const fromChain = (url: URL) =>
      url.origin === rpc || (url.origin === friendbot.origin && url.pathname === friendbot.pathname);
    const paymentHeaders = new Set(["payment-signature", `${RELAY_HEADER_PREFIX}payment-signature`]);
    let payments = 0;
    for (const exchange of stack.traffic) {
      for (const [name, value] of exchange.requestHeaders) {
        if (paymentHeaders.has(name)) {
          scanner.addPaymentHeader(value, passphrase);
          payments++;
        }
      }
      if (exchange.requestBody.includes("x402/payment")) {
        const message = JSON.parse(exchange.requestBody) as { params?: { _meta?: Record<string, unknown> } };
        const payment = message.params?._meta?.["x402/payment"];
        if (typeof payment === "object" && payment !== null) {
          scanner.addPayment(payment as Record<string, unknown>, passphrase);
          payments++;
        }
      }
    }
    // pay ×3 incl. the resend, upto, overcharge, agent, sell ×2, session check, pay by URL.
    expect(payments).toBeGreaterThanOrEqual(10);

    for (const [index, exchange] of stack.traffic.entries()) {
      const channel = `${exchange.method} ${new URL(exchange.url).pathname} #${String(index)}`;
      const isRpc = new URL(exchange.url).origin === rpc;
      const isChain = fromChain(new URL(exchange.url));
      const carriesPayment =
        exchange.requestHeaders.some(([name]) => paymentHeaders.has(name)) ||
        exchange.requestBody.includes("x402/payment");
      scanner.capture(
        `${channel} request headers`,
        JSON.stringify(exchange.requestHeaders.filter(([name]) => !paymentHeaders.has(name))),
      );
      if (!isRpc && !carriesPayment) scanner.capture(`${channel} request body`, exchange.requestBody);
      // Exempt from the payment needles, never from the seed.
      seedOnly.capture(`${channel} request headers`, JSON.stringify(exchange.requestHeaders));
      seedOnly.capture(`${channel} request body`, exchange.requestBody);
      scanner.capture(
        `${channel} response headers`,
        JSON.stringify(exchange.responseHeaders.map(([name, value]) => [name, decodedHeader(name, value)])),
      );
      if (!isChain) {
        const body = await Promise.race([
          exchange.responseBody,
          new Promise<string>((resolve) => {
            setTimeout(() => {
              resolve("");
            }, 5_000);
          }),
        ]);
        scanner.capture(`${channel} response body`, body);
      }
    }
    scanner.capture("server logs", JSON.stringify(stack.playground.logs));
    scanner.capture("server stderr", stack.playground.stderr);
    expect(stack.playground.logs.length).toBeGreaterThan(0);
    for (const runId of runIds) {
      const report = page.engine.exportRun(runId);
      if (report !== undefined) scanner.capture(`run report ${runId}`, JSON.stringify(report));
    }
    scanner.capture("engine state", JSON.stringify(page.engine.state()));
    scanner.capture("stored budget", JSON.stringify([...page.storage.data]));
    scanner.capture("stored wallet", page.indexedDB.written);
    scanner.assertClean();
    seedOnly.assertClean();
    // The payment-carrying requests were scanned for the seed above; a planted seed is found.
    seedOnly.capture("planted RPC body", JSON.stringify({ jsonrpc: "2.0", params: { x: canary.secret() } }));
    expect(() => {
      seedOnly.assertClean();
    }).toThrow(/planted RPC body/);

    // The scan finds a payment where one does not belong.
    const [planted] = stack.traffic.flatMap((exchange) =>
      exchange.requestHeaders.filter(([name]) => paymentHeaders.has(name)).map(([, value]) => value),
    );
    scanner.capture("planted", JSON.stringify({ echo: planted?.slice(10, 50) }));
    expect(() => {
      scanner.assertClean();
    }).toThrow(/planted/);
  });
});
