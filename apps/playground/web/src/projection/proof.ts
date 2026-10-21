/**
 * How a finished run ends on the stage: the proof of a payment the chain confirms (the amount, the
 * cap that was never taken, who paid the fee, the transaction and the parties), or the verdict of a
 * run that was refused or stopped (its code, who refused it, and that nothing was signed or moved).
 * Money comes from chain reads only.
 */
import type { LabEvent } from "../engine/events.ts";
import type { PublicConfig } from "../engine/types.ts";
import {
  CHECK_EXPECTED_CODES,
  CHECK_IDS,
  OVERCHARGE_REFUSAL_CODE,
  REPLAY_REFUSAL_CODES,
  type CheckId,
} from "../../../src/shared/lab.ts";
import { DOCS, type DocRef } from "./docs.ts";
import {
  collectFacts,
  facilitatorShown,
  paidAmount,
  paidStateOf,
  sdkEvents,
  settlementTx,
  type RunFacts,
} from "./facts.ts";
import { decimalDelta, short, toAtomic, toDecimal } from "./format.ts";
import { str } from "./json.ts";
import { projectCheck } from "./checks.ts";
import { addressLink, layerText, summarize, type ResultAsset, type StageFact } from "./stage.ts";

export interface ProofParty {
  readonly role: string;
  readonly tone: "you" | "seller" | "rail" | "chain";
  readonly address: string;
  readonly href: string | undefined;
  /** What this party did, in a few words. */
  readonly did: string;
}

export interface ProofView {
  readonly scheme: "exact" | "upto";
  /** Decimal amount the chain shows paid to the seller. */
  readonly paid: string;
  readonly symbol: string;
  /** The cap signed (upto) or the run's per-call cap (exact), decimal. */
  readonly cap: string | null;
  /** Upto: the part of the signed cap that was never taken, decimal. */
  readonly untaken: string | null;
  /** The network fee was paid by another account (the facilitator), not the payer. */
  readonly feeSponsored: boolean;
  readonly facilitator: string;
  readonly tx: { readonly hash: string; readonly url: string };
  readonly parties: readonly ProofParty[];
  /** What the call returned, as readable pairs. */
  readonly result: readonly StageFact[];
  readonly docs: readonly DocRef[];
}

export interface ProofContext {
  readonly config: Pick<PublicConfig, "asset" | "explorerTemplate">;
  /** Whether the seller is the Playground's own (named Rail402 without other evidence). */
  readonly ours: boolean;
}

