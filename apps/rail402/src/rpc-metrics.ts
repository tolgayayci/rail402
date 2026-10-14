import diagnostics from "node:diagnostics_channel";
import type { rpc } from "@stellar/stellar-sdk";
import { PUBNET, TESTNET, type StellarNetwork } from "@rail402.dev/stellar";
import type { Metrics } from "./metrics.ts";

/**
 * The public Horizon `@x402/stellar` reads its ledger-time estimate from, per network. It is fixed
 * upstream, whatever RPC is configured, so its failures are watched too.
 */
export const HORIZON_ORIGINS: Readonly<Record<StellarNetwork, string>> = {
  [TESTNET]: "https://horizon-testnet.stellar.org",
  [PUBNET]: "https://horizon.stellar.org",
};

/** RPC methods counted by name; any other method is counted as `other`, keeping cardinality bounded. */
export const RPC_METHODS = [
  "getEvents",
  "getFeeStats",
  "getHealth",
  "getLatestLedger",
  "getLedgerEntries",
  "getLedgers",
  "getNetwork",
  "getTransaction",
  "getTransactions",
  "getVersionInfo",
  "sendTransaction",
  "simulateTransaction",
] as const;

const KNOWN_METHODS: ReadonlySet<string> = new Set(RPC_METHODS);

export type RpcOutcome = "ok" | "rpc_error" | "http_error" | "timeout" | "network_error";

export function rpcMethodLabel(method: unknown): string {
  return typeof method === "string" && KNOWN_METHODS.has(method) ? method : "other";
}

/**
 * Counts and times every JSON-RPC call a Rail402-owned RPC client makes. The Stellar SDK sends each
 * call through its HTTP client's `post`, so wrapping it sees the method in the request body and the
 * JSON-RPC error or transport failure in the answer; the call itself is unchanged.
 */
export function meterRpcServer(server: rpc.Server, network: string, metrics: Metrics): void {
  const client = server.httpClient;
  const post = client.post.bind(client);
  client.post = async <T>(...args: Parameters<typeof post>) => {
    const data: unknown = args[1];
    const method = rpcMethodLabel(isRecord(data) ? data["method"] : undefined);
    const started = performance.now();
    let outcome: RpcOutcome = "ok";
    try {
      const response = await post<T>(...args);
      if (isRecord(response.data) && response.data["error"] !== undefined) outcome = "rpc_error";
      return response;
    } catch (error) {
      outcome = transportOutcome(error);
      throw error;
    } finally {
      metrics.rpcRequests.inc({ network, method, outcome });
      metrics.rpcDuration.observe({ network, method }, (performance.now() - started) / 1_000);
    }
  };
}

/** How an HTTP client error failed: the server answered with an error status, timed out, or never answered. */
export function transportOutcome(error: unknown): Exclude<RpcOutcome, "ok" | "rpc_error"> {
  if (!isRecord(error)) return "network_error";
  const response = error["response"];
  if (isRecord(response) && typeof response["status"] === "number") return "http_error";
  const name = typeof error["name"] === "string" ? error["name"] : "";
  const message = typeof error["message"] === "string" ? error["message"] : "";
  if (name === "TimeoutError" || error["code"] === "ECONNABORTED" || /\btimeout\b/i.test(message)) {
    return "timeout";
  }
  return "network_error";
}

/** An origin whose HTTP failures are counted, and what it is. */
export interface TransportTarget {
  /** `scheme://host[:port]`, as `new URL(…).origin` spells it. */
  readonly origin: string;
  readonly network: string;
  readonly target: "rpc" | "horizon";
}

/**
 * Counts failed HTTP exchanges with the given origins from every client in the process, including
 * the per-call RPC and Horizon clients `@x402/stellar` creates itself, by listening to the
 * diagnostics channels Node's built-in `fetch` (undici) publishes. A failure is a request that never
 * got an answer (`network`), an HTTP 5xx (`http_5xx`) or an HTTP 429 (`http_429`); each target and
 * kind is exported at zero until it first counts. Returns a function that stops listening.
 */
export function watchTransport(targets: readonly TransportTarget[], metrics: Metrics): () => void {
  const byOrigin = new Map(targets.map((target) => [target.origin, target]));
  const targetOf = (request: unknown): TransportTarget | undefined => {
    if (!isRecord(request)) return undefined;
    const origin = request["origin"];
    if (typeof origin === "string") return byOrigin.get(origin);
    if (origin instanceof URL) return byOrigin.get(origin.origin);
    return undefined;
  };
  const kinds = ["network", "http_5xx", "http_429"] as const;
  const count = (target: TransportTarget, kind: (typeof kinds)[number], by = 1) => {
    metrics.rpcTransportErrors.inc({ network: target.network, target: target.target, kind }, by);
  };
  // Every watched target is scraped at zero before its first failure.
  for (const target of targets) for (const kind of kinds) count(target, kind, 0);
  const onHeaders = (message: unknown) => {
    if (!isRecord(message)) return;
    const target = targetOf(message["request"]);
    const response = message["response"];
    if (target === undefined || !isRecord(response)) return;
    const status = response["statusCode"];
    if (typeof status !== "number") return;
    if (status === 429) count(target, "http_429");
    else if (status >= 500) count(target, "http_5xx");
  };
  const onError = (message: unknown) => {
    if (!isRecord(message)) return;
    const target = targetOf(message["request"]);
    if (target !== undefined) count(target, "network");
  };
  diagnostics.subscribe("undici:request:headers", onHeaders);
  diagnostics.subscribe("undici:request:error", onError);
  return () => {
    diagnostics.unsubscribe("undici:request:headers", onHeaders);
    diagnostics.unsubscribe("undici:request:error", onError);
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
