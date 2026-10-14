/**
 * The outcome card of a finished run: what happened in one line, who gained or lost what, the
 * settlement transaction, and what the run shows. Money comes from chain reads only: the payer's
 * balance before and after, and the transaction's transfer to the seller.
 */
import type { CheckId, LabEvent, ScenarioId, TxView } from "../engine/events.ts";
import {
  CHECK_EXPECTED_CODES,
  OVERCHARGE_REFUSAL_CODE,
  REPLAY_REFUSAL_CODES,
  SCENARIO_IDS,
  SESSION_CHECK_WINDOW,
  type ExperimentId,
} from "../../../src/shared/lab.ts";
import { DOCS, type DocRef } from "./docs.ts";
import {
  collectFacts,
  httpExchanges,
  paidAmount,
  paidStateOf,
  requiredOf,
  sdkEvents,
  settlementTx,
  toolCallExchanges,
  type RunFacts,
} from "./facts.ts";
import { decimalDelta, pathAndQuery, signedAmount, toAtomic, toDecimal } from "./format.ts";
import { str } from "./json.ts";
import type { LaneTone } from "./lanes.ts";
import { trustLabel } from "./rows.ts";

export type OutcomeKind = "ok" | "error" | "info";

export interface MoneyLine {
  readonly tone: LaneTone;
  readonly who: string;
  readonly delta: string;
  /** How the delta reads: a gain, a loss, or neither. */
  readonly trend: "gain" | "loss" | "none";
}

export interface LearnPoint {
  readonly tone: LaneTone;
  readonly lead: string;
  readonly text: string;
}

export interface Outcome {
  readonly kind: OutcomeKind;
  readonly badge: string;
  readonly headline: string;
  readonly code: string | null;
  readonly reason: string | null;
  readonly money: readonly MoneyLine[];
  readonly tx: { readonly hash: string; readonly explorerUrl: string } | null;
  readonly learn: readonly LearnPoint[];
  readonly docs: readonly DocRef[];
}

export interface OutcomeContext {
  readonly asset: { readonly symbol: string; readonly decimals: number };
  /** The seller's and facilitator's names, as their lanes show them. */
  readonly sellerLabel: string;
  readonly facilitatorLabel: string;
}

/** The outcome of a run; undefined until it ends, and for wallet runs. */
export function projectOutcome(events: readonly LabEvent[], context: OutcomeContext): Outcome | undefined {
  const facts = collectFacts(events);
  const { start, end } = facts;
  if (start === undefined || end === undefined) return undefined;
  const scenario = start.scenario;
  const variant = start.variant;
  // Only the transaction the chain shows settling this run's payment is linked and counted.
  const tx = settlementTx(facts);
  // A payment the run could not prove that a later reconciliation proved reads as paid.
  const provenLater =
    end.status === "info" && end.code === "payment_settlement_unconfirmed" && tx !== undefined;
  const kind: OutcomeKind =
    end.status === "ok" || provenLater ? "ok" : end.status === "info" ? "info" : "error";
  const money = new Money(facts, context);
  const copy = copyFor(scenario, variant, end.status, facts, context);
  return {
    kind,
    badge: copy.badge,
    // A run that stopped with money possibly moved keeps the copy that says what happened to it.
    headline:
      end.status === "error" && paidStateOf(facts) === "none"
        ? `The run stopped: ${end.reason ?? "unexpected error"}`
        : copy.headline,
    code: end.code ?? null,
    reason: end.code === undefined && end.status !== "error" ? null : (end.reason ?? null),
    money: money.lines(scenario),
    tx: tx === undefined ? null : { hash: tx.hash, explorerUrl: tx.explorerUrl },
    learn: copy.learn,
    docs: copy.docs,
  };
}

/** The scenario after this one, for the "next" button. */
export function nextScenario(scenario: ScenarioId): ScenarioId {
  const index = SCENARIO_IDS.indexOf(scenario);
  return SCENARIO_IDS[(index + 1) % SCENARIO_IDS.length] ?? "pay";
}

