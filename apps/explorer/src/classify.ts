import { MuxedAccount } from "@stellar/stellar-sdk";
import type { Confidence, PaymentRow, Scheme } from "./types.js";

/**
 * Collapse a muxed `M…` account to its base `G…`. A transaction source (or a classic op source)
 * can be muxed; comparing an M-form source against a G-form transfer party would wrongly pass the
 * sponsorship test and would miss facilitator attribution (review M4/m11). G/C addresses pass
 * through unchanged; a malformed M is returned as-is rather than throwing.
 */
function baseAccount(address: string | undefined): string | undefined {
  if (address === undefined || !address.startsWith("M")) return address;
  try {
    return MuxedAccount.fromAddress(address, "0").baseAccount().accountId();
  } catch {
    return address;
  }
}

/**
 * The classifier: a Soroban `getTransaction` result (xdrFormat: "json") in, zero or more
 * x402 payment rows out.
 *
 * ## What counts as x402-shaped (measured, not assumed)
 *
 * ```
 * exact :=  op == invoke_host_function
 *        ∧  invoked fn == transfer with 3 args (a DIRECT SAC transfer — an inner transfer inside
 *           some other contract call is NOT counted; scheme_exact_stellar settles with the
 *           transfer as the root invocation)
 *        ∧  an ADDRESS-credentialed auth entry signed by the token sender
 *        ∧  sender ∉ { op source, tx source, fee-bump fee source }   // fee is sponsored
 *
 * upto  :=  invoked contract ∈ known upto settlement contracts ∧ fn == settle
 *           (the contract IS the marker; args carry buyer/seller/ceiling/actual)
 * ```
 *
 * Run live over 18 testnet ledgers on 2026-08-13: 5/5 true positives, 0 false positives.
 * Confidence is labeled per row
 * and inference is never presented as fact.
 *
 * ## Parsing rules that came from REAL fixtures (apps/explorer/fixtures/README.md)
 *
 * - `credentials` is either `{ address: {...} }` or the PLAIN STRING `"source_account"` — any
 *   `Object.keys(x)` walk crashes on the string form.
 * - Event `data` is `{ i128 }` or `{ map: [{amount}, {to_muxed_id}] }` for muxed destinations.
 * - `upto` argument positions are the INVOCATION's 8, not the auth context's 5:
 *   token 0, from 1, to 2, ceiling 3, expiration 4, nonce 5, actual 6, hook 7.
 * - A zero-amount upto settle emits NO events at all — it is still a row (amount "0").
 * - `createdAt` is unix seconds as a string; `memo` is the string `"none"` when absent.
 * - Amounts pass a digit-guard before BigInt — `BigInt("NaN")` throws.
 */

export interface ClassificationContext {
  readonly network: string;
  readonly epoch: string;
  /** signer/fee-source address → facilitator id, from verified /supported probes. */
  readonly signerIndex: ReadonlyMap<string, string>;
  /** upto settlement contract IDs (config knowns + registry-advertised). */
  readonly uptoContracts: ReadonlySet<string>;
  /** The facilitator id that gets the first-party confidence tier. */
  readonly selfFacilitatorId?: string;
}

/** A classified payment: everything in PaymentRow except enrichment and ingest bookkeeping. */
export type ClassifiedPayment = Omit<PaymentRow, "serviceName" | "resource" | "ingestedAt">;

