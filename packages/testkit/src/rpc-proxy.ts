import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { xdr } from "@stellar/stellar-sdk";

/**
 * What the proxy does with one `sendTransaction` request:
 * - `forward` passes it to the network;
 * - `hold` keeps it, unforwarded and unanswered, until `releaseHeld()` or `discardHeld()`;
 * - `drop` answers HTTP 502 without forwarding, as if the connection failed before broadcast.
 */
export type SendAction = "forward" | "hold" | "drop";

/** Emitted on `events` as `held` whenever a request or a response is held back. */
export interface HeldEvent {
  readonly method: string;
  /** `request`: held before forwarding; `response`: forwarded, with the answer held back. */
  readonly phase: "request" | "response";
  /** The envelope (base64 XDR) of a held `sendTransaction`. */
  readonly transaction?: string;
}

export interface RpcProxy {
  readonly url: string;
  /** Every `sendTransaction` envelope (base64 XDR) that reached the proxy, in order, forwarded or not. */
  readonly sent: string[];
  /**
   * What callers were answered, by method: `sendTransaction` by status (and result code for
   * `ERROR`, e.g. `ERROR:txBadSeq` or `ERROR:txFeeBumpInnerFailed:txBadSeq`), `getTransaction` by status, and `HTTP_502` for connections the
   * proxy failed on purpose.
   */
  readonly statuses: Map<string, Map<string, number>>;
  /** Every `sendTransaction` the network answered, in order: the envelope and its status as in `statuses`. */
  readonly answers: { readonly transaction: string; readonly status: string }[];
  /** Emits `request` ({ method }) for every request and `held` (`HeldEvent`) for everything held back. */
  readonly events: EventEmitter;
  /**
   * When true, `sendTransaction` is forwarded to the network but the caller receives HTTP 502, as if
   * the connection dropped after broadcast. Models a crash or timeout after submission.
   */
  loseSendResponses: boolean;
  /** When true, `getTransaction` answers NOT_FOUND, as if confirmation were slow. */
  hideTransactions: boolean;
  /** Decides per envelope what happens to a `sendTransaction`; unset forwards everything. */
  onSendTransaction: ((transaction: string) => SendAction) | undefined;
  /** Forwards requests of `method` but holds their answers back until `releaseHeld()`. */
  holdResponses(method: string): void;
  /** Answers `getTransaction` with NOT_FOUND until `predicate` first returns true. */
  hideTransactionsUntil(predicate: () => boolean): void;
  /**
   * Reports `sequence` as the latest ledger in `getHealth` and `getLatestLedger` answers, so an
   * expiry boundary cannot move while a test runs; `undefined` reports the network's own again.
   * Simulation and submission still run against the real ledger state.
   */
  pinLedger(sequence: number | undefined): void;
  /**
   * Answers every request (or every request of `method`) with HTTP `status` and no JSON-RPC body,
   * without forwarding it, as an overloaded RPC or gateway would; `undefined` forwards again.
   */
  failRequests(status: number | undefined, method?: string): void;
  /** Runs `fn` with the request's params before each request of `method` is forwarded. */
  injectBefore(method: string, fn: ((params: unknown) => Promise<void>) | undefined): void;
  /** Completes everything held: held requests are forwarded, held responses delivered. */
  releaseHeld(): Promise<void>;
  /** Drops everything held without forwarding or answering; the callers' connections are closed. */
  discardHeld(): void;
  /** Stops holding, hiding, pinning and injecting, and clears the recorded envelopes and statuses. */
  reset(): void;
  close(): Promise<void>;
}

interface Held {
  complete(): Promise<void>;
  discard(): void;
}