class Money {
  private readonly facts: RunFacts;
  private readonly context: OutcomeContext;

  constructor(facts: RunFacts, context: OutcomeContext) {
    this.facts = facts;
    this.context = context;
  }

  lines(scenario: ScenarioId): MoneyLine[] {
    const { symbol } = this.context.asset;
    const lines: MoneyLine[] = [this.payer(scenario)];
    if (scenario !== "agent" || this.facts.tools.length > 0) lines.push(this.seller());
    const tx = settlementTx(this.facts);
    if (tx?.feeBump !== null && tx?.feeBump !== undefined && scenario !== "sell") {
      // The facilitator is named only when /supported advertises the account that paid the fee.
      lines.push({
        tone: "rail",
        who:
          tx.feeSourceAdvertised === true
            ? this.context.facilitatorLabel
            : "Fee payer (not advertised by the facilitator)",
        delta: `0 ${symbol} · paid ${tx.feeBump.feeCharged} stroops in fees`,
        trend: "none",
      });
    }
    const released = sdkEvents(this.facts, "released");
    const belowCap = released.find((event) => event.reason === "settled_below_cap");
    if (belowCap !== undefined) {
      lines.push({
        tone: "you",
        who: "Unused cap",
        delta: `${this.decimal(belowCap.amount)} ${symbol} back in your budget`,
        trend: "none",
      });
    }
    const expired = released.find((event) => event.reason === "expired_unused");
    if (expired !== undefined) {
      lines.push({
        tone: "you",
        who: "Held cap",
        delta: `${this.decimal(expired.amount)} ${symbol} back in your budget: the authorization expired unused`,
        trend: "none",
      });
    }
    if (scenario === "agent") {
      const pay = this.facts.tools.find((tool) => tool.name === "pay_and_call")?.result?.result;
      const remaining = str(pay, "budget", "assets", 0, "remaining");
      const total = str(pay, "budget", "assets", 0, "sessionCap");
      if (remaining !== undefined) {
        lines.push({
          tone: "you",
          who: "Budget left",
          delta: total === undefined ? `${remaining} ${symbol}` : `${remaining} of ${total} ${symbol}`,
          trend: "none",
        });
      }
    }
    if (scenario === "sell") {
      const trust = this.listedTrust();
      if (trust !== undefined) lines.push({ tone: "bazaar", who: "Listing", delta: trust, trend: "none" });
    }
    return lines;
  }

  private payer(scenario: ScenarioId): MoneyLine {
    const who = scenario === "agent" ? "Agent wallet" : scenario === "sell" ? "Buyer (you)" : "You";
    const balance = this.facts.payerBalance;
    const delta =
      balance === undefined
        ? undefined
        : decimalDelta(balance.before, balance.after, this.context.asset.decimals);
    if (delta === undefined) return { tone: "you", who, delta: "balance not read", trend: "none" };
    return { tone: "you", who, delta: signedAmount(delta, this.context.asset.symbol), trend: trendOf(delta) };
  }

  private seller(): MoneyLine {
    const who = this.context.sellerLabel;
    const payTo = this.payTo();
    const tx = settlementTx(this.facts);
    if (tx === undefined || payTo === undefined) {
      return { tone: "seller", who, delta: `0 ${this.context.asset.symbol}`, trend: "none" };
    }
    const received = receivedBy(tx, payTo);
    const decimal = toDecimal(received.toString(), this.context.asset.decimals) ?? "0";
    return {
      tone: "seller",
      who,
      delta: signedAmount(decimal, this.context.asset.symbol),
      trend: trendOf(decimal),
    };
  }

  private payTo(): string | undefined {
    return payToOf(this.facts);
  }

