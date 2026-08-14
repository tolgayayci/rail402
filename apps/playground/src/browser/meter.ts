import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { createEd25519Signer } from "@x402/stellar";
import { UptoStellarClientScheme } from "@rail402/scheme-upto-stellar";
import { txUrl } from "./format.js";
import type { Session } from "./session.js";

/**
 * Browser client for the `upto` "bar tab": open a tab by authorizing a ceiling, accrue usage with
 * calls, then close to settle only what was used. Opening is a standard 402→pay→retry flow, so it
 * rides the stock `wrapFetchWithPayment` with the `upto` client scheme registered; the calls and
 * the close are plain requests carrying the tab id.
 *
 * The ceiling that actually binds is whatever the buyer signs, which the design lets the user set —
 * pass `ceilingStroops` and the tab authorizes exactly that, never the seller's advertised default.
 */

export interface OpenTabOptions {
  readonly session: Session;
  readonly playgroundUrl: string;
  readonly network: string;
  /** Ceiling to authorize, in stroops. Omit to accept the seller's advertised ceiling. */
  readonly ceilingStroops?: string;
  readonly onStep?: (step: MeterOpenStep) => void;
  readonly fetchImpl?: typeof fetch;
}

export type MeterOpenPhase = "challenged" | "authorizing" | "authorized" | "opened";

export interface MeterOpenStep {
  readonly phase: MeterOpenPhase;
  readonly message: string;
}

export interface OpenTab {
  readonly tabId: string;
  readonly ceilingStroops: string;
  readonly unitStroops: string;
  readonly payer: string | undefined;
  readonly expiresInSeconds: number;
}

export interface MeterCall {
  readonly call: number;
  readonly digest: string;
  readonly unitStroops: string;
  readonly usedStroops: string;
  readonly remainingStroops: string;
}

export interface MeterClose {
  readonly transaction: string | undefined;
  readonly explorerUrl: string | undefined;
  readonly settledStroops: string;
  readonly ceilingStroops: string;
  readonly unspentStroops: string;
  readonly calls: number;
}

const MESSAGES: Record<MeterOpenPhase, string> = {
  challenged: "The tab endpoint quoted a ceiling to authorize.",
  authorizing: "Signing an authorization for up to the ceiling — not a stroop more.",
  authorized: "Ceiling authorized. Usage will accrue against it; settlement charges only what is used.",
  opened: "Tab open. Make calls, then close it to settle actual usage.",
};

export async function openMeterTab(options: OpenTabOptions): Promise<OpenTab> {
  const { session, playgroundUrl, network, ceilingStroops, onStep = () => {}, fetchImpl = fetch } = options;
  const emit = (phase: MeterOpenPhase) => onStep({ phase, message: MESSAGES[phase] });

  const instrumented: typeof fetch = async (input, init) => {
    // `@x402/fetch` sends the paid retry as a Request object (from a different bundle realm, so
    // `instanceof Request` is unreliable) carrying PAYMENT-SIGNATURE on its own headers, not in
    // `init.headers` — duck-type on `headers.get` and inspect both.
    const inputHeaders = (input as { headers?: { get?: (n: string) => string | null } }).headers;
    const signed =
      (inputHeaders && typeof inputHeaders.get === "function" && !!inputHeaders.get("PAYMENT-SIGNATURE")) ||
      new Headers(init?.headers).has("PAYMENT-SIGNATURE");
    if (!signed) {
      const res = await fetchImpl(input, init);
      if (res.status === 402) {
        emit("challenged");
        emit("authorizing");
      }
      return res;
    }
    emit("authorized");
    return fetchImpl(input, init);
  };

  const signer = createEd25519Signer(session.secret, network as `${string}:${string}`);
  // A selector that clamps the authorized ceiling to what the user chose, applied to the challenge
  // before anything is signed. Its signature is `(x402Version, requirements[]) => chosen`, matching
  // the stock client's `paymentRequirementsSelector`, and it is a constructor argument (a post-hoc
  // assignment is ignored). Without it the buyer would sign the seller's advertised default.
  const selector =
    ceilingStroops === undefined
      ? undefined
      : (_x402Version: number, accepts: ReadonlyArray<{ amount: string }>) => ({
          ...accepts[0],
          amount: ceilingStroops,
        });
  const client = new x402Client(selector as ConstructorParameters<typeof x402Client>[0]);
  client.register("stellar:*", new UptoStellarClientScheme(signer));
  const paidFetch = wrapFetchWithPayment(instrumented, client);

  const res = await paidFetch(`${playgroundUrl}/demo/meter/open`, { method: "POST" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { reason?: string };
    throw new Error(body.reason ?? `Opening the tab failed (${res.status}).`);
  }
  const tab = (await res.json()) as {
    tabId: string;
    ceiling: string;
    unitCost: string;
    payer?: string;
    expiresInSeconds: number;
  };
  emit("opened");
  return {
    tabId: tab.tabId,
    ceilingStroops: tab.ceiling,
    unitStroops: tab.unitCost,
    payer: tab.payer,
    expiresInSeconds: tab.expiresInSeconds,
  };
}

/** Accrue one unit of usage. Refuses (throws with the coded reason) once the ceiling is reached. */
export async function callMeter(
  playgroundUrl: string,
  tabId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MeterCall> {
  const res = await fetchImpl(`${playgroundUrl}/demo/meter/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tabId }),
  });
  const body = (await res.json()) as Record<string, string> & { reason?: string };
  if (!res.ok) throw new Error(body.reason ?? `Call failed (${res.status}).`);
  return {
    call: Number(body["call"]),
    digest: body["digest"] ?? "",
    unitStroops: body["unitCost"] ?? "0",
    usedStroops: body["used"] ?? "0",
    remainingStroops: body["remaining"] ?? "0",
  };
}

/** Settle actual usage. The unspent ceiling is the amount that never left the wallet. */
export async function closeMeter(
  playgroundUrl: string,
  tabId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MeterClose> {
  const res = await fetchImpl(`${playgroundUrl}/demo/meter/close`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tabId }),
  });
  const body = (await res.json()) as Record<string, string> & { reason?: string; transaction?: string };
  if (!res.ok) throw new Error(body.reason ?? `Close failed (${res.status}).`);
  return {
    transaction: body.transaction,
    explorerUrl: body.transaction ? txUrl(body.transaction) : undefined,
    settledStroops: body["settled"] ?? "0",
    ceilingStroops: body["ceiling"] ?? "0",
    unspentStroops: body["unspent"] ?? "0",
    calls: Number(body["calls"] ?? 0),
  };
}