/** A JSON-RPC proxy in front of a Stellar RPC, for fault-injection tests. */
export async function startRpcProxy(target: string): Promise<RpcProxy> {
  const sent: string[] = [];
  const statuses = new Map<string, Map<string, number>>();
  const answers: { transaction: string; status: string }[] = [];
  const events = new EventEmitter();
  const held: Held[] = [];
  const heldMethods = new Set<string>();
  const injections = new Map<string, (params: unknown) => Promise<void>>();
  const state: {
    loseSendResponses: boolean;
    hideTransactions: boolean;
    hideUntil: (() => boolean) | undefined;
    onSendTransaction: ((transaction: string) => SendAction) | undefined;
    pinnedLedger: number | undefined;
    failing: { status: number; method: string | undefined } | undefined;
  } = {
    loseSendResponses: false,
    hideTransactions: false,
    hideUntil: undefined,
    onSendTransaction: undefined,
    pinnedLedger: undefined,
    failing: undefined,
  };

  const count = (method: string, status: string) => {
    let byStatus = statuses.get(method);
    if (byStatus === undefined) statuses.set(method, (byStatus = new Map<string, number>()));
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
  };

  const fail = (response: ServerResponse, method: string | undefined, message: string) => {
    if (method !== undefined) count(method, "HTTP_502");
    response.writeHead(502).end(message);
  };

  const hiding = () => {
    if (state.hideTransactions) return true;
    if (state.hideUntil === undefined) return false;
    if (state.hideUntil()) {
      state.hideUntil = undefined;
      return false;
    }
    return true;
  };

  /** Forwards the body and answers the caller, unless the answer is held back. */
  const forward = async (
    method: string | undefined,
    params: unknown,
    body: string,
    response: ServerResponse,
  ) => {
    const inject = method === undefined ? undefined : injections.get(method);
    if (inject !== undefined) await inject(params);
    const upstream = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    let text = await upstream.text();
    if (method === "sendTransaction" && state.loseSendResponses) {
      fail(response, method, "connection lost");
      return;
    }
    if (method === "getTransaction" && hiding()) text = hidden(text);
    if (state.pinnedLedger !== undefined && method !== undefined) {
      text = pinned(method, text, state.pinnedLedger);
    }
    const answer = () => {
      if (method !== undefined) {
        const status = statusOf(method, text);
        count(method, status);
        const { transaction } = transactionOf(method, params);
        if (transaction !== undefined) answers.push({ transaction, status });
      }
      response.writeHead(upstream.status, { "content-type": "application/json" }).end(text);
    };
    if (method !== undefined && heldMethods.has(method)) {
      held.push({
        complete: () => {
          answer();
          return Promise.resolve();
        },
        discard: () => response.destroy(),
      });
      const event: HeldEvent = { method, phase: "response", ...transactionOf(method, params) };
      events.emit("held", event);
      return;
    }
    answer();
  };

  const handle = async (request: IncomingMessage, response: ServerResponse, body: string) => {
    let method: string | undefined;
    let params: unknown;
    try {
      const parsed = JSON.parse(body) as { method?: string; params?: unknown };
      method = parsed.method;
      params = parsed.params;
    } catch {
      // Forward unparseable bodies unchanged; the RPC reports the error.
    }
    if (method !== undefined) events.emit("request", { method });
    const failing = state.failing;
    if (failing !== undefined && (failing.method === undefined || failing.method === method)) {
      if (method !== undefined) count(method, `HTTP_${String(failing.status)}`);
      response.writeHead(failing.status, { "content-type": "text/plain" }).end("unavailable");
      return;
    }

    const { transaction } = transactionOf(method, params);
    if (transaction !== undefined) sent.push(transaction);
    const action: SendAction =
      transaction === undefined ? "forward" : (state.onSendTransaction?.(transaction) ?? "forward");
    if (action === "drop") {
      fail(response, method, "connection lost before broadcast");
      return;
    }
    if (action === "hold") {
      held.push({
        complete: () => forward(method, params, body, response),
        discard: () => request.socket.destroy(),
      });
      const event: HeldEvent = { method: "sendTransaction", phase: "request", transaction };
      events.emit("held", event);
      return;
    }
    await forward(method, params, body, response);
  };

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      handle(request, response, body).catch((error: unknown) => {
        if (!response.headersSent) response.writeHead(502).end(String(error));
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(port)}`,
    sent,
    statuses,
    answers,
    events,
    get loseSendResponses() {
      return state.loseSendResponses;
    },
    set loseSendResponses(value: boolean) {
      state.loseSendResponses = value;
    },
    get hideTransactions() {
      return state.hideTransactions;
    },
    set hideTransactions(value: boolean) {
      state.hideTransactions = value;
    },
    get onSendTransaction() {
      return state.onSendTransaction;
    },
    set onSendTransaction(value: ((transaction: string) => SendAction) | undefined) {
      state.onSendTransaction = value;
    },
    holdResponses(method) {
      heldMethods.add(method);
    },
    hideTransactionsUntil(predicate) {
      state.hideUntil = predicate;
    },
    pinLedger(sequence) {
      state.pinnedLedger = sequence;
    },
    failRequests(status, method) {
      state.failing = status === undefined ? undefined : { status, method };
    },
    injectBefore(method, fn) {
      if (fn === undefined) injections.delete(method);
      else injections.set(method, fn);
    },
    async releaseHeld() {
      heldMethods.clear();
      await Promise.all(held.splice(0).map((item) => item.complete()));
    },
    discardHeld() {
      heldMethods.clear();
      for (const item of held.splice(0)) item.discard();
    },
    reset() {
      heldMethods.clear();
      injections.clear();
      state.loseSendResponses = false;
      state.hideTransactions = false;
      state.hideUntil = undefined;
      state.onSendTransaction = undefined;
      state.pinnedLedger = undefined;
      state.failing = undefined;
      sent.length = 0;
      statuses.clear();
      answers.length = 0;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const item of held.splice(0)) item.discard();
        server.closeAllConnections();
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

function transactionOf(method: string | undefined, params: unknown): { transaction?: string } {
  if (method !== "sendTransaction" || typeof params !== "object" || params === null) return {};
  const { transaction } = params as { transaction?: unknown };
  return typeof transaction === "string" ? { transaction } : {};
}

/** The status a JSON-RPC answer reports, for the proxy's per-method counts. */
function statusOf(method: string, text: string): string {
  try {
    const parsed = JSON.parse(text) as {
      result?: { status?: string; errorResultXdr?: string };
      error?: { code?: number };
    };
    if (parsed.error !== undefined) return `RPC_ERROR:${String(parsed.error.code ?? "")}`;
    const status = parsed.result?.status ?? "OK";
    if (method === "sendTransaction" && status === "ERROR" && parsed.result?.errorResultXdr !== undefined) {
      const result = xdr.TransactionResult.fromXDR(parsed.result.errorResultXdr, "base64").result();
      const name = result.switch().name;
      // A fee bump whose inner transaction failed names the inner code too, e.g. its txBadSeq.
      if (name === "txFeeBumpInnerFailed") {
        return `ERROR:${name}:${result.innerResultPair().result().result().switch().name}`;
      }
      return `ERROR:${name}`;
    }
    return status;
  } catch {
    return "UNPARSEABLE";
  }
}

/** Rewrites a getTransaction response to NOT_FOUND, keeping the ledger range fields. */
function hidden(text: string): string {
  const parsed = JSON.parse(text) as { result?: Record<string, unknown> };
  if (parsed.result === undefined) return text;
  const { latestLedger, latestLedgerCloseTime, oldestLedger, oldestLedgerCloseTime } = parsed.result;
  return JSON.stringify({
    ...parsed,
    result: { status: "NOT_FOUND", latestLedger, latestLedgerCloseTime, oldestLedger, oldestLedgerCloseTime },
  });
}

/** Rewrites the latest ledger a `getHealth` or `getLatestLedger` answer reports. */
function pinned(method: string, text: string, sequence: number): string {
  const field =
    method === "getHealth" ? "latestLedger" : method === "getLatestLedger" ? "sequence" : undefined;
  if (field === undefined) return text;
  const parsed = JSON.parse(text) as { result?: Record<string, unknown> };
  if (parsed.result === undefined) return text;
  return JSON.stringify({ ...parsed, result: { ...parsed.result, [field]: sequence } });
}

/**
 * Submissions that show two transactions competing for one channel sequence, from a proxy's
 * `answers`: the first submission of any envelope answered other than `PENDING` (a `TRY_AGAIN_LATER`
 * included). Later submissions of the same bytes (a rebroadcast) may be `DUPLICATE` while queued,
 * `txBadSeq` once those very bytes were applied, or `TRY_AGAIN_LATER` when a busy node throttles its
 * queue; none is a conflict, because the first answer already showed the sequence was free.
 */
export function sequenceConflicts(
  answers: readonly { readonly transaction: string; readonly status: string }[],
): { transaction: string; status: string; first: boolean }[] {
  const seen = new Set<string>();
  const conflicts: { transaction: string; status: string; first: boolean }[] = [];
  for (const { transaction, status } of answers) {
    const first = !seen.has(transaction);
    seen.add(transaction);
    if (first && status !== "PENDING") {
      conflicts.push({ transaction: transaction.slice(0, 16), status, first });
    } else if (
      !first &&
      !["PENDING", "DUPLICATE", "TRY_AGAIN_LATER"].includes(status) &&
      !status.endsWith("txBadSeq")
    ) {
      conflicts.push({ transaction: transaction.slice(0, 16), status, first });
    }
  }
  return conflicts;
}
