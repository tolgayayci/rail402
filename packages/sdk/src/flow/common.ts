import { hash as sha256, rpc } from "@stellar/stellar-sdk";
import { x402Client } from "@x402/core/client";
import { parsePaymentRequired } from "@x402/core/schemas";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { appendPaymentIdentifierToExtensions } from "@x402/extensions/payment-identifier";
import { isEgressError, type SafeFetch } from "@rail402.dev/safe-fetch/shared";
import type { AccountFunds, StellarNetwork } from "@rail402.dev/stellar";
import { fromUtf8, toBase64Url } from "../bytes.ts";
import { isPaymentError, paymentError, type Paid, type PaymentError } from "../codes.ts";
import { emit, type PaymentEventListener } from "../events.ts";
import { explorerUrl, type ExplorerProvider } from "../explorer.ts";
import type { Sep43AuthSigner } from "../keys.ts";
import { parseAtomic, toDecimal } from "../money.ts";
import { budgetSnapshot, remainingBudget, type BudgetSnapshot } from "../policy/budget.ts";
import { selectOption, type ListingBinding, type Selection } from "../policy/decide.ts";
import {
  GUARD_LEDGER_MAX_AGE_MS,
  checkGuardedPayload,
  createGuardedSigner,
  type GuardedAuthorization,
  type LedgerClock,
} from "../policy/guard.ts";
import {
  idempotencyConflict,
  keyReusable,
  type Reservation,
  type SpendLedger,
  type WindowSpec,
} from "../policy/ledger.ts";
import {
  effectiveCap,
  policyAsset,
  type EffectiveCap,
  type PolicyAsset,
  type ResolvedPolicy,
  type SchemeName,
} from "../policy/policy.ts";
import { reconcile, type ChainReader } from "../policy/reconcile.ts";
import { redact } from "../redact.ts";
import type { StellarSchemeAdapter } from "../schemes/adapter.ts";
import type { Receipt } from "./receipt.ts";
import type { CallResult, PayOptions } from "./types.ts";

/** What the payment flows read from the network. */
export interface FlowChain {
  getTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse>;
  funds(asset: string, account: string): Promise<AccountFunds | undefined>;
  receivable(asset: string, payTo: string): Promise<boolean | undefined>;
  /** For settling or releasing earlier payments from on-chain proof. */
  readonly reader: ChainReader;
}

/** Everything a payment flow needs from its buyer. */
export interface FlowContext {
  readonly network: StellarNetwork;
  readonly policy: ResolvedPolicy;
  readonly adapters: readonly StellarSchemeAdapter[];
  readonly signer: Sep43AuthSigner | undefined;
  readonly ledger: SpendLedger;
  readonly spec: WindowSpec | undefined;
  readonly clock: LedgerClock;
  readonly rpcUrl: string;
  readonly chain: FlowChain;
  readonly explorer: ExplorerProvider;
  readonly verify: "sync" | "async" | "off";
  /** Pause between on-chain receipt checks. */
  readonly verifyDelayMs: number;
  readonly onEvent: PaymentEventListener | undefined;
  /** Seller requests of the HTTP flow (probes and paid calls); its policy bounds what is sent. */
  readonly fetch: SafeFetch;
  /** A fetch for one MCP session, closed when the session ends. */
  openSession(): SafeFetch;
}

/** One paid call, before anything is sent. */
export interface CallPlan {
  readonly callId: string;
  readonly signer: Sep43AuthSigner;
  readonly spec: WindowSpec;
  readonly cap: EffectiveCap;
  readonly idempotencyKey: string | undefined;
  readonly signal: AbortSignal | undefined;
  readonly preferredScheme: SchemeName | undefined;
  readonly listing: ListingBinding | undefined;
  /** Whether a listed option's recipient can receive its asset, from the listing's facts. */
  readonly listedReceivable: ((option: PaymentRequirements) => boolean | undefined) | undefined;
  /** For the operator's records: the URL, or the MCP endpoint and tool. */
  readonly resource: string;
}

