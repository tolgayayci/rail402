import type { Keypair} from "@stellar/stellar-sdk";
import { Address, Contract, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
import { signAsAccount, submit, type SmartAccountCall } from "./smart-account.js";

/**
 * Pay from the smart account through the facilitator, the way a real buyer does: sign the auth
 * entries, POST /verify, then POST /settle. A faithful port of the canary's `payThroughFacilitator`
 * (`packages/canary/src/oz-account.ts`).
 */

export type PayResult =
  | { ok: true; transaction: string }
  | { ok: false; stage: "sign" | "verify" | "settle"; reason: string; code?: string };

async function callFacilitator(
  base: string,
  path: "/verify" | "/settle",
  paymentPayload: unknown,
  paymentRequirements: unknown,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const res = await fetchImpl(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements }),
  });
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

export async function payThroughFacilitator(args: {
  readonly server: rpc.Server;
  readonly facilitatorUrl: string;
  readonly call: SmartAccountCall;
  readonly accepted: Record<string, unknown>;
  readonly requirements: Record<string, unknown>;
  readonly settleRequirements?: Record<string, unknown>;
  readonly extraPayload?: Record<string, unknown>;
  readonly fetchImpl?: typeof fetch;
}): Promise<PayResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const built = await signAsAccount(args.server, args.call);
  if (!built.ok) return { ok: false, stage: "sign", reason: built.error };

  const paymentPayload = {
    x402Version: 2,
    accepted: args.accepted,
    payload: { transaction: built.xdr, ...(args.extraPayload ?? {}) },
  };

  const vb = (await callFacilitator(args.facilitatorUrl, "/verify", paymentPayload, args.requirements, fetchImpl)) as {
    isValid?: boolean;
    invalidReason?: string;
    invalidMessage?: string;
  };
  if (!vb.isValid) {
    return {
      ok: false,
      stage: "verify",
      reason: vb.invalidMessage ?? "verification failed",
      ...(vb.invalidReason ? { code: vb.invalidReason } : {}),
    };
  }

  const sb = (await callFacilitator(
    args.facilitatorUrl,
    "/settle",
    paymentPayload,
    args.settleRequirements ?? args.requirements,
    fetchImpl,
  )) as { success?: boolean; transaction?: string; errorReason?: string; errorMessage?: string };
  if (!sb.success) {
    return {
      ok: false,
      stage: "settle",
      reason: sb.errorMessage ?? "settlement failed",
      ...(sb.errorReason ? { code: sb.errorReason } : {}),
    };
  }
  return { ok: true, transaction: sb.transaction! };
}

/**
 * Fund the agent's contract account with USDC by transferring it from a G-account holding USDC
 * (the dispenser) through the USDC SAC. Submitted directly, not through the facilitator: this is
 * the operator topping up the demo agent, not an x402 payment. A C-account holds SAC balance in
 * contract storage — no trustline required.
 */
export async function fundContractWithUsdc(args: {
  readonly server: rpc.Server;
  readonly funder: Keypair;
  readonly usdcSac: string;
  readonly account: string;
  readonly amountStroops: bigint;
}): Promise<void> {
  const res = await submit(
    args.server,
    args.funder,
    new Contract(args.usdcSac).call(
      "transfer",
      new Address(args.funder.publicKey()).toScVal(),
      new Address(args.account).toScVal(),
      nativeToScVal(args.amountStroops.toString(), { type: "i128" }),
    ),
  );
  if (res.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error("Funding the agent account with USDC failed.");
  }
}

/** Build an exact-scheme SAC transfer call from the smart account to a seller. */
export function exactTransferOp(usdcSac: string, account: string, payTo: string, amount: bigint): xdr.Operation {
  return new Contract(usdcSac).call(
    "transfer",
    new Address(account).toScVal(),
    new Address(payTo).toScVal(),
    nativeToScVal(amount.toString(), { type: "i128" }),
  );
}

/** Build an upto-scheme settle call from the smart account, with the policy as the settlement hook. */
export function uptoSettleOp(args: {
  uptoContract: string;
  usdcSac: string;
  account: string;
  payTo: string;
  ceiling: bigint;
  expirationLedger: number;
  nonce: Buffer;
  policy: string;
}): xdr.Operation {
  return new Contract(args.uptoContract).call(
    "settle",
    new Address(args.usdcSac).toScVal(),
    new Address(args.account).toScVal(),
    new Address(args.payTo).toScVal(),
    nativeToScVal(args.ceiling.toString(), { type: "i128" }),
    nativeToScVal(args.expirationLedger, { type: "u32" }),
    xdr.ScVal.scvBytes(args.nonce),
    // Signed with the ceiling; the facilitator substitutes the metered amount at settle.
    nativeToScVal(args.ceiling.toString(), { type: "i128" }),
    // hook: our spending policy, so the settlement contract calls release() to reconcile.
    new Address(args.policy).toScVal(),
  );
}
