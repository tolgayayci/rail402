/**
 * The relay is a faithful transport: the SDK's HTTP payment flow gives the same result whether it
 * reaches a seller with safe-fetch directly (as the SDK does in Node) or through the Playground
 * server's relay and the page's relay transport. Each case runs the same flow against the same local
 * seller both ways and compares what the buyer sees: the call result, or the payment error's code,
 * paid state and egress stage.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceProcess } from "@rail402.dev/testkit";
import { isPaymentError, type CallResult, type FlowContext } from "@rail402.dev/sdk";
import { fileURLToPath } from "node:url";
import { createServer, type AddressInfo } from "node:net";
import { payHttp } from "../../../../../packages/sdk/src/flow/http.ts";
import {
  countingSigner,
  flowContext,
  paidRoute,
  startSeller,
  type FakeSeller,
} from "../../../../../packages/sdk/test/flow-harness.ts";
import { RELAY_LIMITS, RELAY_PATH } from "../../../src/shared/relay-protocol.ts";
import { loadConfig } from "../../src/engine/context.ts";
import { transportPolicy } from "../../src/transport/policy.ts";
import { createRelayFetch } from "../../src/transport/relay-fetch.ts";

const SERVER_ENTRY = fileURLToPath(new URL("../../../src/main.ts", import.meta.url));
/** Above the 1 MiB response cap of both paths. */
const OVERSIZE = 1_048_576 + 65_536;

type Outcome =
  | {
      readonly ok: true;
      readonly paid: boolean;
      /** What the buyer received: status, content type, body, bytes and whether it was cut. */
      readonly response: unknown;
      readonly payment: unknown;
    }
  | { readonly ok: false; readonly code: string; readonly paid: string; readonly stage: unknown };

async function outcome(call: Promise<CallResult>): Promise<Outcome> {
  try {
    const result = await call;
    return {
      ok: true,
      paid: result.paid,
      response: comparable(result.response),
      payment:
        result.payment === null
          ? null
          : {
              status: result.payment.status,
              settled: result.payment.settled?.atomic,
              transaction: result.payment.transaction,
            },
    };
  } catch (error) {
    if (!isPaymentError(error)) throw error;
    const details = error.details as { stage?: unknown } | undefined;
    return { ok: false, code: error.code, paid: error.paid, stage: details?.stage ?? null };
  }
}

/**
 * A response as compared across the two paths. A body cut at the response limit is cut on a chunk
 * boundary, which differs between a direct socket and the relay's stream: such bodies compare by
 * the limit and their start, not their exact length.
 */
function comparable(response: CallResult["response"]): unknown {
  if (response.kind !== "http" || !response.truncated) return response;
  const { bytes, text, ...rest } = response;
  return { ...rest, withinLimit: bytes <= RELAY_LIMITS.responseBodyBytes, start: text?.slice(0, 4_096) };
}

describe("the relay transport and safe-fetch give the same results", () => {
  let seller: FakeSeller;
  let playground: ServiceProcess;
  let relayed: (context: FlowContext) => FlowContext;

  beforeAll(async () => {
    seller = await startSeller({
      "/free": (_request, response) => {
        response.writeHead(200, { "content-type": "application/json" }).end('{"free":true}');
      },
      "/paid": paidRoute({}, { weather: "sunny" }),
      "/moved": (_request, response) => {
        response.writeHead(302, { location: "/paid" }).end();
      },
      "/reject": (request, response, s) => {
        if (request.payment === undefined) s.paymentRequired(response);
        else s.paymentRequired(response, {}, { error: "invalid_exact_stellar_payload_signature" });
      },
      "/redirect-after-pay": (request, response, s) => {
        if (request.payment === undefined) s.paymentRequired(response);
        else response.writeHead(302, { location: `${s.url}/elsewhere` }).end();
      },
      "/oversize": (_request, response) => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("x".repeat(OVERSIZE));
      },
      "/oversize-declared": (_request, response) => {
        response.writeHead(200, { "content-type": "text/plain", "content-length": String(OVERSIZE) });
        response.end("x".repeat(OVERSIZE));
      },
      "/silent": () => {
        // Never answers.
      },
      "/cut": (_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"partial":');
        setTimeout(() => response.socket?.destroy(), 50);
      },
      "/cut-after-pay": (request, response, s) => {
        if (request.payment === undefined) {
          s.paymentRequired(response);
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"partial":');
        setTimeout(() => response.socket?.destroy(), 50);
      },
    });

    const port = await freePort();
    const origin = `http://127.0.0.1:${String(port)}`;
    playground = await ServiceProcess.start({
      entry: SERVER_ENTRY,
      port,
      env: {
        PLAYGROUND_MODE: "local",
        PUBLIC_URL: origin,
        LAB_ENABLED: "false",
        RELAY_UNPAID_PER_MINUTE: "600",
        RELAY_UNPAID_BURST: "200",
        RELAY_PAID_PER_MINUTE: "200",
      },
    });
    await playground.waitForLog("rail402-playground listening");
    const config = await loadConfig({ origin });
    const relay = createRelayFetch({
      relayUrl: new URL(RELAY_PATH, origin).href,
      policy: transportPolicy(config),
      checkPorts: false,
    });
    relayed = (context) => ({ ...context, fetch: relay, openSession: () => relay });
  });

  afterAll(async () => {
    await playground.kill();
    await seller.close();
  });

  /** Runs the flow for `path` directly and through the relay; returns both outcomes. */
  async function both(path: string): Promise<[Outcome, Outcome]> {
    const target = { kind: "http" as const, url: `${seller.url}${path}` };
    const options = { maxAmount: { amount: "0.05" } };
    const direct = await flowContext({ ports: [seller.port], signer: countingSigner() });
    const viaRelay = relayed(await flowContext({ ports: [seller.port], signer: countingSigner() }));
    return Promise.all([
      outcome(payHttp(direct, target, options)),
      outcome(payHttp(viaRelay, target, options)),
    ]);
  }

  it.each([
    ["a free answer", "/free"],
    ["a paid answer", "/paid"],
    ["a same-origin redirect before paying", "/moved"],
    ["a refused payment", "/reject"],
    ["a redirect after paying", "/redirect-after-pay"],
    ["an oversized body, cut at the limit", "/oversize"],
    ["an oversized declared body, cut at the limit", "/oversize-declared"],
    ["a cut stream", "/cut"],
    ["a cut stream after paying", "/cut-after-pay"],
  ])("%s", async (_name, path) => {
    const [direct, viaRelay] = await both(path);
    expect(viaRelay).toEqual(direct);
  });

  it("a seller that never answers", async () => {
    const [direct, viaRelay] = await both("/silent");
    expect(direct).toMatchObject({ ok: false, code: "egress_timeout" });
    expect(viaRelay).toEqual(direct);
  }, 60_000);

  it("the relay forwarded exactly one paid request per paid call", () => {
    const paid = seller.seen.filter((request) => request.path === "/paid" && request.payment !== undefined);
    // Direct and relayed for /paid, plus /moved's redirect target, both ways.
    expect(paid).toHaveLength(4);
  });
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