/** The proof of a finished run whose payment the chain confirms; undefined otherwise. */
export function projectProof(events: readonly LabEvent[], context: ProofContext): ProofView | undefined {
  const facts = collectFacts(events);
  const end = facts.end;
  const tx = settlementTx(facts);
  const auth = facts.auth;
  const paid = paidAmount(facts);
  if (end === undefined || tx === undefined || auth === undefined || paid?.proven !== true) return undefined;
  const provenLater = end.status === "info" && end.code === "payment_settlement_unconfirmed";
  if (end.status !== "ok" && !provenLater) return undefined;
  const { symbol, decimals } = context.config.asset;
  const decimal = (atomic: string): string => toDecimal(atomic, decimals) ?? atomic;
  const link = (address: string): string | undefined => addressLink(context.config.explorerTemplate, address);
  const payer = auth.scheme === "exact" ? auth.transfer.from : auth.address;
  const seller = auth.scheme === "exact" ? auth.transfer.to : auth.terms.recipient;
  const paidText = decimal(paid.atomic);
  const max = auth.scheme === "upto" ? auth.terms.maxAmount : null;
  const untaken =
    max !== null && /^\d+$/.test(max) && BigInt(max) >= BigInt(paid.atomic)
      ? decimal((BigInt(max) - BigInt(paid.atomic)).toString())
      : null;
  const feeSource = tx.feeBump?.feeSource;
  const feeSponsored = feeSource !== undefined && feeSource !== payer;
  const facilitator =
    tx.feeSourceAdvertised === true ||
    facilitatorShown(facts) ||
    (context.ours && tx.feeSourceAdvertised !== false)
      ? "Rail402"
      : "Facilitator";
  const parties: ProofParty[] = [
    {
      role: facts.start?.scenario === "agent" ? "Your agent" : "You",
      tone: "you",
      address: payer,
      href: link(payer),
      did:
        auth.scheme === "upto"
          ? `signed once, up to ${decimal(auth.terms.maxAmount)}`
          : `signed once for ${decimal(auth.transfer.amount)}`,
    },
    {
      role: "Seller",
      tone: "seller",
      address: seller,
      href: link(seller),
      did: `received ${paidText} ${symbol}`,
    },
  ];
  if (feeSponsored) {
    parties.push({
      role: facilitator,
      tone: "rail",
      address: feeSource,
      href: link(feeSource),
      did: `paid the network fee (${tx.feeBump?.feeCharged ?? "?"} stroops)`,
    });
  }
  parties.push(
    auth.scheme === "upto"
      ? {
          role: "Settlement contract",
          tone: "chain",
          address: auth.contract,
          href: link(auth.contract),
          did: `checked ${paidText} ≤ ${decimal(auth.terms.maxAmount)}`,
        }
      : {
          role: `${symbol} contract`,
          tone: "chain",
          address: auth.transfer.contract,
          href: link(auth.transfer.contract),
          did: `moved ${paidText} from you to the seller`,
        },
  );
  const structured = facts.tools.find((tool) => tool.name === "pay_and_call")?.result?.result;
  const body = facts.delivery?.body ?? null;
  const result =
    facts.start?.scenario === "agent"
      ? structured === undefined
        ? []
        : toolResult(structured, { symbol, decimals })
      : body === null
        ? []
        : summarize(body, { symbol, decimals });
  return {
    scheme: auth.scheme,
    paid: paidText,
    symbol,
    cap: max === null ? (facts.start?.cap ?? null) : decimal(max),
    untaken,
    feeSponsored,
    facilitator,
    tx: { hash: tx.hash, url: tx.explorerUrl },
    parties,
    result,
    docs:
      facts.start?.scenario === "agent"
        ? [DOCS.mcpServer, DOCS.agentLimits]
        : auth.scheme === "upto"
          ? [
              { label: "How upto works", path: DOCS.upto.path },
              { label: "What Rail402 checks", path: DOCS.verificationRules.path },
            ]
          : [
              { label: "How fees are sponsored", path: DOCS.feeSponsorship.path },
              { label: "What Rail402 checks", path: DOCS.verificationRules.path },
            ],
  };
}

function toolResult(value: Parameters<typeof str>[0], asset: ResultAsset): StageFact[] {
  const structured =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as { readonly response?: { readonly structuredContent?: unknown } }).response
          ?.structuredContent
      : undefined;
  return structured === undefined ? [] : summarize(structured as Parameters<typeof summarize>[0], asset);
}

export interface VerdictView {
  /** `refused`: stopped before paying; `error`: the run failed; `info`: it ended otherwise. */
  readonly tone: "refused" | "error" | "info";
  /** The run shows what it set out to show: a check or experiment as expected, or a safe refusal. */
  readonly good: boolean;
  /** One or two words over the title: `Refused as expected`, `Not proven`, `Stopped`. */
  readonly badge: string;
  readonly title: string;
  readonly code: string | null;
  readonly reason: string | null;
  /** Who refused it, in plain words. */
  readonly by: string | null;
  /** A refusal check: the code it expects, and whether the run proves it. */
  readonly check: { readonly id: CheckId; readonly expected: string; readonly passed: boolean } | null;
  readonly signed: number;
  /** Transactions the run read: this payment's proven settlement, or one a seller only reported. */
  readonly transactions: readonly {
    readonly hash: string;
    readonly url: string;
    readonly label: "Transaction" | "Reported transaction";
  }[];
  readonly balance: "unchanged" | "changed" | "unknown";
  /** The payer's balance change, decimal and signed; null when unread. */
  readonly delta: string | null;
  readonly docs: readonly DocRef[];
}

