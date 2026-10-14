/**
 * Trace events of a payment, for progress output and audit logs. The union is closed and every field
 * is enumerated: there is no field that could carry XDR, signatures, headers or payment payloads.
 * Amounts are base units as decimal strings.
 */
export type PaymentEvent =
  | { readonly type: "probe"; readonly callId: string; readonly resource: string }
  | { readonly type: "quote"; readonly callId: string; readonly options: number; readonly acceptable: number }
  | { readonly type: "refused"; readonly callId: string | undefined; readonly code: string }
  | {
      readonly type: "reserved";
      readonly callId: string;
      readonly reservation: string;
      readonly asset: string;
      readonly amount: string;
    }
  | {
      readonly type: "signed";
      readonly callId: string;
      readonly reservation: string;
      readonly nonce: string;
      readonly expirationLedger: number;
    }
  | { readonly type: "sent"; readonly callId: string; readonly reservation: string }
  | {
      readonly type: "settled";
      readonly callId: string;
      readonly reservation: string;
      readonly transaction: string | null;
      readonly amount: string;
    }
  | {
      readonly type: "unresolved";
      readonly callId: string;
      readonly reservation: string;
      readonly code: string;
    }
  | {
      readonly type: "released";
      readonly callId: string;
      readonly reservation: string;
      readonly reason: ReleaseReason | "settled_below_cap";
      readonly amount: string;
    }
  | {
      /** An expired payment the chain can no longer prove either way: counted as spent in full. */
      readonly type: "unprovable";
      readonly callId: string;
      readonly reservation: string;
      readonly amount: string;
    }
  | {
      readonly type: "window";
      readonly session: string;
      readonly window: string;
      readonly expiresAt: string;
    };

/**
 * Why reserved budget returned to the session:
 * - `not_signed`: refused or failed before any signature existed;
 * - `expired_unused`: the authorization expired and no transaction on chain consumed it;
 * - `claim_false`: a settlement was reported, but no transaction on chain consumed the authorization
 *   before it expired;
 * - `forced`: the operator dropped an entry that can no longer be proven either way.
 *
 * A `released` event can also carry `settled_below_cap`: an upto settlement proven on chain moved
 * less than the reserved cap, and the rest returned to the session (the reservation stays settled).
 */
export type ReleaseReason = "not_signed" | "expired_unused" | "claim_false" | "forced";

export type PaymentEventListener = (event: PaymentEvent) => void;

/** Delivers an event; a throwing listener never breaks a payment. */
export function emit(listener: PaymentEventListener | undefined, event: PaymentEvent): void {
  if (listener === undefined) return;
  try {
    listener(event);
  } catch {
    // Listeners are observers only.
  }
}
