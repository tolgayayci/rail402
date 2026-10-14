/**
 * Observes the seller transports and reports each request as `http` lab events: what was sent (method,
 * URL, header names, size, the JSON-RPC method of an MCP message) and what came back (status, timing,
 * the decoded 402, settlement response, seller trace and MCP answer). Header values, bodies and
 * payment payloads never leave this module.
 *
 * For the "send it twice" experiment the observer can hold the next paid HTTP request of a run in a
 * closure and send it once more, unchanged, straight through the same transport: no SDK call, so
 * nothing is signed or reserved. The held request is dropped after the resend and when the run ends.
 */
import {
  finalRequestOf,
  isEgressError,
  markFinalRequest,
  type SafeFetch,
  type SafeRequestInit,
} from "@rail402.dev/safe-fetch/shared";
import { TRACE_HEADER, decodeTrace, parseServerTiming } from "../../../src/shared/trace.ts";
import {
  mcpRequestOf,
  mcpResponseView,
  requiredFromHeader,
  settleFromHeader,
  type DecodeContext,
} from "../engine/decode.ts";
import type { LabEventBody, McpResponseView } from "../engine/events.ts";
import { bodyBytes } from "./body.ts";
import { relayCodeOf } from "./relay-fetch.ts";

type HttpEvent = Extract<LabEventBody, { kind: "http" }>;
type ResponseEvent = Extract<HttpEvent, { phase: "response" }>;

/** Where one run's observations go, and how its 402s are judged. */
export interface ObserverSink extends Omit<DecodeContext, "assetFacts"> {
  emit(event: HttpEvent): void;
}

/** A held paid request, sent once more by `resend`. */
export interface ReplayHandle {
  /** Whether a paid request has been held. */
  readonly held: boolean;
  /** Sends the held request again through its transport and drops it; rejects when none is held. */
  resend(): Promise<Response>;
  drop(): void;
}

/** Largest MCP answer read for its view. */
const RPC_ANSWER_BYTES = 1_048_576;

interface Held {
  readonly send: (url: string, init: SafeRequestInit) => Promise<Response>;
  readonly url: string;
  readonly init: SafeRequestInit;
}

export class Observer {
  readonly #assetFacts: DecodeContext["assetFacts"];
  #sink: ObserverSink | null = null;
  #counter = 0;
  #armed = false;
  #held: Held | undefined;
  #now: () => number;

  constructor(options: { readonly assetFacts: DecodeContext["assetFacts"]; readonly now?: () => number }) {
    this.#assetFacts = options.assetFacts;
    this.#now = options.now ?? (() => performance.now());
  }

  /** Routes observations to one run until `detach`. */
  attach(sink: ObserverSink): void {
    this.#sink = sink;
  }

  /** Stops reporting and drops any held request. */
  detach(): void {
    this.#sink = null;
    this.#armed = false;
    this.#held = undefined;
  }

  /** Holds the next paid HTTP request, for one resend. */
  armReplay(): ReplayHandle {
    this.#armed = true;
    this.#held = undefined;
    const drop = () => {
      this.#armed = false;
      this.#held = undefined;
    };
    const isHeld = () => this.#held !== undefined;
    return {
      get held() {
        return isHeld();
      },
      resend: () => {
        const held = this.#held;
        drop();
        if (held === undefined) return Promise.reject(new Error("no paid request was held"));
        return held.send(held.url, held.init);
      },
      drop,
    };
  }