  private listedTrust(): string | undefined {
    const listingId =
      httpExchanges(this.facts).paid?.response?.trace?.bazaar?.listingId ?? this.facts.listing?.id;
    const hit = this.facts.searches.at(-1)?.top.find((item) => item.id === listingId);
    const trust = hit?.trust ?? this.facts.listing?.trust;
    return trust === undefined ? undefined : trustLabel(trust);
  }

  private decimal(atomic: string): string {
    return toDecimal(atomic, this.context.asset.decimals) ?? atomic;
  }
}

/** The seller's account: from the authorization, the 402 the buyer took, or the payment receipt. */
function payToOf(facts: RunFacts): string | undefined {
  const auth = facts.auth;
  if (auth?.scheme === "exact") return auth.transfer.to;
  if (auth?.scheme === "upto") return auth.terms.recipient;
  const { probe } = httpExchanges(facts);
  const option = requiredOf(probe)?.options.find((item) => item.verdict?.acceptable === true);
  if (option !== undefined) return option.payTo;
  const mcp = toolCallExchanges(facts).unpaid?.response?.rpc?.required?.options[0];
  if (mcp !== undefined) return mcp.payTo;
  return str(facts.tools.find((tool) => tool.name === "pay_and_call")?.result?.result, "payment", "payTo");
}

/**
 * The badge and headline of a paid call that did not end ok, by what is known about its money: proven
 * after the run, settled though the call failed, sent with an unknown outcome, or not paid.
 */
function unfinishedCopy(
  facts: RunFacts,
  what: string,
  reason: string,
  paidText: string | undefined,
): { readonly badge: string; readonly headline: string } | undefined {
  switch (paidStateOf(facts)) {
    case "settled":
      return {
        badge: "Paid, the call failed",
        headline: `You paid for ${what}, but it did not deliver: ${reason}`,
      };
    case "unknown":
      return settlementTx(facts) !== undefined
        ? {
            badge: "Paid, proven later",
            headline: `You paid ${paidText ?? "the price"} for ${what}; the chain proved the settlement after the run.`,
          }
        : {
            badge: "Outcome unknown",
            headline: `A payment for ${what} was sent, but its outcome is not proven; the hold stays in your budget until the chain proves what moved.`,
          };
    case "none":
      return undefined;
  }
}

/** What a transaction moved to an account, in base units. */
function receivedBy(tx: TxView, account: string): bigint {
  return tx.transfers
    .filter((transfer) => transfer.to === account)
    .reduce((sum, transfer) => sum + (/^\d+$/.test(transfer.amount) ? BigInt(transfer.amount) : 0n), 0n);
}

function trendOf(decimal: string): MoneyLine["trend"] {
  const value = toAtomic(decimal, 18);
  if (value === undefined || value === 0n) return "none";
  return value < 0n ? "loss" : "gain";
}

interface Copy {
  readonly badge: string;
  readonly headline: string;
  readonly learn: readonly LearnPoint[];
  readonly docs: readonly DocRef[];
}