/** A payment the guard signed, ready to send. */
export interface SignedPayment {
  readonly payload: PaymentPayload;
  readonly authorization: GuardedAuthorization;
  readonly option: PaymentRequirements;
  readonly asset: PolicyAsset;
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;
const HASH = /^[0-9a-f]{64}$/;
/** Largest PAYMENT-REQUIRED value accepted (the header is base64 JSON). */
export const MAX_PAYMENT_REQUIRED_BYTES = 65_536;
export const VERIFY_ATTEMPTS = 3;

/** Checks what a paid call needs before anything is fetched: a signer, a valid cap and key. */
export function planCall(
  context: FlowContext,
  options: PayOptions,
  resource: string,
  listing?: { readonly binding: ListingBinding; readonly receivable?: CallPlan["listedReceivable"] },
): CallPlan {
  if (context.signer === undefined || context.spec === undefined) {
    throw paymentError("payment_signer_unavailable");
  }
  const raw: unknown = options;
  if (typeof raw !== "object" || raw === null) throw paymentError("payment_cap_required");
  const cap = effectiveCap(context.policy, options.maxAmount);
  const key = options.idempotencyKey;
  if (key !== undefined && (typeof key !== "string" || !IDEMPOTENCY_KEY.test(key))) {
    throw paymentError("payment_request_invalid", {
      reason: "An idempotency key is 8-128 letters, digits, dashes or underscores.",
    });
  }
  const scheme: unknown = options.scheme;
  if (scheme !== undefined && scheme !== "exact" && scheme !== "upto") {
    throw paymentError("payment_scheme_not_permitted", { reason: "The scheme is exact or upto." });
  }
  options.signal?.throwIfAborted();
  return {
    callId: crypto.randomUUID(),
    signer: context.signer,
    spec: context.spec,
    cap,
    idempotencyKey: key,
    signal: options.signal,
    preferredScheme: options.scheme,
    listing: listing?.binding,
    listedReceivable: listing?.receivable,
    resource,
  };
}

/** Rows reconciliation checks on chain before a payment: bounded, so paying never waits long. */
export const RECONCILE_BEFORE_PAYING = 5;

/**
 * Settles or releases a few earlier payments from on-chain proof before reserving budget for a new
 * one, so expired unused authorizations return to the session. A failure never blocks the payment:
 * unproven rows simply stay pending.
 */
export async function reconcileBeforePaying(context: FlowContext, plan: CallPlan): Promise<void> {
  try {
    await reconcile(context.ledger, context.chain.reader, {
      network: context.network,
      payer: plan.signer.address,
      maxAuthorizationSeconds: context.policy.maxAuthorizationSeconds,
      limit: RECONCILE_BEFORE_PAYING,
      onEvent: context.onEvent,
    });
  } catch {
    // Reconciliation is retried before the next payment.
  }
}

/** The stored form of a finished call, kept under its idempotency key. */
type StoredOutcome =
  | { readonly v: 1; readonly ok: true; readonly result: Omit<CallResult, "budget" | "replayed"> }
  | {
      readonly v: 1;
      readonly ok: false;
      readonly error: {
        readonly code: string;
        readonly reason: string;
        readonly paid: Paid;
        readonly details?: Readonly<Record<string, unknown>> | undefined;
      };
      readonly receipt?: Receipt | undefined;
      readonly callId: string;
    };

/**
 * The stored outcome of an earlier call with this idempotency key, if any: a result is returned with
 * `replayed: true`, a failure is raised again. A retry first reconciles the key's own payment when its
 * outcome is still open, and the reservation's state then wins over a stale stored failure: once the
 * chain shows the payment settled, the replay says so (paying again would pay twice); once it shows
 * the authorization expired unused, the key is free for a new call. A call that is still running, or
 * whose payment the chain has not resolved yet, is `payment_in_progress` or its stored failure. A key
 * names one call: reusing it for another resource is refused, never answered with the other call's
 * outcome.
 */
export async function replayStored(context: FlowContext, plan: CallPlan): Promise<CallResult | undefined> {
  const key = plan.idempotencyKey;
  if (key === undefined) return undefined;
  const window = context.ledger.window(plan.spec);
  let existing = context.ledger.findByIdempotencyKey(window.id, key);
  if (existing === undefined || keyReusable(existing)) return undefined;
  if (awaitsProof(existing)) {
    await reconcileRow(context, plan, existing.id);
    existing = context.ledger.get(existing.id) ?? existing;
    if (keyReusable(existing)) return undefined;
  }
  if (existing.resource !== plan.resource) {
    throw paymentError("payment_request_invalid", {
      reason:
        "This idempotency key was already used in this budget window for a call to another resource; a key names one call, so use a new key for this one.",
      callId: plan.callId,
    });
  }
  let stored: StoredOutcome | undefined;
  try {
    stored = existing.result === undefined ? undefined : (JSON.parse(existing.result) as StoredOutcome);
  } catch {
    stored = undefined;
  }
  if (stored?.ok === true) return { ...stored.result, budget: snapshot(context), replayed: true };
  if (existing.unprovable) {
    throw paymentError("payment_settlement_unconfirmed", {
      reason:
        "An earlier call with this idempotency key sent a payment whose outcome the RPC can no longer prove; it is counted as spent. Use a new idempotency key to pay again.",
      paid: "unknown",
      callId: existing.callId,
    });
  }
  if (existing.state === "settled" && stored?.error.paid !== "settled") {
    throw paymentError("payment_resource_failed", {
      reason:
        "An earlier call with this idempotency key paid, but its response was not received; paying again would pay twice.",
      paid: "settled",
      callId: existing.callId,
      receipt: settledReceipt(context, existing, plan.signer.address),
    });
  }
  if (stored === undefined) throw idempotencyConflict(existing);
  throw paymentError(stored.error.code as PaymentError["code"], {
    reason: stored.error.reason,
    paid: stored.error.paid,
    details: stored.error.details,
    callId: stored.callId,
    receipt: stored.receipt,
  });
}

/** Whether a reservation's payment was signed and its outcome is not proven on chain yet. */
function awaitsProof(row: Reservation): boolean {
  if (row.state === "settled") return !row.verified && !row.unprovable;
  return row.state === "signed" || row.state === "transmitted" || row.state === "unresolved";
}

/** Reconciles one reservation from the chain; a failure leaves it as it was. */
async function reconcileRow(context: FlowContext, plan: CallPlan, id: string): Promise<void> {
  try {
    await reconcile(context.ledger, context.chain.reader, {
      network: context.network,
      payer: plan.signer.address,
      maxAuthorizationSeconds: context.policy.maxAuthorizationSeconds,
      only: id,
      onEvent: context.onEvent,
    });
  } catch {
    // The stored outcome is replayed; the next retry checks again.
  }
}

/** The receipt of a reservation the ledger holds as settled, for a replay after the fact. */
function settledReceipt(context: FlowContext, row: Reservation, payer: string): Receipt | undefined {
  const asset = policyAsset(context.policy, row.asset);
  if (asset === undefined) return undefined;
  const amount = (atomic: bigint) => ({
    amount: toDecimal(atomic, asset.decimals),
    atomic: atomic.toString(),
  });
  const transaction = row.transaction ?? null;
  return {
    status: "settled",
    scheme: row.scheme,
    network: context.network,
    asset: asset.symbol,
    assetContract: asset.contract,
    decimals: asset.decimals,
    authorized: amount(row.amount),
    settled: row.settledAmount === undefined ? null : amount(row.settledAmount),
    payTo: row.payTo,
    payer,
    transaction,
    explorerUrl: transaction === null ? null : explorerUrl(context.network, transaction, context.explorer),
    verifiedOnChain: row.verified,
  };
}

/** Keeps a finished call's sanitized outcome for idempotent replays. Never payloads or signatures. */
export function storeOutcome(
  context: FlowContext,
  signed: SignedPayment,
  outcome: { readonly result: CallResult } | { readonly error: PaymentError },
): void {
  const stored: StoredOutcome =
    "result" in outcome
      ? {
          v: 1,
          ok: true,
          result: {
            callId: outcome.result.callId,
            paid: outcome.result.paid,
            payment: outcome.result.payment,
            response: outcome.result.response,
          },
        }
      : {
          v: 1,
          ok: false,
          error: {
            code: outcome.error.code,
            reason: outcome.error.reason,
            paid: outcome.error.paid,
            details: outcome.error.details,
          },
          receipt: outcome.error.receipt,
          callId: outcome.error.callId ?? signed.authorization.callId,
        };
  try {
    context.ledger.storeResult(signed.authorization.reservationId, JSON.stringify(stored));
  } catch {
    // The outcome still reaches the caller; a replay then answers payment_in_progress until the
    // chain resolves the payment.
  }
}

/** Validates payment requirements from a seller: x402 version 2 with at least one option. */
export function parseRequired(value: unknown): PaymentRequired {
  const parsed = parsePaymentRequired(value);
  if (!parsed.success) {
    throw paymentError("payment_requirements_invalid", {
      reason: "The seller's payment requirements do not match the x402 schema.",
    });
  }
  const required = parsed.data as unknown as PaymentRequired;
  if (required.x402Version !== 2) {
    throw paymentError("payment_requirements_invalid", {
      reason: `The seller asked for x402 version ${String(required.x402Version)}; only version 2 is paid.`,
    });
  }
  if (required.accepts.length === 0) {
    throw paymentError("payment_requirements_invalid", { reason: "The seller offered no payment option." });
  }
  return required;
}

/** Picks the option to pay under the policy and the call's cap (`selectOption`). */
export function chooseOption(context: FlowContext, plan: CallPlan, required: PaymentRequired): Selection {
  try {
    const selection = selectOption(required.accepts, {
      network: context.network,
      policy: context.policy,
      adapters: context.adapters,
      payer: plan.signer.address,
      cap: plan.cap,
      preferredScheme: plan.preferredScheme,
      listing: plan.listing,
      remaining: (asset) => remainingBudget(context.ledger, plan.spec, asset),
    });
    emit(context.onEvent, {
      type: "quote",
      callId: plan.callId,
      options: required.accepts.length,
      acceptable: selection.verdicts.filter((verdict) => verdict.refused === undefined).length,
    });
    return selection;
  } catch (error) {
    const refusal = isPaymentError(error)
      ? error
      : paymentError("payment_requirements_invalid", {
          reason: `The seller's payment options could not be judged: ${upstreamMessage(error)}`,
        });
    emit(context.onEvent, { type: "refused", callId: plan.callId, code: refusal.code });
    throw withCallId(refusal, plan.callId);
  }
}

/**
 * Checks, before anything is simulated or signed, that the payer holds the asset and that the
 * recipient can receive it. Undecidable cases (contract accounts, custom tokens) proceed.
 */
export async function preflightFunds(
  context: FlowContext,
  plan: CallPlan,
  chosen: Selection["chosen"],
): Promise<void> {
  const { option, reserve } = chosen;
  const asset = policyAsset(context.policy, option.asset);
  const symbol = asset?.symbol ?? option.asset;
  let funds: AccountFunds | undefined;
  let receivable: boolean | undefined;
  try {
    funds = await context.chain.funds(option.asset, plan.signer.address);
    receivable =
      plan.listedReceivable?.(option) ?? (await context.chain.receivable(option.asset, option.payTo));
  } catch {
    throw paymentError("rpc_unavailable", {
      reason: "The payer's balance could not be read from the Stellar RPC.",
      callId: plan.callId,
    });
  }
  const refuse = (code: PaymentError["code"], reason: string) => {
    emit(context.onEvent, { type: "refused", callId: plan.callId, code });
    return paymentError(code, { reason, callId: plan.callId });
  };
  if (funds !== undefined) {
    if (!funds.trustline) {
      throw refuse("payment_payer_trustline_missing", `The payer has no trustline for ${symbol}.`);
    }
    if (!funds.authorized) {
      throw refuse(
        "payment_payer_trustline_missing",
        `The payer's ${symbol} trustline is not authorized by the issuer.`,
      );
    }
    if (funds.available < reserve) {
      const decimals = asset?.decimals;
      const held =
        decimals === undefined
          ? ""
          : funds.available === funds.balance
            ? `The payer holds ${toDecimal(funds.balance, decimals)} ${symbol}`
            : `The payer holds ${toDecimal(funds.balance, decimals)} ${symbol}, of which ${toDecimal(funds.available, decimals)} is available (open offers and reserves are held back)`;
      throw refuse(
        "payment_insufficient_funds",
        decimals === undefined
          ? "The payer's available balance is lower than the price."
          : `${held}; the price is ${toDecimal(reserve, decimals)}.`,
      );
    }
  }
  if (receivable === false) {
    throw refuse("payment_recipient_cannot_receive", `The recipient cannot receive ${symbol}.`);
  }
}

/**
 * Signs the chosen option through a guard armed with exactly that option, using the unmodified
 * upstream scheme client, then checks the produced payload against what was signed. A failure after
 * a signature exists leaves its budget pending until the chain proves the authorization unused.
 */
export async function signPayment(
  context: FlowContext,
  plan: CallPlan,
  required: PaymentRequired,
  chosen: Selection["chosen"],
): Promise<SignedPayment> {
  const { option, adapter, reserve } = chosen;
  const asset = policyAsset(context.policy, option.asset);
  if (asset === undefined) throw paymentError("payment_asset_not_permitted", { callId: plan.callId });
  plan.signal?.throwIfAborted();

  const guard = createGuardedSigner(plan.signer, {
    network: context.network,
    policy: context.policy,
    adapters: context.adapters,
    ledger: context.ledger,
    window: plan.spec,
    clock: context.clock,
    expectation: {
      scheme: adapter.scheme,
      network: context.network,
      asset: option.asset,
      payTo: option.payTo,
      amount: reserve,
      maxTimeoutSeconds: option.maxTimeoutSeconds,
      effectiveCap: plan.cap.cap,
      facilitator: adapter.settlementAuthority?.(option),
    },
    callId: plan.callId,
    resource: plan.resource,
    idempotencyKey: plan.idempotencyKey,
    onEvent: context.onEvent,
  });
  const client = new x402Client()
    .register(
      context.network,
      adapter.createClient(guard, {
        url: context.rpcUrl,
        latestLedger: () => context.clock.read(GUARD_LEDGER_MAX_AGE_MS),
      }),
    )
    .setSpendControls({
      allowedAssets: [
        { network: context.network, asset: option.asset, maxAmountPerPayment: plan.cap.cap.toString() },
      ],
    });

  // The seller's object is never modified: the identifier is appended to a copy (it mutates in place).
  const request: PaymentRequired = { ...structuredClone(required), accepts: [structuredClone(option)] };
  if (plan.idempotencyKey !== undefined && request.extensions !== undefined) {
    const window = context.ledger.window(plan.spec);
    appendPaymentIdentifierToExtensions(
      request.extensions,
      paymentIdentifier(window.id, plan.idempotencyKey),
    );
  }

  const leavePending = () => {
    for (const authorization of guard.authorizations) {
      if (context.ledger.markUnresolved(authorization.reservationId)) {
        emit(context.onEvent, {
          type: "unresolved",
          callId: plan.callId,
          reservation: authorization.reservationId,
          code: "payment_simulation_failed",
        });
      }
    }
  };

  let payload: PaymentPayload;
  try {
    payload = await client.createPaymentPayload(request);
  } catch (error) {
    leavePending();
    if (guard.failure !== undefined) throw withCallId(guard.failure, plan.callId);
    if (isPaymentError(error)) throw withCallId(error, plan.callId);
    emit(context.onEvent, { type: "refused", callId: plan.callId, code: "payment_simulation_failed" });
    throw paymentError("payment_simulation_failed", {
      reason: `Building the payment failed: ${upstreamMessage(error)}`,
      callId: plan.callId,
    });
  }
  let authorization: GuardedAuthorization;
  try {
    authorization = checkGuardedPayload(guard, payload.payload);
  } catch (error) {
    leavePending();
    throw withCallId(error, plan.callId);
  }
  return { payload, authorization, option, asset };
}

/** Records that the signed payment is about to leave for the seller. */
export function markSent(context: FlowContext, signed: SignedPayment): void {
  const { reservationId, callId } = signed.authorization;
  context.ledger.markTransmitted(reservationId);
  emit(context.onEvent, { type: "sent", callId, reservation: reservationId });
}

/** Keeps a sent payment's budget pending: the outcome is unknown until the chain proves it. */
export function markUnresolved(context: FlowContext, signed: SignedPayment, code: string): void {
  const { reservationId, callId } = signed.authorization;
  let marked: boolean;
  try {
    marked = context.ledger.markUnresolved(reservationId);
  } catch {
    // The row stays signed or transmitted, which reconciliation also resolves from the chain.
    return;
  }
  if (marked) emit(context.onEvent, { type: "unresolved", callId, reservation: reservationId, code });
}

/**
 * Commits a reported settlement and builds its receipt. The claim counts as spent at once; with
 * `verify: "sync"` the transaction is also checked on chain for this authorization. A malformed hash
 * is not recorded and the payment stays pending. A reported hash only ever counts against this
 * payment: it never settles or hides another one, since every proof is bound to its own nonce.
 *
 * For upto the claim is the reported amount (at most the cap), and the rest of the cap stays pending
 * until the chain proves what moved: the settlement's own event when it is verified, or the
 * authorization's expiry with no transfer. An off-chain zero settlement (no transaction) is kept as a
 * claim of zero until the authorization expires unused.
 */
export async function settle(
  context: FlowContext,
  signed: SignedPayment,
  reported: { readonly transaction?: unknown; readonly amount?: unknown },
): Promise<Receipt> {
  const { authorization } = signed;
  const { intent, reservationId, callId } = authorization;
  const hash = typeof reported.transaction === "string" ? reported.transaction.toLowerCase() : "";
  const reportedAmount = parseAtomic(reported.amount);
  if (intent.scheme === "upto" && hash === "" && reportedAmount === 0n) {
    context.ledger.settle(reservationId, { transaction: null, settledAmount: 0n, verified: false });
    emit(context.onEvent, {
      type: "settled",
      callId,
      reservation: reservationId,
      transaction: null,
      amount: "0",
    });
    return receipt(context, signed, {
      status: "settled",
      transaction: null,
      verified: false,
      settledAmount: 0n,
    });
  }
  if (!HASH.test(hash)) {
    markUnresolved(context, signed, "payment_settlement_unconfirmed");
    return receipt(context, signed, { status: "unknown", transaction: null, verified: false });
  }
  const claimed =
    intent.scheme === "exact" || reportedAmount === undefined || reportedAmount > intent.maxAmount
      ? intent.maxAmount
      : reportedAmount;
  context.ledger.settle(reservationId, { transaction: hash, settledAmount: claimed, verified: false });
  emit(context.onEvent, {
    type: "settled",
    callId,
    reservation: reservationId,
    transaction: hash,
    amount: claimed.toString(),
  });

  let proven: bigint | undefined;
  if (context.verify === "sync") {
    proven = await verifyOnChain(context, signed, hash);
  } else if (context.verify === "async") {
    void verifyOnChain(context, signed, hash).catch(() => undefined);
  }
  return receipt(context, signed, {
    status: "settled",
    transaction: hash,
    verified: proven !== undefined,
    settledAmount: proven ?? claimed,
  });
}

/**
 * Looks the settlement up on chain: it must have succeeded and consumed this very authorization (the
 * payer's entry with its nonce), which proves the price moved, or for upto the amount its settlement
 * contract recorded, at most the cap.
 * Retries a few times while the RPC has not indexed it yet. Returns the amount the chain shows moved,
 * which then replaces the claim in the budget, or undefined when nothing was proven.
 */
export async function verifyOnChain(
  context: FlowContext,
  signed: SignedPayment,
  hash: string,
): Promise<bigint | undefined> {
  const { authorization } = signed;
  const { intent, adapter, reservationId, callId } = authorization;
  for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt++) {
    if (attempt > 0) await delay(context.verifyDelayMs);
    let transaction: rpc.Api.GetTransactionResponse;
    try {
      transaction = await context.chain.getTransaction(hash);
    } catch {
      continue;
    }
    if (transaction.status === rpc.Api.GetTransactionStatus.NOT_FOUND) continue;
    if (transaction.status !== rpc.Api.GetTransactionStatus.SUCCESS) return undefined;
    let moved: bigint | undefined;
    try {
      moved = adapter.settledAmount?.(transaction, intent);
    } catch {
      // A transaction this version cannot read is left for reconciliation.
      return undefined;
    }
    if (
      moved === undefined ||
      (intent.scheme === "exact" ? moved !== intent.maxAmount : moved < 0n || moved > intent.maxAmount)
    ) {
      return undefined;
    }
    const before = context.ledger.get(reservationId);
    if (!context.ledger.settle(reservationId, { transaction: hash, settledAmount: moved, verified: true })) {
      return undefined;
    }
    const remainder = intent.maxAmount - moved;
    if (intent.scheme === "upto" && before?.verified !== true && remainder > 0n) {
      emit(context.onEvent, {
        type: "released",
        callId,
        reservation: reservationId,
        reason: "settled_below_cap",
        amount: remainder.toString(),
      });
    }
    return moved;
  }
  return undefined;
}