  /** Wraps a seller transport; its events carry `via`. */
  wrap(fetch: SafeFetch, via: "relay" | "direct"): SafeFetch {
    const observed = async (input: string | URL, init: SafeRequestInit = {}): Promise<Response> => {
      const sink = this.#sink;
      const url = typeof input === "string" ? input : input.href;
      const headers = new Headers(init.headers);
      const method = (init.method ?? "GET").toUpperCase();
      const rpc = mcpRequestOf(init.body);
      const paidHttp = headers.has("payment-signature");
      if (this.#armed && paidHttp && rpc === undefined) {
        this.#armed = false;
        this.#held = { send: observed, url, init: { ...init, headers: new Headers(headers) } };
      }
      const id = `${via}-${String(++this.#counter)}`;
      sink?.emit({
        kind: "http",
        phase: "request",
        id,
        via,
        method,
        url,
        paid: paidHttp || rpc?.view.hasPayment === true,
        headerNames: [...new Set([...headers.keys()].map((name) => name.toLowerCase()))].sort(),
        bodyBytes: bodyBytes(init.body),
        ...(rpc === undefined ? {} : { rpc: rpc.view }),
      });
      const started = this.#now();
      let response: Response;
      try {
        response = await fetch(input, init);
      } catch (error) {
        sink?.emit(failure(id, error));
        throw error;
      }
      const context: DecodeContext = {
        assetFacts: this.#assetFacts,
        judge: sink?.judge,
        advertised: sink?.advertised,
      };
      const event = responseEvent(id, response, Math.round(this.#now() - started), context);
      if (rpc === undefined || rpc.id === null || response.body === null) {
        sink?.emit(event);
        return response;
      }
      // An MCP answer: read a copy of the body for the JSON-RPC result, hand the other to the client.
      const [mine, theirs] = response.body.tee();
      const answer = new Response(theirs, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
      Object.defineProperty(answer, "url", { value: response.url });
      Object.defineProperty(answer, "redirected", { value: response.redirected });
      const final = finalRequestOf(response);
      if (final !== undefined) markFinalRequest(answer, final);
      void readRpcAnswer(mine, response.headers.get("content-type"), rpc.id, context).then((view) => {
        sink?.emit(view === undefined ? event : { ...event, rpc: view });
      });
      return answer;
    };
    return Object.assign(observed, {
      policy: fetch.policy,
      close: () => {
        fetch.close();
      },
    });
  }
}

/** The failure event of a request that got no answer. */
function failure(id: string, error: unknown): HttpEvent {
  if (isEgressError(error)) {
    return {
      kind: "http",
      phase: "failed",
      id,
      code: relayCodeOf(error) ?? error.code,
      reason: error.reason,
      stage: error.stage,
    };
  }
  if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return {
      kind: "http",
      phase: "failed",
      id,
      code: "playground_run_aborted",
      reason: "The request was stopped.",
    };
  }
  return {
    kind: "http",
    phase: "failed",
    id,
    code: "egress_connection_failed",
    reason: "The request failed before an answer arrived.",
  };
}

function responseEvent(id: string, response: Response, ms: number, context: DecodeContext): ResponseEvent {
  const required =
    response.status === 402
      ? requiredFromHeader(response.headers.get("payment-required"), context)
      : undefined;
  const settle = settleFromHeader(response.headers.get("payment-response"));
  const trace = decodeTrace(response.headers.get(TRACE_HEADER));
  const timing = parseServerTiming(response.headers.get("server-timing"));
  return {
    kind: "http",
    phase: "response",
    id,
    status: response.status,
    ms,
    ...(required === undefined ? {} : { required }),
    ...(settle === undefined ? {} : { settle }),
    ...(trace === undefined ? {} : { trace }),
    ...(Object.keys(timing).length === 0 ? {} : { timing }),
  };
}

/**
 * Reads an MCP answer (JSON, or server-sent events carrying JSON) until the message answering `id`,
 * then stops reading. Undefined when none arrives within the size limit.
 */
async function readRpcAnswer(
  body: ReadableStream<Uint8Array>,
  contentType: string | null,
  id: string | number,
  context: DecodeContext,
): Promise<McpResponseView | undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const sse = (contentType ?? "").toLowerCase().includes("text/event-stream");
  let buffer = "";
  let read = 0;
  const answerOf = (json: string): McpResponseView | undefined => {
    let message: unknown;
    try {
      message = JSON.parse(json) as unknown;
    } catch {
      return undefined;
    }
    const messages = Array.isArray(message) ? (message as unknown[]) : [message];
    for (const candidate of messages) {
      if (typeof candidate !== "object" || candidate === null) continue;
      if ((candidate as { id?: unknown }).id !== id) continue;
      const view = mcpResponseView(candidate, context);
      if (view !== undefined) return view;
    }
    return undefined;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value !== undefined) {
        read += value.byteLength;
        buffer += decoder.decode(value, { stream: !done });
      }
      if (read > RPC_ANSWER_BYTES) return undefined;
      if (sse) {
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = done ? "" : (events.pop() ?? "");
        for (const event of events) {
          const data = event
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, ""))
            .join("\n");
          if (data === "") continue;
          const view = answerOf(data);
          if (view !== undefined) return view;
        }
      }
      if (done) return sse ? undefined : answerOf(buffer);
    }
  } catch {
    return undefined;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