function copyFor(
  scenario: ScenarioId,
  variant: ExperimentId | CheckId,
  status: "ok" | "refused" | "error" | "info",
  facts: RunFacts,
  context: OutcomeContext,
): Copy {
  const { symbol, decimals } = context.asset;
  const paid = paidAmount(facts);
  const paidText =
    paid === undefined
      ? undefined
      : `${toDecimal(paid.atomic, decimals) ?? paid.atomic} ${symbol}${paid.proven ? "" : " (reported by the seller)"}`;
  const proven = settlementTx(facts);
  const sponsored = proven?.feeBump !== null && proven?.feeBump !== undefined;
  const signed = sdkEvents(facts, "signed").length;
  const { probe } = httpExchanges(facts);
  const what =
    probe === undefined ? "the resource" : (probe.request.rpc?.toolName ?? pathAndQuery(probe.request.url));
  const code = facts.end?.code;
  const reason = facts.end?.reason ?? "no reason given";
  const unfinished = status === "ok" ? undefined : unfinishedCopy(facts, what, reason, paidText);

  if (variant in CHECK_EXPECTED_CODES) {
    const expected = CHECK_EXPECTED_CODES[variant as CheckId];
    const matched = code === expected;
    const sessionPaidOnce = variant === "session-budget" && signed === 1 && facts.txs.length === 1;
    return {
      badge: matched
        ? "Refused as expected"
        : status === "refused"
          ? "Refused with another code"
          : "Not refused",
      headline: sessionPaidOnce
        ? `The first payment of ${SESSION_CHECK_WINDOW.total} ${symbol} fit the room left in your session budget; the second was refused before signing.`
        : signed === 0
          ? "Nothing was signed and nothing left your wallet."
          : facts.txs.length === 0
            ? "The payment was refused after signing; nothing settled."
            : "The payment was signed and a transaction was read; see the rows for what settled.",
      learn: [
        { tone: "you", lead: "Your policy decides,", text: "before anything is signed." },
        {
          tone: "seller",
          lead: "Every refusal has a stable code,",
          text: "so code and agents can react without parsing text.",
        },
      ],
      docs: [DOCS.spendingPolicy, DOCS.errorCodes],
    };
  }

  switch (scenario) {
    case "pay":
      if (variant === "low-cap") {
        return {
          badge: status === "refused" ? "Refused safely" : "Not refused",
          headline:
            signed === 0
              ? "Nothing was signed and nothing left your wallet."
              : "The payment was signed: the cap did not stop it.",
          learn: [
            {
              tone: "you",
              lead: "Caps are enforced before signing,",
              text: "by your own buyer, not by the seller or the facilitator.",
            },
            {
              tone: "seller",
              lead: "Every refusal has a stable code,",
              text: "so code and agents can react without parsing text.",
            },
            {
              tone: "rail",
              lead: "The facilitator never saw a payment,",
              text: "because there was nothing to settle.",
            },
          ],
          docs: [DOCS.spendingPolicy, DOCS.errorCodes],
        };
      }
      if (variant === "replay") {
        const once = status === "info" && code !== undefined && Object.hasOwn(REPLAY_REFUSAL_CODES, code);
        const resent = httpExchanges(facts).resend !== undefined;
        const nonce = facts.auth?.nonce;
        const forNonce = facts.txs.filter((tx) => nonce !== undefined && tx.nonces.includes(nonce)).length;
        const twice = resent && status === "error" && (forNonce > 1 || /balance moved/.test(reason));
        return {
          badge: once ? "Paid once" : twice ? "Charged more than once" : "The experiment did not run",
          headline: once
            ? "You sent the payment twice and were charged once."
            : twice
              ? `You sent the payment twice; ${forNonce > 1 ? `the chain shows ${String(forNonce)} transactions for it` : "your balance moved on the copy"}.`
              : `The first payment did not complete, so there was nothing to send twice: ${reason}`,
          learn: [
            {
              tone: "rail",
              lead: "The facilitator remembers every authorization",
              text: "and refuses one that was already used.",
            },
            {
              tone: "stellar",
              lead: "Stellar enforces it too:",
              text: "a used nonce can never be used again.",
            },
            { tone: "you", lead: "Retrying is safe.", text: "A copy of a payment cannot charge you twice." },
          ],
          docs: [DOCS.verificationRules, DOCS.idempotency],
        };
      }
      return {
        badge: status === "ok" ? "Paid and delivered" : (unfinished?.badge ?? "Not paid"),
        headline:
          unfinished?.headline ??
          (status !== "ok"
            ? status === "info"
              ? reason
              : `The call to ${what} did not complete.`
            : `You paid ${paidText ?? "the price"} for ${what}${sponsored ? ", and needed no XLM." : "."}`),
        learn: [
          {
            tone: "seller",
            lead: "The price travels in HTTP.",
            text: "A 402 with machine-readable terms replaces API keys.",
          },
          { tone: "you", lead: "You sign one exact payment.", text: "Your cap is checked before signing." },
          {
            tone: "rail",
            lead: "The facilitator settles and sponsors the fee,",
            text: "but never holds the money.",
          },
        ],
        docs: [DOCS.x402, DOCS.sdk],
      };
    case "upto": {
      if (variant === "overcharge") {
        const blocked = status === "refused" && code === OVERCHARGE_REFUSAL_CODE && proven === undefined;
        const settledOver = proven !== undefined;
        return {
          badge: blocked
            ? "Overcharge blocked"
            : settledOver
              ? "Overcharge settled"
              : "The experiment did not run",
          headline: blocked
            ? "The seller asked for more than you authorized. Nothing moved."
            : settledOver
              ? "The seller asked for more than you authorized, and a transaction was sent."
              : `The seller's overcharge was never tried: ${reason}`,
          learn: [
            {
              tone: "you",
              lead: "Your cap is a hard limit,",
              text: "checked at /settle and again by the settlement contract.",
            },
            {
              tone: "rail",
              lead: "Only the facilitator you signed for can settle,",
              text: "and only within your signed terms.",
            },
            {
              tone: "stellar",
              lead: "The hold returns to your budget",
              text: "once the unused authorization expires.",
            },
          ],
          docs: [DOCS.uptoContract, DOCS.verificationRules],
        };
      }
      const max = facts.auth?.scheme === "upto" ? toDecimal(facts.auth.terms.maxAmount, decimals) : undefined;
      return {
        badge: status === "ok" ? "Charged for usage" : (unfinished?.badge ?? "Not paid"),
        headline:
          unfinished?.headline ??
          (status !== "ok" || paidText === undefined
            ? `The call to ${what} did not complete.`
            : `You authorized up to ${max ?? "the cap"} ${symbol} and paid ${paidText}.`),
        learn: [
          { tone: "you", lead: "You sign a ceiling,", text: "not a price." },
          { tone: "seller", lead: "The seller charges real usage", text: "after doing the work." },
          { tone: "stellar", lead: "A contract enforces the cap", text: "and single use, on chain." },
        ],
        docs: [DOCS.upto, DOCS.meteredPricing],
      };
    }
    case "agent": {
      const pay = facts.tools.find((tool) => tool.name === "pay_and_call")?.result?.result;
      const tool = str(pay, "target", "toolName") ?? "a tool";
      const agentCopy = unfinishedCopy(facts, tool, reason, paidText);
      return {
        badge: status === "ok" ? "Agent paid within budget" : (agentCopy?.badge ?? "Agent did not pay"),
        headline:
          status === "ok" && paidText !== undefined
            ? `Your agent found ${tool}, paid ${paidText} and got its answer.`
            : (agentCopy?.headline ?? (status === "info" ? reason : "The agent did not complete the call.")),
        learn: [
          {
            tone: "bazaar",
            lead: "Agents discover by describing the task,",
            text: "not by hard-coded URLs.",
          },
          {
            tone: "you",
            lead: "Limits are enforced before signing;",
            text: "the agent never holds the key.",
          },
          { tone: "rail", lead: "Any MCP client can do this", text: "with one config entry." },
        ],
        docs: [DOCS.mcpServer, DOCS.agentLimits],
      };
    }
    case "sell": {
      const outcome = httpExchanges(facts).paid?.response?.trace?.bazaar;
      const listed = facts.searches
        .at(-1)
        ?.top.some((item) => item.id === (outcome?.listingId ?? facts.listing?.id));
      const refusedListing = outcome?.status === "rejected";
      const sellCopy = unfinishedCopy(facts, "the sample API", reason, paidText);
      const earned = settlementTx(facts) !== undefined;
      return {
        badge:
          status === "ok"
            ? listed === true
              ? "Earned and listed"
              : "Earned, listing pending"
            : refusedListing && earned
              ? "Earned, listing refused"
              : !earned && code === "payment_settlement_unconfirmed"
                ? "Paid, not proven"
                : (sellCopy?.badge ?? "Not listed"),
        headline:
          paidText === undefined
            ? (sellCopy?.headline ?? "The sample API was not paid.")
            : !earned && sellCopy !== undefined
              ? sellCopy.headline
              : refusedListing
                ? `The sample API earned ${paidText}, but the Bazaar refused to list this route: ${outcome.reason ?? outcome.code}`
                : listed === true
                  ? `The sample API earned ${paidText} and is listed in the Bazaar.`
                  : `The sample API earned ${paidText}; its listing is not in search yet.`,
        learn: [
          {
            tone: "seller",
            lead: "No registration.",
            text: "A paid call with the bazaar extension creates the listing.",
          },
          {
            tone: "rail",
            lead: "Ownership follows the money:",
            text: "only the payTo that was paid can change the listing.",
          },
          {
            tone: "bazaar",
            lead: "Listings earn trust",
            text: "through the origin check, and a stellar.toml naming the payTo.",
          },
        ],
        docs: [DOCS.sellerHelpers, DOCS.cataloging],
      };
    }
  }
}

