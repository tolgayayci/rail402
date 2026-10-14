/**
 * What the browser tests watch besides the page: the stack's control server (balances, server logs,
 * the decoy origin), public Horizon pinned like testkit's `pinHorizon` does in Node, every console
 * error and CSP violation, and every request the browser sent with its answer. The browser's half of
 * the canary scan lives here too, shared with the live Playground evidence run.
 */
import type { BrowserContext, ConsoleMessage, Page, Request, Response } from "@playwright/test";
import type { SecretScanner } from "@rail402.dev/testkit";
import { RELAY_HEADER_PREFIX, RELAY_PATH } from "../src/shared/relay-protocol.ts";
import { TRACE_HEADER, decodeTrace } from "../src/shared/trace.ts";
import { E2E_CONTROL, type StackInfo } from "./ports.ts";

export async function control<T>(path: string): Promise<T> {
  const response = await fetch(`${E2E_CONTROL}${path}`);
  if (!response.ok) throw new Error(`control ${path}: HTTP ${String(response.status)}`);
  return (await response.json()) as T;
}

export const stackInfo = (): Promise<StackInfo> => control<StackInfo>("/stack");

/** The USDC balance of an account, in base units. */
export async function balance(account: string): Promise<bigint> {
  const { balance: value } = await control<{ balance: string }>(
    `/balance?account=${encodeURIComponent(account)}`,
  );
  return BigInt(value);
}

/** The public Horizon origins the stock exact client reads its ledger-time estimate from. */
const HORIZON = /^https:\/\/horizon(-testnet)?\.stellar\.org\//;
const LEDGER_SECONDS = 5;

/**
 * Answers public Horizon's `/ledgers` with 20 ledgers exactly 5 s apart, as the in-process
 * facilitator sees them, so the buyer and the verifier agree on expiration ledgers. Other Horizon
 * paths answer 404, as nothing else should be read.
 */
export async function pinHorizon(context: BrowserContext): Promise<void> {
  await context.route(HORIZON, async (route) => {
    const url = new URL(route.request().url());
    const headers = { "access-control-allow-origin": "*", "content-type": "application/hal+json" };
    if (url.pathname !== "/ledgers") {
      await route.fulfill({ status: 404, headers, body: "{}" });
      return;
    }
    const now = Math.floor(Date.now() / 1_000);
    const records = Array.from({ length: 20 }, (_, index) => ({
      id: String(1_000_000 - index),
      paging_token: String((1_000_000 - index) * 4096),
      sequence: 1_000_000 - index,
      closed_at: new Date((now - index * LEDGER_SECONDS) * 1_000).toISOString(),
    }));
    const self = { href: url.href };
    await route.fulfill({
      status: 200,
      headers,
      body: JSON.stringify({ _links: { self, next: self, prev: self }, _embedded: { records } }),
    });
  });
}

/** One console message or page error that must not happen. */
export interface PageProblem {
  readonly page: string;
  readonly kind: "console" | "pageerror";
  readonly text: string;
}

/**
 * The page logs nothing at error level, and CSP violations surface there too. Chromium logs every
 * HTTP error answer to `fetch` as "Failed to load resource" with the resource's URL. The expected ones
 * are 4xx answers (the 402s that price a resource, the refusals the checks provoke on purpose) and the
 * relay's coded refusals, which carry the egress code's status (the suite checks their bodies); any
 * other 5xx counts, as does every other error.
 */
export function watchProblems(page: Page, name: string, problems: PageProblem[]): string[] {
  const all: string[] = [];
  page.on("console", (message: ConsoleMessage) => {
    all.push(`${message.type()}: ${message.text()}`);
    if (message.type() !== "error") return;
    const text = message.text();
    const status = /^Failed to load resource: the server responded with a status of (\d{3})\b/.exec(
      text,
    )?.[1];
    if (status !== undefined) {
      if (status.startsWith("4")) return;
      if (new URL(message.location().url).pathname === RELAY_PATH) return;
    }
    problems.push({ page: name, kind: "console", text: `${text} (${message.location().url})` });
  });
  page.on("pageerror", (error) => {
    problems.push({ page: name, kind: "pageerror", text: `${error.name}: ${error.message}` });
  });
  return all;
}

/** One request the browser sent, and its answer. */
export interface Exchange {
  readonly method: string;
  readonly url: string;
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly requestBody: string;
  status: number | null;
  responseHeaders: Readonly<Record<string, string>>;
  responseBody: string;
}

/** How long one part of an answer (headers, body) is waited for before its fallback is taken. */
const ANSWER_WAIT_MS = 10_000;

/** `promise`'s value, or `fallback()` when it fails or takes longer than `ms`. */
async function within<T>(promise: Promise<T>, ms: number, fallback: () => T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => {
          resolve(fallback());
        }, ms);
      }),
    ]);
  } catch {
    return fallback();
  } finally {
    clearTimeout(timer);
  }
}

