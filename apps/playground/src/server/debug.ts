import { StrKey } from "@stellar/stellar-sdk";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { txUrl } from "../browser/format.js";
import { stroopsToDisplay } from "../shared/amounts.js";

/**
 * Debug-my-payment: turn a transaction hash or a raw 402 challenge into an explained glass view.
 *
 *  - `reshapeExplorerTx` re-shapes the explorer's `/tx/:hash` PaymentDetail (see
 *    apps/explorer/openapi.yaml — the coordinated contract) into the same step-timeline shape
 *    `payExact` emits, reconstructed read-only from the ledger. The explorer's confidence tier is
 *    passed through and qualified in the narration, never flattened: `x402-shaped` means inferred
 *    from transaction shape, not a verified operator's settlement.
 *  - `analyzeChallenge` decodes a 402 body or a base64 `PAYMENT-REQUIRED` header and explains it:
 *    what it costs, who gets paid, and every defect that would stop a stock client from paying.
 *
 * "Replay" here is deliberately precise: a settled payment CANNOT be re-settled (single-use,
 * replay-protected — that is the security model, proven in the break-it bench). What this module
 * enables is decoding history and re-executing a FRESH payment to the same endpoint.
 */

// ── Types mirroring the explorer's PaymentDetail (apps/explorer/openapi.yaml) ──

export interface ExplorerPayment {
  readonly network: string;
  readonly epoch?: string;
  readonly ledger: number;
  readonly txHash: string;
  readonly scheme: "exact" | "upto";
  readonly buyer: string;
  readonly seller: string;
  readonly amount: string;
  readonly amountDecimal: string;
  readonly ceiling?: string;
  readonly ceilingDecimal?: string;
  readonly assetContract: string;
  readonly asset?: string;
  readonly assetCode?: string;
  readonly txSource: string;
  readonly feeSource?: string;
  readonly feeChargedStroops?: string;
  readonly facilitator: { readonly id: string; readonly displayName?: string } | null;
  readonly confidence: "rail402" | "verified-facilitator" | "x402-shaped";
  readonly sigExpirationLedger?: number;
  readonly closedAt: string;
  readonly serviceName?: string;
  readonly resource?: string;
}

export interface ExplorerPaymentDetail extends ExplorerPayment {
  readonly payments?: readonly ExplorerPayment[];
  readonly raw?: unknown;
}

/** Same shape the browser's payExact steps carry, reconstructed read-only. */
export interface DebugStep {
  readonly phase: "challenged" | "authorized" | "settling" | "settled";
  readonly message: string;
  readonly settlement?: { readonly transaction: string; readonly explorerUrl: string };
}

export interface DebugTxView {
  readonly isX402: true;
  readonly scheme: "exact" | "upto";
  readonly confidence: ExplorerPayment["confidence"];
  readonly network: string;
  readonly ledger: number;
  readonly closedAt: string;
  readonly transaction: string;
  readonly from: string;
  readonly to: string;
  readonly asset: string;
  readonly assetContract: string;
  readonly amountStroops: string;
  readonly amountDecimal: string;
  readonly ceilingStroops?: string;
  readonly ceilingDecimal?: string;
  readonly unspentStroops?: string;
  readonly feeSponsored: boolean;
  readonly feeChargedStroops?: string;
  readonly txSource: string;
  readonly facilitator: { readonly id: string; readonly displayName?: string } | null;
  readonly sigExpirationLedger?: number;
  readonly serviceName?: string;
  /** The Bazaar-enriched resource URL — the "try it fresh" deep-link target when present. */
  readonly sellerUrl?: string;
  readonly paymentsInTransaction: number;
  /** The Rail402 explorer's x402-aware receipt page. */
  readonly explorerUrl: string;
  /** The raw-ledger view of the same transaction. */
  readonly stellarExpertUrl: string;
  readonly steps: readonly DebugStep[];
}

const parseStroops = (raw: string | undefined): bigint | undefined => {
  // Guarded on purpose: BigInt() throws on "NaN"/"1e9", and any amount that crossed a network
  // boundary is attacker-influenceable. A malformed amount degrades the view, never crashes it.
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return undefined;
  try {
    return BigInt(raw);
  } catch {
    return undefined;
  }
};

function facilitatorPhrase(p: ExplorerPayment): string {
  switch (p.confidence) {
    case "rail402":
      return "The Rail402 facilitator";
    case "verified-facilitator":
      return `${p.facilitator?.displayName ?? p.facilitator?.id ?? "A verified facilitator"} (a facilitator verified by its published /supported signers)`;
    case "x402-shaped":
      return "An unknown submitter — this transaction has the SHAPE of an x402 settlement (detached buyer authorization, submitter-paid fee) but no verified facilitator claims it; inferred, not confirmed. It";
  }
}

