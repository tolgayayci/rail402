/**
 * The end-to-end setting for `withSettleDedupe`: Rail402's HTTP service (with its repeat marker in EXTENSION-RESPONSES
 * and its address rate limit) in front of a settlement engine and ledger, an edge in front of the
 * service (a reverse proxy or CDN, which can fail on its own), the stock HTTP facilitator client, and a
 * stock express seller with an `upfront` route, the flow the wrapper exists for. Only the network is
 * left out: the first settle records and finishes the payment's settlement at once.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { expect } from "vitest";
import express from "express";
import { serve, type ServerType } from "@hono/node-server";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { paymentMiddleware } from "@x402/express";
import { ExactStellarScheme as ExactStellarServer } from "@x402/stellar/exact/server";
import {
  MemoryChannelPool,
  MemorySettlementLedger,
  SettlementEngine,
  attemptOf,
  fingerprintOf,
  settleFailed,
  settleSucceeded,
  silentLogger,
  type NetworkPolicy,
  type SettlementLedger,
  type StellarFacilitator,
} from "@rail402.dev/facilitator";
import {
  LocalCallerRateLimiter,
  Metrics,
  MemoryUsageMeter,
  createApp,
  loadConfig,
} from "@rail402.dev/service";
import { TESTNET, USDC } from "@rail402.dev/stellar";
import { exact, httpRoute } from "@rail402.dev/sdk/seller";

const HASH = "ab".repeat(32);
const PAYER = Keypair.random().publicKey();
/** The seller's account: the same before and after a restart. */
const PAY_TO = Keypair.random().publicKey();

const stops: (() => Promise<unknown>)[] = [];

/** Closes everything the tests started; run it after each test. */
export async function closeAll(): Promise<void> {
  for (const stop of stops.splice(0)) await stop();
}

/**
 * How the edge answers a `/settle` instead of passing the service's answer on: a reset connection, an
 * empty 502 (a proxy while the service restarts), an HTML 429 block page, the service's answer lost on
 * its way back after the service settled, or the connection cut while the service is still at work.
 */
export type EdgeFailure = "reset" | "edge502" | "edgeHtml429" | "lose" | "cut";

/**
 * Rail402's service settling one payment, behind an edge: the first settle records its transfer, with
 * the request's settle attempt id, and finishes it; every later one is answered from the record, marked
 * as a repeat that echoes that id. `recordedMsAgo` dates the ledger's clock back, so the payment reads
 * as settled that long ago; `perMinute` is the service's address rate limit.
 *
 * `claimTtlMs` is how long a claim lasts before another request may take it over, and `stallNext()`
 * makes the next settlement stop after its claim, as a process that died there would. A request that
 * finds another's live claim waits for it as the engine does. `ledger` replaces the in-memory ledger.
 */