/** How a finished run without a proven payment ended; undefined while it runs or when it has proof. */
export function projectVerdict(events: readonly LabEvent[], context: ProofContext): VerdictView | undefined {
  const facts = collectFacts(events);
  const end = facts.end;
  if (end === undefined || projectProof(events, context) !== undefined) return undefined;
  const variant = facts.start?.variant;
  const checkId = (CHECK_IDS as readonly string[]).includes(variant ?? "") ? (variant as CheckId) : undefined;
  const { decimals } = context.config.asset;
  const refusal = facts.refusals.at(-1);
  const balance = facts.payerBalance;
  const delta = balance === undefined ? undefined : decimalDelta(balance.before, balance.after, decimals);
  const moved = delta === undefined ? undefined : toAtomic(delta, decimals);
  const proven = settlementTx(facts);
  const transactions = facts.txs
    .filter((tx) => tx.status === "SUCCESS")
    .map((tx) => ({
      hash: tx.hash,
      url: tx.explorerUrl,
      label: tx.hash === proven?.hash ? ("Transaction" as const) : ("Reported transaction" as const),
    }));
  const check = checkId === undefined ? undefined : projectCheck(checkId, events, decimals);
  const tone: VerdictView["tone"] =
    end.status === "refused" ? "refused" : end.status === "error" ? "error" : "info";
  const code = end.code ?? refusal?.code ?? null;
  const { title, good, badge } = verdictOf(facts, tone, code, check?.passed);
  return {
    tone,
    good,
    badge,
    title,
    code,
    reason: end.reason ?? refusal?.reason ?? null,
    by: refusal === undefined ? null : layerText(refusal.layer),
    check:
      check === undefined || checkId === undefined
        ? null
        : { id: checkId, expected: CHECK_EXPECTED_CODES[checkId], passed: check.passed },
    signed: sdkEvents(facts, "signed").length,
    transactions,
    balance: moved === undefined ? "unknown" : moved === 0n ? "unchanged" : "changed",
    delta: delta ?? null,
    docs: (code ?? "").startsWith("egress_")
      ? [DOCS.egress, DOCS.errorCodes]
      : variant === "overcharge"
        ? [DOCS.uptoContract, DOCS.verificationRules]
        : variant === "replay"
          ? [DOCS.verificationRules, DOCS.idempotency]
          : [DOCS.spendingPolicy, DOCS.errorCodes],
  };
}

/** Whether the refusal came before the refused payment was signed. */
function refusedBeforeSigning(facts: RunFacts): boolean {
  const refusal = facts.refusals.find(
    (item) =>
      item.layer === "policy" ||
      item.layer === "guard" ||
      item.layer === "playground" ||
      item.layer === "relay",
  );
  if (refusal === undefined) return false;
  const call = str(refusal.details, "callId");
  const signed = sdkEvents(facts, "signed");
  return call === undefined ? signed.length === 0 : !signed.some((event) => event.callId === call);
}

/**
 * The verdict's title, claiming only what the run shows: an experiment's result only when it ended
 * with that experiment's own code, and a payment as made only when the chain or the SDK says so.
 */
function verdictOf(
  facts: RunFacts,
  tone: VerdictView["tone"],
  code: string | null,
  checkPassed: boolean | undefined,
): { readonly title: string; readonly good: boolean; readonly badge: string } {
  const variant = facts.start?.variant;
  if (checkPassed !== undefined) {
    return {
      title: tone === "refused" ? titleOfRefusal(facts) : "The check did not end refused",
      good: checkPassed,
      badge: checkPassed ? "Refused as expected" : "Not as expected",
    };
  }
  if (variant === "replay") {
    return code !== null && code in REPLAY_REFUSAL_CODES && tone !== "error"
      ? { title: "Paid once, the copy was refused", good: true, badge: "Refused as expected" }
      : { title: "The experiment did not run", good: false, badge: "Not as expected" };
  }
  if (variant === "overcharge") {
    return code === OVERCHARGE_REFUSAL_CODE && tone === "refused"
      ? { title: "The overcharge was refused", good: true, badge: "Refused as expected" }
      : { title: "The experiment did not run", good: false, badge: "Not as expected" };
  }
  const paid = paidStateOf(facts);
  if (paid === "settled")
    return { title: "Paid, but the call failed", good: false, badge: "Paid, not delivered" };
  if (paid === "unknown" || facts.end?.status === "ok")
    return { title: "Sent, not proven on chain yet", good: false, badge: "Not proven" };
  if (tone === "refused") return { title: titleOfRefusal(facts), good: true, badge: "Refused" };
  if (tone === "error") return { title: "The run stopped", good: false, badge: "Stopped" };
  return { title: facts.end?.reason ?? "Done", good: true, badge: "Finished" };
}

function titleOfRefusal(facts: RunFacts): string {
  return refusedBeforeSigning(facts) ? "Refused before signing" : "Refused";
}

/** Short form of a hash for a button: `b89d…9efa`. */
export function shortHash(hash: string): string {
  return short(hash, 4);
}