/** The result of a refusal check: the code against the expected one, and proof that nothing moved. */
export interface CheckResult {
  readonly check: CheckId;
  readonly finished: boolean;
  readonly expected: string;
  readonly code: string | null;
  readonly reason: string | null;
  readonly layer: string | null;
  readonly passed: boolean;
  readonly signed: number;
  readonly reserved: number;
  readonly transactions: number;
  /** The transactions the check settled on purpose (the session check's first payment), with their links. */
  readonly paid: readonly { readonly hash: string; readonly explorerUrl: string }[];
  readonly balance: "unchanged" | "changed" | "unknown";
  /** The payer's balance change over the whole check, decimal and signed; null when unread. */
  readonly delta: string | null;
}

export function projectCheck(check: CheckId, events: readonly LabEvent[], decimals: number): CheckResult {
  const facts = collectFacts(events);
  const refusal = facts.refusals.at(-1);
  const code = facts.end?.code ?? refusal?.code ?? null;
  // Over the whole check: the session check pays once before its second payment is refused.
  const balance = facts.payerBalance;
  const delta = balance === undefined ? undefined : decimalDelta(balance.before, balance.after, decimals);
  const expected = CHECK_EXPECTED_CODES[check];
  const signed = sdkEvents(facts, "signed").length;
  const reserved = sdkEvents(facts, "reserved").length;
  const moved = delta === undefined ? undefined : toAtomic(delta, decimals);
  const balanceState = moved === undefined ? "unknown" : moved === 0n ? "unchanged" : "changed";
  // Proof that only what the check allows moved, from a balance read before and after: nothing for a
  // refusal check; for the session check, exactly one price when its first payment was signed.
  const price = toAtomic(SESSION_CHECK_WINDOW.total, decimals) ?? 0n;
  const moneyProven =
    check === "session-budget"
      ? signed <= 1 && reserved <= 1 && moved !== undefined && moved === (signed === 1 ? -price : 0n)
      : signed === 0 && reserved === 0 && balanceState === "unchanged";
  return {
    check,
    finished: facts.end !== undefined,
    expected,
    code,
    reason: facts.end?.reason ?? refusal?.reason ?? null,
    layer: refusal?.layer ?? null,
    passed: facts.end?.status === "refused" && code === expected && moneyProven,
    signed,
    reserved,
    transactions: facts.txs.length,
    paid: facts.txs
      .filter((tx) => tx.status === "SUCCESS")
      .map((tx) => ({ hash: tx.hash, explorerUrl: tx.explorerUrl })),
    balance: balanceState,
    delta: delta ?? null,
  };
}
