import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { createEd25519Signer, ExactStellarScheme } from "@x402/stellar";
import { decodePaymentRequiredHeader, decodePaymentSignatureHeader, decodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequired, PaymentPayload } from "@x402/core/types";
import { txUrl } from "./format.js";
import type { Session } from "./session.js";

/**
 * The glass payment: a real `exact` micropayment made with the UNMODIFIED stock client
 * (`@x402/fetch` + `x402Client` + `ExactStellarScheme`), instrumented so the UI can render the
 * five-step timeline the design's first scene is built around.
 *
 * We do not reimplement the payment — we watch it. The fetch handed to `wrapFetchWithPayment` is
 * wrapped so each seller round-trip announces itself; the intermediate Soroban simulation happens
 * inside the scheme over its own RPC client (not this fetch), so the ~2.7s it takes is narrated as
 * the single "authorizing" phase rather than shown call-by-call.
 */

export type PaymentPhase =
  | "requesting"
  | "challenged"
  | "authorizing"
  | "authorized"
  | "settling"
  | "settled"
  | "refused";

export interface PaymentStep {
  readonly phase: PaymentPhase;
  readonly message: string;
  /** The decoded 402 challenge (present from "challenged" on). */
  readonly challenge?: PaymentRequired;
  /** What the wallet signed — the payment payload (present from "authorized" on). */
  readonly authorization?: PaymentPayload;
  /** The settled transaction hash and its explorer link (present on "settled"). */
  readonly settlement?: { transaction: string; explorerUrl: string };
  /** A coded refusal (present on "refused"). */
  readonly error?: { code?: string; reason: string };
}

export interface PayExactResult {
  readonly ok: boolean;
  /** The resource body the paid call returned (present when ok). */
  readonly body?: unknown;
  /** The settled transaction hash (present when ok). */
  readonly transaction?: string;
  readonly steps: readonly PaymentStep[];
}

export interface PayExactOptions {
  readonly session: Session;
  readonly url: string;
  readonly network: string;
  readonly method?: string;
  readonly onStep?: (step: PaymentStep) => void;
  /** Injectable for tests; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
}

const MESSAGES: Record<PaymentPhase, string> = {
  requesting: "Calling the API with no payment, to see what it costs.",
  challenged: "The server answered 402 Payment Required and quoted its price.",
  authorizing: "Signing a payment authorization: this exact amount, this recipient, expiring in ~60s.",
  authorized: "Authorization signed. Nothing can be charged beyond what was signed.",
  settling: "The facilitator is verifying the signature and settling on Stellar.",
  settled: "Settled on-chain. The API returned its data; the seller was paid.",
  refused: "The payment was refused — with a machine-readable reason.",
};

export async function payExact(options: PayExactOptions): Promise<PayExactResult> {
  const { session, url, network, method = "GET", onStep = () => {}, fetchImpl = fetch } = options;
  const steps: PaymentStep[] = [];
  const record = (step: PaymentStep) => {
    steps.push(step);
    onStep(step);
  };
  const emit = (phase: PaymentPhase, extra: Omit<PaymentStep, "phase" | "message"> = {}) =>
    record({ phase, message: MESSAGES[phase], ...extra });

  let challenge: PaymentRequired | undefined;
  let authorization: PaymentPayload | undefined;
  let sawPaidRequest = false;

  const instrumented: typeof fetch = async (input, init) => {
    // `@x402/fetch` sends the paid retry as a Request OBJECT (first arg) carrying PAYMENT-SIGNATURE
    // on its own headers, not in `init.headers` — so both must be inspected.
    const signature = requestHeader(input, init, "PAYMENT-SIGNATURE");

    if (!signature) {
      emit("requesting");
      const res = await fetchImpl(input, init);
      if (res.status === 402) {
        challenge = readChallenge(res);
        emit("challenged", challenge ? { challenge } : {});
        emit("authorizing", challenge ? { challenge } : {});
      }
      return res;
    }

    // The paid retry. Decode what is about to be sent, then watch it settle.
    sawPaidRequest = true;
    authorization = decodeAuthorization(signature);
    emit("authorized", authorization ? { authorization } : {});
    emit("settling", authorization ? { authorization } : {});
    return fetchImpl(input, init);
  };

  const signer = createEd25519Signer(session.secret, network as `${string}:${string}`);
  const client = new x402Client();
  client.register("stellar:*", new ExactStellarScheme(signer));
  const paidFetch = wrapFetchWithPayment(instrumented, client);

  try {
    const response = await paidFetch(url, { method });
    if (!response.ok) {
      const err = await readError(response);
      emit("refused", { error: err });
      return { ok: false, steps };
    }
    const settlement = readSettlement(response);
    if (settlement) {
      emit("settled", {
        settlement: { transaction: settlement, explorerUrl: txUrl(settlement) },
        ...(authorization ? { authorization } : {}),
      });
    }
    const body = await response.json().catch(() => undefined);
    return {
      ok: true,
      body,
      ...(settlement ? { transaction: settlement } : {}),
      steps,
    };
  } catch (err) {
    // `@x402/fetch` destroys the underlying error (loses class and cause), so only the message
    // survives the wrapper boundary. Surface it as a refusal rather than letting it escape untyped.
    const reason = err instanceof Error ? err.message : String(err);
    emit("refused", {
      error: { reason: sawPaidRequest ? reason : `Could not complete the payment: ${reason}` },
    });
    return { ok: false, steps };
  }
}

/**
 * Read a request header from either a Request-object input or an init.headers bag.
 *
 * Duck-typed on `headers.get` rather than `input instanceof Request`: `@x402/fetch` hands the paid
 * request as a Request built by a DIFFERENT bundle realm, so `instanceof` against our global
 * `Request` returns false for it (verified — the probe matched, the paid retry did not).
 */
function requestHeader(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  name: string,
): string | undefined {
  const headers = (input as { headers?: { get?: (n: string) => string | null } }).headers;
  if (headers && typeof headers.get === "function") {
    const value = headers.get(name);
    if (value) return value;
  }
  return new Headers(init?.headers).get(name) ?? undefined;
}

function readChallenge(res: Response): PaymentRequired | undefined {
  const header = res.headers.get("PAYMENT-REQUIRED");
  if (!header) return undefined;
  try {
    return decodePaymentRequiredHeader(header) as PaymentRequired;
  } catch {
    return undefined;
  }
}

function decodeAuthorization(header: string): PaymentPayload | undefined {
  try {
    return decodePaymentSignatureHeader(header) as PaymentPayload;
  } catch {
    return undefined;
  }
}

function readSettlement(res: Response): string | undefined {
  const header = res.headers.get("PAYMENT-RESPONSE");
  if (!header) return undefined;
  try {
    const decoded = decodePaymentResponseHeader(header) as { transaction?: string };
    return decoded.transaction;
  } catch {
    return undefined;
  }
}

async function readError(res: Response): Promise<{ code?: string; reason: string }> {
  const body = (await res.json().catch(() => null)) as
    | { code?: string; reason?: string; error?: string }
    | null;
  if (body?.reason) return body.code ? { code: body.code, reason: body.reason } : { reason: body.reason };
  if (body?.error) return { reason: body.error };
  return { reason: `The seller returned HTTP ${res.status}.` };
}
