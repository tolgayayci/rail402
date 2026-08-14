import {
  Asset,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

/**
 * The attack bench: real corrupted payments fired at the facilitator so the UI can show that every
 * one comes back with a machine-readable reason. Each transform is faithful to a case in the
 * canary's rejection audit (`packages/canary/src/rejection-audit.ts`) — the same corruptions, run
 * from the browser against a payment the user just made.
 *
 * A transform takes the signed payload the wallet produced (`PaymentPayload`, whose `accepted`
 * field is the requirements that were signed) and returns the request to send. Most mutate the
 * requirements and leave the correctly-signed payload untouched — the cheapest possible demo, since
 * one real payment drives them all and nothing settles.
 *
 * `runAttack` posts through the playground server's `/attack/*` proxy, which forwards verbatim to
 * the facilitator: the refusal is genuinely the facilitator's, reached same-origin so no CORS
 * configuration is required for the scene to work.
 */

const PASSPHRASE = Networks.TESTNET;

export interface AttackRequest {
  readonly x402Version: number;
  readonly paymentPayload: PaymentPayload;
  readonly paymentRequirements: PaymentRequirements;
  readonly target: "verify" | "settle";
}

export interface Attack {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** The registry codes a correct facilitator may answer with. */
  readonly expectedCodes: readonly string[];
  readonly build: (signed: PaymentPayload) => AttackRequest;
}

export interface AttackOutcome {
  /** True when the facilitator refused (the desired result — the attack failed to get through). */
  readonly refused: boolean;
  readonly code?: string;
  readonly reason: string;
  /** True when the refusal code was one the attack expected. */
  readonly asExpected: boolean;
  /** Raw facilitator response, for the inspect layer. */
  readonly raw: unknown;
}

function requirements(signed: PaymentPayload): PaymentRequirements {
  return signed.accepted;
}

/** Authorization entries carried by a signed payload's transaction. */
function decodeAuth(payload: PaymentPayload): xdr.SorobanAuthorizationEntry[] {
  const raw = (payload.payload as { transaction: string }).transaction;
  const tx = new Transaction(raw, PASSPHRASE);
  return (tx.operations[0] as Operation.InvokeHostFunction).auth ?? [];
}

/** Rebuild a payload's transaction with different authorization entries, changing nothing else. */
function withAuth(payload: PaymentPayload, auth: xdr.SorobanAuthorizationEntry[]): PaymentPayload {
  const raw = (payload.payload as { transaction: string }).transaction;
  const tx = new Transaction(raw, PASSPHRASE);
  const op = tx.operations[0] as Operation.InvokeHostFunction;
  const rebuilt = TransactionBuilder.cloneFrom(tx)
    .clearOperations()
    .addOperation(Operation.invokeHostFunction({ func: op.func, auth }))
    .build();
  return { ...payload, payload: { ...(payload.payload as object), transaction: rebuilt.toXDR() } };
}

export const ATTACKS: readonly Attack[] = [
  {
    id: "tampered-amount",
    title: "Tamper with the amount",
    description: "Ask the facilitator to settle double what the signature authorizes.",
    expectedCodes: ["invalid_exact_stellar_payload_wrong_amount"],
    build: signed => ({
      x402Version: 2,
      paymentPayload: signed,
      paymentRequirements: { ...requirements(signed), amount: (BigInt(requirements(signed).amount) * 2n).toString() },
      target: "verify",
    }),
  },
  {
    id: "wrong-recipient",
    title: "Redirect the payment",
    description: "Point the payment at a different recipient than the one signed.",
    expectedCodes: ["invalid_exact_stellar_payload_wrong_recipient"],
    build: signed => ({
      x402Version: 2,
      paymentPayload: signed,
      paymentRequirements: { ...requirements(signed), payTo: Keypair.random().publicKey() },
      target: "verify",
    }),
  },
  {
    id: "wrong-asset",
    title: "Swap the asset",
    description: "Claim the payment is in a different token than the one signed.",
    expectedCodes: ["invalid_exact_stellar_payload_wrong_asset"],
    build: signed => {
      const other = new Asset("OTHERX", Keypair.random().publicKey()).contractId(PASSPHRASE);
      return {
        x402Version: 2,
        paymentPayload: signed,
        paymentRequirements: { ...requirements(signed), asset: other },
        target: "verify",
      };
    },
  },
  {
    id: "malformed-transaction",
    title: "Corrupt the transaction",
    description: "Replace the signed transaction with garbage that is not valid XDR.",
    expectedCodes: ["invalid_exact_stellar_payload_malformed"],
    build: signed => ({
      x402Version: 2,
      paymentPayload: { ...signed, payload: { ...(signed.payload as object), transaction: "not-base64-xdr" } },
      paymentRequirements: requirements(signed),
      target: "verify",
    }),
  },
  {
    id: "stripped-auth-entries",
    title: "Strip the signature",
    description: "Send the same transaction with the authorization entries removed entirely.",
    expectedCodes: ["invalid_exact_stellar_payload_no_auth_entries"],
    build: signed => ({
      x402Version: 2,
      paymentPayload: withAuth(signed, []),
      paymentRequirements: requirements(signed),
      target: "verify",
    }),
  },
  {
    id: "auth-entry-signature-cleared",
    title: "Blank the signature",
    description: "Keep the authorization entry and its nonce, but empty the signature — a forged payload's exact shape.",
    expectedCodes: [
      "invalid_exact_stellar_payload_missing_payer_signature",
      "invalid_exact_stellar_payload_simulation_failed",
    ],
    build: signed => ({
      x402Version: 2,
      paymentPayload: withAuth(
        signed,
        decodeAuth(signed).map(entry => {
          const copy = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR());
          if (copy.credentials().switch() === xdr.SorobanCredentialsType.sorobanCredentialsAddress()) {
            copy.credentials().address().signature(xdr.ScVal.scvVec([]));
          }
          return copy;
        }),
      ),
      paymentRequirements: requirements(signed),
      target: "verify",
    }),
  },
  {
    id: "unserved-network",
    title: "Ask for the wrong network",
    description: "Claim the payment is on an EVM network this facilitator does not serve.",
    expectedCodes: ["invalid_network"],
    build: signed => ({
      x402Version: 2,
      paymentPayload: signed,
      paymentRequirements: { ...requirements(signed), network: "eip155:8453" as PaymentRequirements["network"] },
      target: "verify",
    }),
  },
  {
    id: "unsupported-scheme",
    title: "Ask for an unknown scheme",
    description: "Request a settlement scheme the facilitator does not implement.",
    expectedCodes: ["unsupported_scheme", "invalid_scheme"],
    build: signed => ({
      x402Version: 2,
      paymentPayload: signed,
      paymentRequirements: { ...requirements(signed), scheme: "handshake" },
      target: "verify",
    }),
  },
  {
    id: "replay",
    title: "Replay the payment",
    description: "Submit the exact payment a second time. Only meaningful after it has already settled.",
    expectedCodes: ["invalid_exact_stellar_payload_authorization_replayed"],
    build: signed => ({
      x402Version: 2,
      paymentPayload: signed,
      paymentRequirements: requirements(signed),
      target: "settle",
    }),
  },
];

/** Fire one attack through the playground's attack proxy and read the coded refusal. */
export async function runAttack(
  playgroundUrl: string,
  attack: Attack,
  signed: PaymentPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<AttackOutcome> {
  const request = attack.build(signed);
  const res = await fetchImpl(`${playgroundUrl}/attack/${request.target}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      x402Version: request.x402Version,
      paymentPayload: request.paymentPayload,
      paymentRequirements: request.paymentRequirements,
    }),
  });
  const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  // Both verify and settle report refusal in their own shape; normalise to a single verdict.
  const isValid = raw["isValid"] === true;
  const success = raw["success"] === true;
  const refused = request.target === "verify" ? !isValid : !success;

  const code =
    (raw["invalidReason"] as string | undefined) ??
    (raw["errorReason"] as string | undefined) ??
    (raw["code"] as string | undefined);
  const reason =
    (raw["invalidMessage"] as string | undefined) ??
    (raw["errorMessage"] as string | undefined) ??
    (raw["reason"] as string | undefined) ??
    (refused ? "Refused without a message." : "The attack was NOT refused — investigate.");

  return {
    refused,
    ...(code ? { code } : {}),
    reason,
    asExpected: refused && code !== undefined && attack.expectedCodes.includes(code),
    raw,
  };
}