/** A receipt for a payment the seller did not report on; reconciliation settles it later. */
export function unknownReceipt(context: FlowContext, signed: SignedPayment): Receipt {
  return receipt(context, signed, { status: "unknown", transaction: null, verified: false });
}

function receipt(
  context: FlowContext,
  signed: SignedPayment,
  fields: {
    readonly status: Receipt["status"];
    readonly transaction: string | null;
    readonly verified: boolean;
    readonly settledAmount?: bigint;
  },
): Receipt {
  const { intent } = signed.authorization;
  const { decimals, symbol, contract } = signed.asset;
  const amount = (atomic: bigint) => ({ amount: toDecimal(atomic, decimals), atomic: atomic.toString() });
  return {
    status: fields.status,
    scheme: intent.scheme,
    network: context.network,
    asset: symbol,
    assetContract: contract,
    decimals,
    authorized: amount(intent.maxAmount),
    settled: fields.settledAmount === undefined ? null : amount(fields.settledAmount),
    payTo: signed.option.payTo,
    payer: intent.payer,
    transaction: fields.transaction,
    explorerUrl:
      fields.transaction === null ? null : explorerUrl(context.network, fields.transaction, context.explorer),
    verifiedOnChain: fields.verified,
  };
}

/** The budget as it stands, or null without a signer. */
export function snapshot(context: FlowContext): BudgetSnapshot | null {
  if (context.spec === undefined) return null;
  return budgetSnapshot(context.ledger, context.spec, context.policy);
}