/** Re-shape one explorer PaymentDetail into the glass debug view. */
export function reshapeExplorerTx(
  detail: ExplorerPaymentDetail,
  cfg: { explorerUrl: string },
): DebugTxView {
  const asset = detail.assetCode ?? detail.asset ?? detail.assetContract;
  const feePayer = detail.feeSource ?? detail.txSource;
  const feeSponsored = feePayer !== detail.buyer;
  const amount = parseStroops(detail.amount);
  const ceiling = parseStroops(detail.ceiling);
  const unspent =
    detail.scheme === "upto" && amount !== undefined && ceiling !== undefined && ceiling >= amount
      ? ceiling - amount
      : undefined;
  const expert = txUrl(detail.txHash);

  const steps: DebugStep[] = [
    {
      phase: "challenged",
      message:
        detail.scheme === "upto"
          ? `The seller quoted a metered price off-chain in a 402 challenge (that leg is not recorded on the ledger). What IS on the ledger: the buyer authorized spending up to ${detail.ceilingDecimal ?? "?"} ${asset}.`
          : `The seller quoted ${detail.amountDecimal} ${asset} off-chain in a 402 challenge (that leg is not recorded on the ledger; this step is reconstructed from what was authorized).`,
    },
    {
      phase: "authorized",
      message:
        (detail.scheme === "upto"
          ? `The buyer ${detail.buyer} signed a Soroban authorization for UP TO ${detail.ceilingDecimal ?? "?"} ${asset} to ${detail.seller}`
          : `The buyer ${detail.buyer} signed a Soroban authorization for exactly ${detail.amountDecimal} ${asset} to ${detail.seller}`) +
        (detail.sigExpirationLedger !== undefined
          ? `, expiring at ledger ${detail.sigExpirationLedger}.`
          : ".") +
        " Nothing beyond what was signed can be charged.",
    },
    {
      phase: "settling",
      message: `${facilitatorPhrase(detail)} submitted the transaction as ${detail.txSource}; the network fee${detail.feeChargedStroops ? ` of ${detail.feeChargedStroops} stroops` : ""} was paid by ${
        feeSponsored ? "the submitter, not the buyer — the buyer needed no XLM (fee sponsorship)" : "the buyer itself"
      }.`,
    },
    {
      phase: "settled",
      message:
        detail.scheme === "upto"
          ? amount === 0n
            ? `Settled 0 ${asset} in ledger ${detail.ledger}: the authorization was consumed WITHOUT a transfer (a nonce burn) — nothing moved, and nothing more can ever be charged against it.`
            : `Settled the ACTUAL usage in ledger ${detail.ledger} at ${detail.closedAt}: ${detail.amountDecimal} of the ${detail.ceilingDecimal ?? "?"} ${asset} ceiling moved from ${detail.buyer} to ${detail.seller}${
                unspent !== undefined ? `; the unspent ${stroopsToDisplay(unspent)} never left the buyer's wallet` : ""
              }.`
          : `Settled in ledger ${detail.ledger} at ${detail.closedAt}: ${detail.amountDecimal} ${asset} moved from ${detail.buyer} to ${detail.seller}. Replaying this authorization is refused by the network (nonce already consumed).`,
      settlement: { transaction: detail.txHash, explorerUrl: expert },
    },
  ];

  return {
    isX402: true,
    scheme: detail.scheme,
    confidence: detail.confidence,
    network: detail.network,
    ledger: detail.ledger,
    closedAt: detail.closedAt,
    transaction: detail.txHash,
    from: detail.buyer,
    to: detail.seller,
    asset,
    assetContract: detail.assetContract,
    amountStroops: detail.amount,
    amountDecimal: detail.amountDecimal,
    ...(detail.ceiling !== undefined ? { ceilingStroops: detail.ceiling } : {}),
    ...(detail.ceilingDecimal !== undefined ? { ceilingDecimal: detail.ceilingDecimal } : {}),
    ...(unspent !== undefined ? { unspentStroops: unspent.toString() } : {}),
    feeSponsored,
    ...(detail.feeChargedStroops !== undefined ? { feeChargedStroops: detail.feeChargedStroops } : {}),
    txSource: detail.txSource,
    facilitator: detail.facilitator,
    ...(detail.sigExpirationLedger !== undefined ? { sigExpirationLedger: detail.sigExpirationLedger } : {}),
    ...(detail.serviceName !== undefined ? { serviceName: detail.serviceName } : {}),
    ...(detail.resource !== undefined ? { sellerUrl: detail.resource } : {}),
    paymentsInTransaction: detail.payments?.length ?? 1,
    explorerUrl: `${cfg.explorerUrl}/tx/${detail.txHash}`,
    stellarExpertUrl: expert,
    steps,
  };
}

// ── Challenge analysis ──────────────────────────────────────────────────────

export interface ChallengeOption {
  readonly scheme?: string;
  readonly network?: string;
  readonly stellar: boolean;
  readonly amountStroops?: string;
  readonly amountDecimal?: string;
  readonly asset?: string;
  readonly assetCode?: string;
  readonly payTo?: string;
  readonly maxTimeoutSeconds?: number;
  readonly feesSponsored: boolean;
  readonly uptoContract?: string;
  /** Every defect that would stop a stock client from paying this option. Empty ⇒ payable. */
  readonly issues: readonly string[];
}

export interface ChallengeAnalysis {
  readonly ok: boolean;
  readonly decodedFrom?: "json" | "payment-required-header";
  readonly x402Version?: number;
  /** The challenge's own `error` field, when the 402 carried a prior refusal. */
  readonly errorInChallenge?: string;
  readonly accepts: readonly ChallengeOption[];
  readonly stellarOptions: number;
  readonly payableOptions: number;
  readonly hasDiscovery: boolean;
  readonly issues: readonly string[];
  readonly reason: string;
}

function analyzeOption(raw: Record<string, unknown>, cfg: { usdcSac: string }): ChallengeOption {
  const issues: string[] = [];
  const scheme = typeof raw["scheme"] === "string" ? raw["scheme"] : undefined;
  const network = typeof raw["network"] === "string" ? raw["network"] : undefined;
  const stellar = network?.startsWith("stellar:") ?? false;
  const extra = (raw["extra"] ?? {}) as Record<string, unknown>;
  const feesSponsored = extra["areFeesSponsored"] === true;

  if (!stellar) {
    // Nothing wrong with a non-Stellar option in a mixed challenge — it is just not ours to judge.
    return {
      ...(scheme !== undefined ? { scheme } : {}),
      ...(network !== undefined ? { network } : {}),
      stellar,
      feesSponsored,
      issues: [],
    };
  }

  if (scheme !== "exact" && scheme !== "upto") {
    issues.push(
      `scheme "${scheme ?? "(missing)"}" is not a Stellar scheme this ecosystem settles (exact or upto).`,
    );
  }

  const amount = typeof raw["amount"] === "string" ? raw["amount"] : undefined;
  let amountDecimal: string | undefined;
  const parsed = parseStroops(amount);
  if (parsed === undefined || parsed <= 0n) {
    issues.push(
      `amount ${amount === undefined ? "is missing" : `"${amount}" is not a positive integer stroop string`} — Stellar amounts are 7-decimal integers, never floats.`,
    );
  } else {
    amountDecimal = stroopsToDisplay(parsed);
  }

  const payTo = typeof raw["payTo"] === "string" ? raw["payTo"] : undefined;
  if (
    !payTo ||
    !(
      StrKey.isValidEd25519PublicKey(payTo) ||
      StrKey.isValidContract(payTo) ||
      StrKey.isValidMed25519PublicKey(payTo)
    )
  ) {
    issues.push(
      payTo
        ? `payTo "${payTo}" is not a valid Stellar address — the strkey checksum fails (addresses cannot be fabricated or edited by hand).`
        : "payTo is missing — a payment needs a recipient.",
    );
  }

  const maxTimeoutSeconds = typeof raw["maxTimeoutSeconds"] === "number" ? raw["maxTimeoutSeconds"] : undefined;
  if (maxTimeoutSeconds === undefined || maxTimeoutSeconds <= 0) {
    issues.push(
      "maxTimeoutSeconds is missing — it is required on v2 PaymentRequirements, and the authorization's ledger expiry is derived from it.",
    );
  }

  const asset = typeof raw["asset"] === "string" ? raw["asset"] : undefined;
  let assetCode: string | undefined;
  if (!asset || !StrKey.isValidContract(asset)) {
    issues.push(
      asset
        ? `asset "${asset}" is not a token contract address (C…) — Stellar x402 names the SEP-41 contract, not an asset code.`
        : "asset is missing — the challenge must name the token contract to pay in.",
    );
  } else if (asset === cfg.usdcSac) {
    assetCode = "USDC";
  }

  if (!feesSponsored) {
    issues.push(
      "extra.areFeesSponsored is not true — the stock @x402/stellar client throws without it, so buyers holding only the payment asset (no XLM) cannot pay this option.",
    );
  }

  const uptoContract = typeof extra["uptoContract"] === "string" ? extra["uptoContract"] : undefined;
  if (scheme === "upto") {
    if (!uptoContract || !StrKey.isValidContract(uptoContract)) {
      issues.push(
        "an upto option must name its settlement contract in extra.uptoContract (a valid C… address).",
      );
    }
  }

  return {
    ...(scheme !== undefined ? { scheme } : {}),
    ...(network !== undefined ? { network } : {}),
    stellar,
    ...(amount !== undefined ? { amountStroops: amount } : {}),
    ...(amountDecimal !== undefined ? { amountDecimal } : {}),
    ...(asset !== undefined ? { asset } : {}),
    ...(assetCode !== undefined ? { assetCode } : {}),
    ...(payTo !== undefined ? { payTo } : {}),
    ...(maxTimeoutSeconds !== undefined ? { maxTimeoutSeconds } : {}),
    feesSponsored,
    ...(uptoContract !== undefined ? { uptoContract } : {}),
    issues,
  };
}

/**
 * Decode and explain a 402 challenge. Accepts the raw JSON body (object or string) or the base64
 * `PAYMENT-REQUIRED` header. An undecodable input is an ANALYSIS RESULT (`ok: false`, with the
 * reason), not an HTTP error — explaining broken challenges is the point of the endpoint.
 */
export function analyzeChallenge(input: unknown, cfg: { usdcSac: string }): ChallengeAnalysis {
  let decoded: unknown;
  let decodedFrom: ChallengeAnalysis["decodedFrom"];

  if (typeof input === "object" && input !== null) {
    decoded = input;
    decodedFrom = "json";
  } else if (typeof input === "string") {
    const text = input.trim();
    if (text.startsWith("{")) {
      try {
        decoded = JSON.parse(text);
        decodedFrom = "json";
      } catch {
        return failedAnalysis(
          "The input looks like JSON but does not parse. Paste the 402 response body exactly as received.",
        );
      }
    } else {
      try {
        decoded = decodePaymentRequiredHeader(text);
        decodedFrom = "payment-required-header";
      } catch {
        return failedAnalysis(
          "The input is neither a JSON 402 body nor a decodable base64 PAYMENT-REQUIRED header.",
        );
      }
    }
  } else {
    return failedAnalysis(
      "The challenge must be the 402 response body (JSON object or string) or the base64 PAYMENT-REQUIRED header value.",
    );
  }

  const body = decoded as {
    x402Version?: unknown;
    error?: unknown;
    accepts?: unknown;
    extensions?: unknown;
  };
  const issues: string[] = [];

  const x402Version = typeof body.x402Version === "number" ? body.x402Version : undefined;
  if (x402Version !== 2) {
    issues.push(
      x402Version === undefined
        ? "x402Version is missing — a v2 challenge declares x402Version: 2."
        : `x402Version is ${x402Version}; this ecosystem speaks version 2 (v1 headers and shapes are a different protocol generation).`,
    );
  }

  const acceptsRaw = Array.isArray(body.accepts) ? body.accepts : undefined;
  if (!acceptsRaw || acceptsRaw.length === 0) {
    issues.push("accepts is missing or empty — a 402 challenge must offer at least one payment option.");
  }

  const accepts = (acceptsRaw ?? [])
    .filter((o): o is Record<string, unknown> => typeof o === "object" && o !== null)
    .map(o => analyzeOption(o, cfg));
  const stellarOptions = accepts.filter(o => o.stellar).length;
  const payable = accepts.filter(o => o.stellar && o.issues.length === 0);
  if (accepts.length > 0 && stellarOptions === 0) {
    issues.push(
      "No Stellar payment option is offered — a Stellar facilitator cannot settle any of these.",
    );
  }

  const hasDiscovery =
    typeof body.extensions === "object" &&
    body.extensions !== null &&
    "bazaar" in (body.extensions as Record<string, unknown>);

  const ok = x402Version === 2 && payable.length > 0;
  const priced = payable[0];
  const reason = ok
    ? `Payable: ${payable.length} of ${accepts.length} option(s) can be paid by a stock client${
        priced?.amountDecimal ? ` — ${priced.amountDecimal} ${priced.assetCode ?? "of the named asset"} via ${priced.scheme}` : ""
      }${hasDiscovery ? ", and the challenge carries Bazaar discovery metadata" : ""}.`
    : issues[0] ??
      `Not payable: every Stellar option has defects — ${
        accepts.find(o => o.stellar && o.issues.length > 0)?.issues[0] ?? "see the per-option issues"
      }`;

  return {
    ok,
    ...(decodedFrom !== undefined ? { decodedFrom } : {}),
    ...(x402Version !== undefined ? { x402Version } : {}),
    ...(typeof body.error === "string" ? { errorInChallenge: body.error } : {}),
    accepts,
    stellarOptions,
    payableOptions: payable.length,
    hasDiscovery,
    issues,
    reason,
  };
}

function failedAnalysis(reason: string): ChallengeAnalysis {
  return {
    ok: false,
    accepts: [],
    stellarOptions: 0,
    payableOptions: 0,
    hasDiscovery: false,
    issues: [reason],
    reason,
  };
}