export async function startService(
  options: {
    readonly recordedMsAgo?: number;
    readonly perMinute?: number;
    readonly claimTtlMs?: number;
    readonly ledger?: SettlementLedger;
  } = {},
) {
  const channel = Keypair.random();
  const ledger =
    options.ledger ?? new MemorySettlementLedger(() => Date.now() - (options.recordedMsAgo ?? 0));
  const engine = new SettlementEngine({
    network: TESTNET,
    passphrase: Networks.TESTNET,
    rpcUrl: "http://127.0.0.1:1/rpc",
    server: {} as never,
    policy: {} as NetworkPolicy,
    ledger,
    channels: new MemoryChannelPool([channel.publicKey()]),
    channelKeys: new Map([[channel.publicKey(), channel]]),
    sponsor: Keypair.random(),
    timing: {
      duplicateWaitMs: 3_000,
      pollIntervalMs: 10,
      ...(options.claimTtlMs === undefined ? {} : { claimTtlMs: options.claimTtlMs }),
    },
  });
  const key = { network: TESTNET, payer: PAYER, nonce: "42" };
  let transfers = 0;
  let stall = false;
  const stalled: (() => void)[] = [];
  // Stalled settlements end first, so the service can close.
  stops.push(() => {
    for (const end of stalled.splice(0)) end();
    return Promise.resolve();
  });
  const core = {
    getSupported: () => ({
      kinds: [{ x402Version: 2, scheme: "exact", network: TESTNET, extra: { areFeesSponsored: true } }],
      extensions: [],
      signers: { "stellar:*": [channel.publicKey()] },
    }),
    verify: () => Promise.resolve({ isValid: true, payer: PAYER }),
    settle: async (payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> => {
      const fingerprint = fingerprintOf(payload, requirements);
      const repeat = await engine.answerRepeat("exact", key, fingerprint);
      if (repeat !== undefined) return repeat;
      // The claim as the engine makes it: a stale one is taken over by this request.
      const owner = crypto.randomUUID();
      const claim = await ledger.claim(
        key,
        fingerprint,
        owner,
        options.claimTtlMs ?? 30_000,
        attemptOf(payload),
      );
      if (claim.kind !== "claimed") {
        // Another request holds the claim: wait for it as the engine does, and answer from its record.
        return engine.execute(
          { scheme: "exact", key, fingerprint, payer: PAYER, ...attemptOf(payload) },
          {
            submit: () => Promise.reject(new Error("a waiting request never signs")),
            unsigned: (result) => Promise.resolve(result),
          },
        );
      }
      if (stall) {
        stall = false;
        // The process died after its claim: nothing more happens for this request.
        await new Promise<void>((resolve) => stalled.push(resolve));
        return settleFailed({ code: "unexpected_settle_error", network: TESTNET, payer: PAYER });
      }
      await ledger.recordEnvelope(claim.record.id, owner, {
        channel: channel.publicKey(),
        transactionHash: HASH,
        innerTransactionHash: "cd".repeat(32),
        envelopeXdr: "AAAA",
        validUntil: Math.floor(Date.now() / 1000) + 300,
        maxFeeStroops: "30000",
      });
      transfers++;
      const settled = settleSucceeded(TESTNET, HASH, PAYER);
      await ledger.finish(claim.record.id, "succeeded", settled);
      return settled;
    },
  };
  let now = Date.now();
  const config = loadConfig({
    STORE: "memory",
    TESTNET_RPC_URL: "http://127.0.0.1:1/rpc",
    TESTNET_SPONSOR_SECRET: Keypair.random().secret(),
    API_KEY_SHA256: createHash("sha256").update("unused").digest("hex"),
    RATE_LIMIT_PER_MINUTE: String(options.perMinute ?? 0),
  });
  const app = createApp({
    config,
    facilitator: {
      core,
      networks: new Map(),
      reconcile: () => Promise.resolve(0),
    } as unknown as StellarFacilitator,
    metrics: new Metrics(),
    log: silentLogger,
    readiness: () => Promise.resolve({ ready: true, checks: { database: { ok: true } } }),
    version: "test",
    meter: new MemoryUsageMeter(),
    rateLimiter: new LocalCallerRateLimiter(options.perMinute ?? 0, () => now),
  });
  // Work the service does after its core answered (cataloging, metering) holds each /settle answer up.
  let serviceDelayMs = 0;
  const service: ServerType = serve({
    fetch: async (request) => {
      const answer = await app.fetch(request);
      if (serviceDelayMs > 0 && new URL(request.url).pathname === "/settle") await sleep(serviceDelayMs);
      return answer;
    },
    port: 0,
    hostname: "127.0.0.1",
  });
  await new Promise((resolve) => service.once("listening", resolve));
  stops.push(() => new Promise((resolve) => service.close(resolve)));
  const origin = `http://127.0.0.1:${String((service.address() as AddressInfo).port)}`;

  // The edge passes every request on, unless a failure is queued for the next /settle, and can hold
  // the service's answers up.
  const failures: EdgeFailure[] = [];
  let edgeDelayMs = 0;
  const settles: number[] = [];
  const edge = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const failure = request.url === "/settle" ? failures.shift() : undefined;
      if (failure === "reset") return void request.socket.destroy();
      if (failure === "edge502") return void response.writeHead(502).end();
      if (failure === "edgeHtml429") {
        return void response
          .writeHead(429, { "content-type": "text/html" })
          .end("<html><body>Too many requests</body></html>");
      }
      if (failure === "cut") setTimeout(() => request.socket.destroy(), 150);
      void fetch(`${origin}${request.url ?? "/"}`, {
        method: request.method ?? "GET",
        headers: { "content-type": request.headers["content-type"] ?? "application/json" },
        ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
      }).then(async (answer) => {
        const body = Buffer.from(await answer.arrayBuffer());
        if (failure === "lose" || failure === "cut") return void request.socket.destroy();
        if (request.url === "/settle") {
          settles.push(answer.status);
          if (edgeDelayMs > 0) await sleep(edgeDelayMs);
        }
        const headers: Record<string, string> = {};
        for (const name of ["content-type", "extension-responses"]) {
          const value = answer.headers.get(name);
          if (value !== null) headers[name] = value;
        }
        response.writeHead(answer.status, headers).end(body);
      });
    });
  });
  edge.listen(0, "127.0.0.1");
  await new Promise((resolve) => edge.once("listening", resolve));
  stops.push(() => new Promise((resolve) => edge.close(resolve)));
  return {
    url: `http://127.0.0.1:${String((edge.address() as AddressInfo).port)}`,
    /** The next /settle fails at the edge in this way. */
    fail: (failure: EdgeFailure) => failures.push(failure),
    settles,
    transfers: () => transfers,
    /** Moves the rate limiter's clock on, so the address limit refills. */
    later: (ms: number) => {
      now += ms;
    },
    /** Resolves once a request has claimed the payment's settlement. */
    claimed: async () => {
      while ((await ledger.find(key)) === undefined) await sleep(10);
    },
    /** The next settlement stops after its claim, as if its process died there. */
    stallNext: () => {
      stall = true;
    },
    /** Holds every later /settle answer up for this long, in the service or at the edge. */
    holdAnswers: (where: "service" | "edge", ms: number) => {
      if (where === "service") serviceDelayMs = ms;
      else edgeDelayMs = ms;
    },
  };
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A stock express seller with one `upfront` route, its facilitator client wrapped as documented. */
export async function startSeller(facilitator: FacilitatorClient) {
  const route = httpRoute({
    method: "GET",
    path: "/report",
    description: "A paid report",
    payment: exact({
      network: TESTNET,
      payTo: PAY_TO,
      price: { amount: "0.01", asset: USDC[TESTNET].contract, decimals: 7 },
      paymentFlow: "upfront",
    }),
    output: { example: { report: "…" } },
  });
  const resourceServer = new x402ResourceServer(facilitator).register(TESTNET, new ExactStellarServer());
  const app = express();
  let served = 0;
  app.use(paymentMiddleware({ [route.key]: route.config }, resourceServer));
  app.get("/report", (_request, response) => {
    served++;
    response.json({ report: "paid content" });
  });
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  stops.push(() => new Promise((resolve) => server.close(resolve)));
  return { base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, served: () => served };
}

/** The buyer's one signed payment for the seller's route, sent as PAYMENT-SIGNATURE. */
export async function signedPayment(base: string): Promise<Record<string, string>> {
  const unpaid = await fetch(`${base}/report`);
  expect(unpaid.status).toBe(402);
  const required = decodePaymentRequiredHeader(unpaid.headers.get("payment-required") ?? "");
  const payload: PaymentPayload = {
    x402Version: 2,
    resource: required.resource,
    accepted: required.accepts[0] as PaymentRequirements,
    payload: { transaction: "AAAA" },
  };
  return { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) };
}

export async function send(base: string, payment: Record<string, string>) {
  const response = await fetch(`${base}/report`, { headers: payment });
  const body = await response.text();
  return { status: response.status, paid: body.includes("paid content") };
}