/**
 * The payment-identifier value for an idempotency key: stable for the key within its budget window,
 * and revealing neither.
 */
export function paymentIdentifier(windowId: string, key: string): string {
  const digest = toBase64Url(sha256(fromUtf8(`${windowId}:${key}`)));
  return `rail402_${digest.slice(0, 32)}`;
}

/**
 * Converts any failure into a PaymentError for this call. Egress refusals keep their code, stage and
 * details (such as the code of a relay that refused the request); anything unexpected is reported
 * with a redacted message.
 */
export function asPaymentError(error: unknown, callId: string, paid?: Paid): PaymentError {
  if (isPaymentError(error)) return withCallId(error, callId) as PaymentError;
  if (isEgressError(error)) {
    return paymentError(error.code, {
      reason: error.reason,
      details: { ...error.details, stage: error.stage },
      callId,
      ...(paid === undefined ? {} : { paid }),
    });
  }
  throw error;
}

/** The same error with the call's id, when it had none. */
export function withCallId(error: unknown, callId: string): unknown {
  if (!isPaymentError(error) || error.callId !== undefined) return error;
  return paymentError(error.code, {
    reason: error.reason,
    details: error.details,
    paid: error.paid,
    callId,
    receipt: error.receipt,
    cause: error.cause,
  });
}

/** An upstream error message, redacted and bounded, for a reason string. */
export function upstreamMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const clean = redact(text).replace(/\s+/g, " ").trim();
  return clean === "" ? "no detail given" : clean.slice(0, 300);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
