import { X402Error } from "@rail402.dev/errors";

/**
 * Minimal Soroban JSON-RPC client. No SDK: with `xdrFormat: "json"` the RPC returns fully decoded
 * ScVals, so the explorer never touches XDR (verified against live captures, fixtures/README.md).
 */

const RPC_TIMEOUT_MS = 10_000;

export interface RpcErrorShape {
  readonly code: number;
  readonly message: string;
}

/** Thrown for transport failures and JSON-RPC error responses alike, with the shape attached. */
export class RpcRequestError extends Error {
  readonly rpcError?: RpcErrorShape;
  constructor(message: string, rpcError?: RpcErrorShape) {
    super(message);
    this.name = "RpcRequestError";
    if (rpcError) this.rpcError = rpcError;
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export async function rpcCall(
  url: string,
  method: string,
  params: unknown,
  fetchImpl: FetchLike = fetch,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
  } catch (error) {
    throw new RpcRequestError(
      `RPC ${method} to ${url} failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
  if (!response.ok) {
    throw new RpcRequestError(`RPC ${method} to ${url} returned HTTP ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new RpcRequestError(`RPC ${method} to ${url} returned a non-JSON body`);
  }
  const record = body as { result?: unknown; error?: RpcErrorShape };
  if (record.error) {
    throw new RpcRequestError(
      `RPC ${method} error ${record.error.code}: ${record.error.message}`,
      record.error,
    );
  }
  return record.result;
}

/** Wrap any RPC failure into the coded, retryable explorer error for health reporting. */
export function asIngestError(error: unknown): X402Error {
  return new X402Error("explorer_ingest_rpc_unavailable", {
    reason: `Soroban RPC is unreachable or refused the request: ${error instanceof Error ? error.message : "unknown error"}. Ingestion resumes from its cursor once RPC answers again.`,
  });
}

/**
 * True when getEvents refused our cursor/startLedger because it fell outside the retention
 * window — the signal to re-anchor at the ledger head (and, if the head moved BACKWARDS, that
 * the network was reset). Matched on the RPC's actual wording, captured live:
 * "startLedger must be within the ledger range: 4003000 - 4123959".
 */
export function isOutOfWindowError(error: unknown): boolean {
  if (!(error instanceof RpcRequestError) || error.rpcError === undefined) return false;
  const message = error.rpcError.message.toLowerCase();
  // Match the RPC's actual out-of-window wordings, NOT a bare "cursor" substring — a spurious
  // match would silently discard the stored cursor and skip a swathe of ledgers (review m3).
  return (
    message.includes("must be within the ledger range") ||
    message.includes("start is before oldest ledger") ||
    message.includes("startledger must be within") ||
    (message.includes("cursor") && message.includes("out of"))
  );
}