/** Records every request of a browser context with its headers, body and answer. */
export class Traffic {
  readonly exchanges: Exchange[] = [];
  readonly #pending: Promise<void>[] = [];

  constructor(context: BrowserContext) {
    context.on("request", (request: Request) => {
      this.#pending.push(this.#record(request));
    });
  }

  async #record(request: Request): Promise<void> {
    const exchange: Exchange = {
      method: request.method(),
      url: request.url(),
      // `allHeaders()` waits for the network stack's extra header report, which some answers (from
      // the HTTP cache, for one) never get: the headers the page set are the fallback.
      requestHeaders: await within(request.allHeaders(), ANSWER_WAIT_MS, () => request.headers()),
      requestBody: request.postData() ?? "",
      status: null,
      responseHeaders: {},
      responseBody: "",
    };
    this.exchanges.push(exchange);
    const response: Response | null = await within(request.response(), ANSWER_WAIT_MS * 6, () => null);
    if (response === null) return;
    exchange.status = response.status();
    exchange.responseHeaders = await within(response.allHeaders(), ANSWER_WAIT_MS, () => response.headers());
    exchange.responseBody = await within(response.text(), ANSWER_WAIT_MS, () => "");
  }

  /** Waits until every request seen so far has its answer recorded. */
  async settled(): Promise<void> {
    await Promise.all(this.#pending);
  }
}

// --- the browser's half of the canary scan ---------------------------------------------------------

/** Request headers that carry a payment: to a lab seller directly, or to the relay. */
const PAYMENT_HEADERS = new Set(["payment-signature", `${RELAY_HEADER_PREFIX}payment-signature`]);

/** Whether a request carried a payment: a PAYMENT-SIGNATURE header or an MCP `_meta` payment. */
function carriesPayment(exchange: Exchange): boolean {
  return (
    Object.keys(exchange.requestHeaders).some((name) => PAYMENT_HEADERS.has(name)) ||
    exchange.requestBody.includes("x402/payment")
  );
}

/**
 * Adds every payment the page sent as needles: each PAYMENT-SIGNATURE (to the relay and the lab
 * sellers) and each MCP `_meta["x402/payment"]`, with its transaction, authorizations, preimages and
 * signatures. Returns how many payments it found.
 */