const rec = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
const arr = (v: unknown): readonly unknown[] | undefined => (Array.isArray(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Guarded BigInt: an attacker-influenceable string must never throw out of a loop. */
function safeBigInt(v: unknown): bigint | undefined {
  if (typeof v !== "string" || !/^-?\d+$/.test(v)) return undefined;
  return BigInt(v);
}

interface AddressAuth {
  readonly address: string;
  readonly sigExpirationLedger?: number;
}

/** Address-credentialed auth entries only; the `"source_account"` string form is skipped. */
function addressAuths(auth: readonly unknown[] | undefined): AddressAuth[] {
  const out: AddressAuth[] = [];
  for (const entry of auth ?? []) {
    const credentials = rec(rec(entry)?.["credentials"]);
    const address = rec(credentials?.["address"]);
    const signer = str(address?.["address"]);
    if (!signer) continue;
    const exp = address?.["signature_expiration_ledger"];
    out.push({
      address: signer,
      ...(typeof exp === "number" ? { sigExpirationLedger: exp } : {}),
    });
  }
  return out;
}

function parseMemo(memo: unknown): string | undefined {
  if (memo === undefined || memo === "none") return undefined;
  const m = rec(memo);
  if (!m) return undefined;
  const text = str(m["text"]);
  if (text !== undefined) return text;
  const id = m["id"];
  if (typeof id === "string" || typeof id === "number") return `id:${id}`;
  return undefined;
}

interface EventAmount {
  readonly amount: bigint;
  readonly muxedId?: string;
}

/**
 * Event `data`: bare `{i128}` or the muxed `{amount, to_muxed_id}` map form. Anything else —
 * including custom contracts that reuse the `transfer` topic symbol with their own data shapes
 * (live-captured: maps keyed `b_aud_s`) — parses to undefined, never to a fabricated amount.
 * Exported for tests against the raw getEvents capture.
 */
export function parseEventData(data: unknown): EventAmount | undefined {
  const d = rec(data);
  if (!d) return undefined;
  const bare = safeBigInt(d["i128"]);
  if (bare !== undefined) return { amount: bare };
  const entries = arr(d["map"]);
  if (!entries) return undefined;
  let amount: bigint | undefined;
  let muxedId: string | undefined;
  for (const entry of entries) {
    const e = rec(entry);
    const key = str(rec(e?.["key"])?.["symbol"]);
    const val = rec(e?.["val"]);
    if (key === "amount") amount = safeBigInt(val?.["i128"]);
    if (key === "to_muxed_id") {
      // CAP-27 muxed info is u64, bytes, OR text — "Attestra Tx" was live-captured as a string
      // form on 2026-08-13. Take whatever single scalar the ScVal JSON carries.
      const raw = val?.["u64"] ?? val?.["i128"] ?? val?.["string"] ?? val?.["bytes"];
      if (typeof raw === "string" || typeof raw === "number") muxedId = String(raw);
    }
  }
  return amount === undefined ? undefined : { amount, ...(muxedId ? { muxedId } : {}) };
}

interface TransferEvent {
  readonly opIndex: number;
  readonly contractId: string;
  readonly from: string;
  readonly to: string;
  readonly amount: bigint;
  readonly asset?: string;
  readonly muxedId?: string;
}

/**
 * Decoded `transfer` events from `events.contractEventsJson` — an array of arrays, ONE INNER
 * ARRAY PER OPERATION. The op index is preserved so a multi-op transaction attaches each row to
 * its own op's event, not the first transfer of the same token (review m2).
 */
function transferEvents(result: Record<string, unknown>): TransferEvent[] {
  const perOp = arr(rec(result["events"])?.["contractEventsJson"]) ?? [];
  const out: TransferEvent[] = [];
  perOp.forEach((group, opIndex) => {
    for (const ev of arr(group) ?? []) {
      const e = rec(ev);
      const contractId = str(e?.["contract_id"]);
      const body = rec(rec(e?.["body"])?.["v0"]);
      const topics = arr(body?.["topics"]);
      if (!contractId || !topics || topics.length < 3) continue;
      if (str(rec(topics[0])?.["symbol"]) !== "transfer") continue;
      const from = str(rec(topics[1])?.["address"]);
      const to = str(rec(topics[2])?.["address"]);
      const parsed = parseEventData(body?.["data"]);
      if (!from || !to || !parsed) continue;
      const asset = topics.length > 3 ? str(rec(topics[3])?.["string"]) : undefined;
      out.push({
        opIndex,
        contractId,
        from,
        to,
        amount: parsed.amount,
        ...(asset !== undefined ? { asset } : {}),
        ...(parsed.muxedId !== undefined ? { muxedId: parsed.muxedId } : {}),
      });
    }
  });
  return out;
}

/**
 * Net fee in stroops from transaction-level fee events (charge + negative refund). The value is
 * observed ledger truth, unlike the envelope's fee field which is only the bid.
 */
function netFee(result: Record<string, unknown>): bigint | undefined {
  const events = arr(rec(result["events"])?.["transactionEventsJson"]);
  if (!events) return undefined;
  let sum = 0n;
  let seen = false;
  for (const wrapper of events) {
    const body = rec(rec(rec(rec(wrapper)?.["event"])?.["body"])?.["v0"]);
    const topics = arr(body?.["topics"]);
    if (str(rec(topics?.[0])?.["symbol"]) !== "fee") continue;
    const amount = safeBigInt(rec(body?.["data"])?.["i128"]);
    if (amount === undefined) continue;
    sum += amount;
    seen = true;
  }
  return seen ? sum : undefined;
}

interface EnvelopeParts {
  readonly txBody: Record<string, unknown>;
  readonly txSource: string;
  readonly feeSource?: string;
}

function unwrapEnvelope(envelope: Record<string, unknown>): EnvelopeParts | undefined {
  const bump = rec(envelope["tx_fee_bump"]);
  if (bump) {
    const outer = rec(bump["tx"]);
    const feeSource = str(outer?.["fee_source"]);
    const txBody = rec(rec(rec(outer?.["inner_tx"])?.["tx"])?.["tx"]);
    const txSource = str(txBody?.["source_account"]);
    if (!txBody || !txSource) return undefined;
    return { txBody, txSource, ...(feeSource !== undefined ? { feeSource } : {}) };
  }
  const txBody = rec(rec(envelope["tx"])?.["tx"]);
  const txSource = str(txBody?.["source_account"]);
  if (!txBody || !txSource) return undefined;
  return { txBody, txSource };
}

function confidenceFor(
  facilitatorId: string | undefined,
  selfId: string | undefined,
): Confidence {
  if (facilitatorId !== undefined && facilitatorId === selfId) return "rail402";
  if (facilitatorId !== undefined) return "verified-facilitator";
  return "x402-shaped";
}

/** Classify one getTransaction result. Returns [] for anything that is not x402-shaped. */
export function classifyTransaction(
  rawResult: unknown,
  ctx: ClassificationContext,
): ClassifiedPayment[] {
  const result = rec(rawResult);
  if (!result || result["status"] !== "SUCCESS") return [];
  const txHash = str(result["txHash"]);
  const ledger = result["ledger"];
  if (!txHash || typeof ledger !== "number") return [];
  // A payment with no trustworthy close time is not recorded (review m12): inventing 1970 would
  // sink it to the bottom of the feed forever with no sentinel, and a wild value throws from
  // toISOString(). Live RPC and the Horizon adapter both always supply a valid createdAt.
  const createdAt = safeBigInt(str(result["createdAt"]));
  if (createdAt === undefined) return [];
  const closedMs = Number(createdAt) * 1000;
  if (!Number.isFinite(closedMs) || closedMs <= 0 || closedMs > 4_102_444_800_000) return [];
  const closedAt = new Date(closedMs).toISOString();

  const envelope = rec(result["envelopeJson"]);
  if (!envelope) return [];
  const parts = unwrapEnvelope(envelope);
  if (!parts) return [];
  const { txBody } = parts;
  // Sources may be muxed (M…); normalise to base G for comparison and attribution.
  const txSource = baseAccount(parts.txSource) as string;
  const feeSource = baseAccount(parts.feeSource);
  const memo = parseMemo(txBody["memo"]);
  const operations = arr(txBody["operations"]) ?? [];
  const events = transferEvents(result);
  const fee = netFee(result);

  const facilitatorId =
    ctx.signerIndex.get(txSource) ??
    (feeSource !== undefined ? ctx.signerIndex.get(feeSource) : undefined);
  const confidence = confidenceFor(facilitatorId, ctx.selfFacilitatorId ?? "rail402");

  const rows: ClassifiedPayment[] = [];
  operations.forEach((rawOp, opIndex) => {
    const op = rec(rawOp);
    const ihf = rec(rec(op?.["body"])?.["invoke_host_function"]);
    const inv = rec(rec(ihf?.["host_function"])?.["invoke_contract"]);
    if (!ihf || !inv) return;
    const opSource = baseAccount(str(op?.["source_account"])) ?? txSource;
    const contract = str(inv["contract_address"]);
    const fn = str(inv["function_name"]);
    const args = arr(inv["args"]) ?? [];
    if (!contract || !fn) return;
    const auths = addressAuths(arr(ihf["auth"]));

    let scheme: Scheme;
    let buyer: string;
    let seller: string;
    let amount: bigint;
    let ceiling: bigint | undefined;
    let assetContract: string;

    if (ctx.uptoContracts.has(contract) && fn === "settle" && args.length >= 7) {
      // The contract address IS the marker; args are the invocation's, never the auth context's.
      const token = str(rec(args[0])?.["address"]);
      const from = str(rec(args[1])?.["address"]);
      const to = str(rec(args[2])?.["address"]);
      const max = safeBigInt(rec(args[3])?.["i128"]);
      const actual = safeBigInt(rec(args[6])?.["i128"]);
      if (!token || !from || !to || max === undefined || actual === undefined) return;
      scheme = "upto";
      buyer = from;
      seller = to;
      amount = actual;
      ceiling = max;
      assetContract = token;
    } else if (fn === "transfer" && args.length === 3) {
      const from = str(rec(args[0])?.["address"]);
      const to = str(rec(args[1])?.["address"]);
      const value = safeBigInt(rec(args[2])?.["i128"]);
      if (!from || !to || value === undefined) return;
      // x402-shaped requires a detached, buyer-signed authorization with a sponsored fee. A
      // transfer authorized by the submitting account itself is ordinary wallet activity.
      const buyerAuth = auths.find(a => a.address === from);
      if (!buyerAuth) return;
      if (from === opSource || from === txSource || from === feeSource) return;
      scheme = "exact";
      buyer = from;
      seller = to;
      amount = value;
      assetContract = contract;
    } else {
      return;
    }

    const buyerAuth = auths.find(a => a.address === buyer);
    // Match the transfer event within THIS op's event group first, tie-breaking on amount, so a
    // multi-op transaction never borrows a sibling op's asset/muxedId (review m2). Fall back to a
    // cross-op match only when the op-scoped correlation isn't available.
    const matches = events.filter(
      e => e.contractId === assetContract && e.from === buyer && e.to === seller,
    );
    const event =
      matches.find(e => e.opIndex === opIndex && e.amount === amount) ??
      matches.find(e => e.opIndex === opIndex) ??
      matches.find(e => e.amount === amount) ??
      matches[0];

    rows.push({
      network: ctx.network,
      epoch: ctx.epoch,
      ledger,
      txHash,
      opIndex,
      scheme,
      buyer,
      seller,
      amount: amount.toString(),
      ...(ceiling !== undefined ? { ceiling: ceiling.toString() } : {}),
      assetContract,
      ...(event?.asset !== undefined ? { asset: event.asset } : {}),
      txSource,
      ...(feeSource !== undefined ? { feeSource } : {}),
      ...(fee !== undefined ? { feeCharged: fee.toString() } : {}),
      ...(facilitatorId !== undefined ? { facilitatorId } : {}),
      confidence,
      ...(buyerAuth?.sigExpirationLedger !== undefined
        ? { sigExpirationLedger: buyerAuth.sigExpirationLedger }
        : {}),
      ...(memo !== undefined ? { memo } : {}),
      ...(event?.muxedId !== undefined ? { muxedId: event.muxedId } : {}),
      closedAt,
      rawEnvelope: JSON.stringify(rawResult),
    });
  });
  return rows;
}