export function addPaymentNeedles(
  scanner: SecretScanner,
  exchanges: readonly Exchange[],
  passphrase: string,
): number {
  let payments = 0;
  for (const exchange of exchanges) {
    for (const [name, value] of Object.entries(exchange.requestHeaders)) {
      if (PAYMENT_HEADERS.has(name)) {
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
  return payments;
}

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
 * Captures every request and answer as channels. A payment may appear only in the request that
 * carried it, and signed transactions only in what the page sent the RPC; answers from the chain (the
 * RPC and Friendbot) are public ledger data and are not scanned. What those exempt requests carried
 * (RPC request bodies, and the headers and bodies of payment-carrying requests) is still captured into
 * `seedOnly`, a scanner whose only needles are the seed and its key bytes: the seed never appears
 * anywhere, payments and RPC calls included.
 */
export function captureExchanges(
  scanner: SecretScanner,
  exchanges: readonly Exchange[],
  chain: { readonly rpcUrl: string; readonly friendbotUrl: string },
  seedOnly: SecretScanner,
): void {
  const rpc = new URL(chain.rpcUrl).origin;
  const friendbot = new URL(chain.friendbotUrl);
  for (const [index, exchange] of exchanges.entries()) {
    const url = new URL(exchange.url);
    const channel = `${exchange.method} ${url.origin}${url.pathname} #${String(index)}`;
    const isRpc = url.origin === rpc;
    const isChain = isRpc || (url.origin === friendbot.origin && url.pathname === friendbot.pathname);
    scanner.capture(
      `${channel} request headers`,
      JSON.stringify(Object.entries(exchange.requestHeaders).filter(([name]) => !PAYMENT_HEADERS.has(name))),
    );
    seedOnly.capture(`${channel} request headers`, JSON.stringify(exchange.requestHeaders));
    if (!isRpc && !carriesPayment(exchange)) scanner.capture(`${channel} request body`, exchange.requestBody);
    seedOnly.capture(`${channel} request body`, exchange.requestBody);
    scanner.capture(
      `${channel} response headers`,
      JSON.stringify(
        Object.entries(exchange.responseHeaders).map(([name, value]) => [name, decodedHeader(name, value)]),
      ),
    );
    if (!isChain) scanner.capture(`${channel} response body`, exchange.responseBody);
  }
}

/**
 * Whether the seed-only scan finds a seed planted in an RPC request body: the exemptions of the main
 * scan must not hide it. Uses the first RPC request of `exchanges`.
 */
export function seedFoundInPlantedRpcBody(
  canarySeed: string,
  exchanges: readonly Exchange[],
  chain: { readonly rpcUrl: string; readonly friendbotUrl: string },
  scanner: (seed: string) => SecretScanner,
): boolean {
  const rpc = new URL(chain.rpcUrl).origin;
  const call = exchanges.find((exchange) => new URL(exchange.url).origin === rpc);
  if (call === undefined) return false;
  const planted: Exchange = {
    ...call,
    requestBody: call.requestBody.replace(/\}\s*$/, `,"x":"${canarySeed}"}`),
  };
  const seedOnly = scanner(canarySeed);
  captureExchanges(scanner(canarySeed), [planted], chain, seedOnly);
  return seedOnly.findings().some((finding) => finding.channel.includes("request body"));
}

/**
 * Where a run's events break the signing guard's order: a call signed twice or before its
 * reservation, or the signer seeing a different number of authorizations than were signed.
 */
export function guardProblems(events: readonly Record<string, unknown>[]): string[] {
  const problems: string[] = [];
  const reserved = new Set<string>();
  const signed: string[] = [];
  let reservations = 0;
  let auths = 0;
  for (const event of events) {
    const sdk = event["kind"] === "sdk" ? (event["event"] as { type?: string; callId?: string }) : undefined;
    if (sdk?.type === "reserved" && sdk.callId !== undefined) {
      reserved.add(sdk.callId);
      reservations++;
    }
    if (sdk?.type === "signed" && sdk.callId !== undefined) {
      if (!reserved.has(sdk.callId)) problems.push(`call ${sdk.callId} signed before its reservation`);
      signed.push(sdk.callId);
    }
    if (event["kind"] === "auth" && ++auths > reservations)
      problems.push("an authorization before any reservation");
  }
  if (new Set(signed).size !== signed.length) problems.push("a call signed more than once");
  if (auths !== signed.length)
    problems.push(`${String(auths)} authorizations seen, ${String(signed.length)} signed`);
  return problems;
}

/** The relay's 5xx answers that are not one of its coded refusals: there must be none. */
export function uncodedRelayFailures(exchanges: readonly Exchange[]): string[] {
  const problems: string[] = [];
  for (const exchange of exchanges) {
    if (new URL(exchange.url).pathname !== RELAY_PATH || (exchange.status ?? 0) < 500) continue;
    let body: { error?: { code?: unknown; reason?: unknown } } = {};
    try {
      body = JSON.parse(exchange.responseBody) as typeof body;
    } catch {
      // Not JSON: reported below.
    }
    const code = typeof body.error?.code === "string" ? body.error.code : "";
    const reason = typeof body.error?.reason === "string" ? body.error.reason : "";
    if (
      exchange.responseHeaders["x-relay"] !== "error" ||
      !/^(egress|playground)_/.test(code) ||
      reason === ""
    )
      problems.push(`relay answered HTTP ${String(exchange.status)} without a coded refusal`);
  }
  return problems;
}

/** Reads every IndexedDB record of the page's origin as JSON, bytes as base64. */
const DUMP_INDEXED_DB = `(async () => {
  const encode = (value) => {
    if (value instanceof ArrayBuffer) value = new Uint8Array(value);
    if (ArrayBuffer.isView(value)) {
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      let text = "";
      for (const byte of bytes) text += String.fromCharCode(byte);
      return { bytes: btoa(text) };
    }
    if (typeof CryptoKey !== "undefined" && value instanceof CryptoKey)
      return { cryptoKey: { type: value.type, extractable: value.extractable, usages: value.usages } };
    if (Array.isArray(value)) return value.map(encode);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
    return value;
  };
  const request = (target) =>
    new Promise((resolve, reject) => {
      target.onsuccess = () => resolve(target.result);
      target.onerror = () => reject(target.error);
    });
  const out = {};
  for (const { name } of await indexedDB.databases()) {
    const db = await request(indexedDB.open(name));
    for (const store of db.objectStoreNames) {
      const records = await request(db.transaction(store).objectStore(store).getAll());
      out[name + "/" + store] = records.map(encode);
    }
    db.close();
  }
  return JSON.stringify(out);
})()`;

/**
 * Captures what the page keeps: localStorage, sessionStorage and every IndexedDB record. Returns the
 * IndexedDB dump, so a caller can check how the wallet's key is stored.
 */
export async function captureStorage(scanner: SecretScanner, page: Page): Promise<string> {
  scanner.capture("localStorage", await page.evaluate("JSON.stringify(Object.entries(localStorage))"));
  scanner.capture("sessionStorage", await page.evaluate("JSON.stringify(Object.entries(sessionStorage))"));
  const stored = String(await page.evaluate(DUMP_INDEXED_DB));
  scanner.capture("IndexedDB", stored);
  return stored;
}

/** One value of a payment header the page sent, for a planted-leak self-test. */
export function samplePaymentHeader(exchanges: readonly Exchange[]): string | undefined {
  return exchanges
    .flatMap((exchange) =>
      Object.entries(exchange.requestHeaders).filter(([name]) => PAYMENT_HEADERS.has(name)),
    )
    .map(([, value]) => value)[0];
}
