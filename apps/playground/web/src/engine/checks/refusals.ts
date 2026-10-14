/**
 * The refusal checks: each tries to pay something the buyer must refuse, and passes when it ends
 * refused with the expected code, nothing signed, and the payer's balance unchanged. The network,
 * asset and amount checks pay the Playground's 402-only lab offers, which never verify or settle; the
 * recipient and session checks use a one-off buyer with the same key and ledger under a stricter
 * policy (the session check in your own budget window, so what it spends shows in your budget); the
 * private-address check asks the relay for addresses it must never reach, and passes only
 * when each one is refused before any connection (local mode allows loopback, so there that target
 * is shown but not counted).
 */
import {
  CHECK_EXPECTED_CODES,
  LAB_PATHS,
  PRIVATE_ADDRESS_TARGETS,
  SESSION_CHECK_WINDOW,
  type CheckId,
} from "../../../../src/shared/lab.ts";
import { toAtomic, toDecimal } from "@rail402.dev/sdk/browser";
import { defaultSession } from "../buyer.ts";
import type { JsonValue } from "../events.ts";
import { clientError, codedError } from "../errors.ts";
import {
  money,
  outcomeOf,
  payHttp,
  readBalance,
  reportBalance,
  type Outcome,
  type Paid,
  type RunContext,
} from "../scenarios/context.ts";
import { weatherUrl } from "../scenarios/pay.ts";

/** The cap a check pays under: the low preset for the per-call check, the default otherwise. */
export function checkCap(check: CheckId, config: RunContext["config"]): string {
  return check === "per-call-cap" ? config.caps.perCallLowPreset : config.caps.perCallDefault;
}

/** One payment a check tried, and what became of it. */
export interface CheckAttempt {
  readonly target: string;
  readonly paid: Paid;
  /** Not counted: a target the configuration allows on purpose (loopback in local mode). */
  readonly exempt?: boolean;
}

/** Egress stages at which a refusal means the destination itself was refused, before any connection. */
const DESTINATION_STAGES: ReadonlySet<string> = new Set(["url", "dns"]);

/**
 * The outcome of a check from the attempts it made, judged against the expected code. Every counted
 * attempt must be refused with it; for the private-address check, also before any connection (stage
 * `url` or `dns`), so a target the relay reached or tried to reach never passes.
 */
export function checkOutcome(check: CheckId, attempts: readonly CheckAttempt[]): Outcome {
  const expected = CHECK_EXPECTED_CODES[check];
  const counted = attempts.filter((attempt) => attempt.exempt !== true);
  const destination = check === "private-address";
  const matches = (attempt: CheckAttempt): boolean => {
    if (attempt.paid.ok) return false;
    const coded = codedError(attempt.paid.error);
    if (coded.code !== expected) return false;
    if (!destination) return true;
    const stage = str(coded.details, "stage");
    return stage !== undefined && DESTINATION_STAGES.has(stage);
  };
  // A check that pays one target judges its last attempt (the session check pays once first).
  const judged = destination ? counted : counted.slice(-1);
  const first = judged[0];
  if (first !== undefined && judged.every(matches) && !first.paid.ok) {
    return { status: "refused", code: expected, reason: codedError(first.paid.error).reason };
  }
  const answered = judged.find((attempt) => attempt.paid.ok);
  if (answered !== undefined && answered.paid.ok) {
    const { result } = answered.paid;
    return {
      status: "error",
      code: clientError("playground_unexpected_error").code,
      reason: result.paid
        ? `The check expected ${expected}, but the payment to ${answered.target} went through.`
        : `The check expected ${expected}, but ${answered.target} answered ${String(
            result.response.kind === "http" ? result.response.status : "a tool result",
          )} without asking for payment; nothing was paid.`,
    };
  }
  const other = judged.find((attempt) => !matches(attempt));
  if (other !== undefined && !other.paid.ok) {
    const coded = codedError(other.paid.error);
    if (coded.code === expected) {
      return {
        status: "error",
        code: clientError("playground_unexpected_error").code,
        reason: `${other.target} was refused with ${expected} only after the relay tried to connect (stage ${
          str(coded.details, "stage") ?? "unknown"
        }), not before.`,
      };
    }
    return outcomeOf(other.paid.error, coded);
  }
  return {
    status: "error",
    code: clientError("playground_unexpected_error").code,
    reason: `The check expected ${expected}, but made no payment attempt.`,
  };
}

/** A string at a path of sanitized details. */
function str(details: JsonValue | undefined, key: string): string | undefined {
  if (details === null || typeof details !== "object" || Array.isArray(details)) return undefined;
  const value = (details as Readonly<Record<string, JsonValue>>)[key];
  return typeof value === "string" ? value : undefined;
}

export async function runCheck(context: RunContext, check: CheckId): Promise<Outcome> {
  const { config } = context;
  const lab = (path: string) => new URL(path, config.urls.public).href;
  const attempts: CheckAttempt[] = [];
  const attempt = async (target: string, options?: Parameters<typeof payHttp>[2]): Promise<Paid> => {
    const paid = await payHttp(context, target, options);
    attempts.push({ target, paid });
    return paid;
  };
  switch (check) {
    case "network":
      await attempt(lab(LAB_PATHS.offers.pubnet));
      break;
    case "asset":
      await attempt(lab(LAB_PATHS.offers.asset));
      break;
    case "amount":
      await attempt(lab(LAB_PATHS.offers.zero));
      break;
    case "per-call-cap":
      await attempt(weatherUrl(context), { cap: config.caps.perCallLowPreset });
      break;
    case "recipient": {
      // Read the seller's recipient without paying, then deny exactly that recipient.
      const before = await readBalance(context);
      let payTo: string | undefined;
      try {
        const quote = await context.buyer.quote(
          { kind: "http", url: weatherUrl(context) },
          { maxAmount: money(context), signal: context.run.signal },
        );
        payTo = quote.options[quote.chosen ?? 0]?.payTo;
      } catch (error) {
        attempts.push({ target: weatherUrl(context), paid: { ok: false, error } });
      }
      if (payTo !== undefined) {
        const strict = await context.derive({ policy: { deny: [payTo] } });
        context.judgeWith(strict);
        await attempt(weatherUrl(context), { buyer: strict });
      } else if (attempts.length === 0) {
        await reportBalance(context, before);
        return {
          status: "info",
          reason: "The seller did not ask for payment, so there is no recipient to refuse.",
        };
      }
      break;
    }
    case "session-budget": {
      // Your own window, with its total lowered to what it already holds plus one price: the first
      // payment fits and counts in your budget, the second cannot fit. A window with less than one
      // price left refuses the first payment the same way, before anything is signed.
      const strict = await context.derive({
        policy: {
          perCall: SESSION_CHECK_WINDOW.total,
          sessionTotal: await roomForOnePayment(context, SESSION_CHECK_WINDOW.total),
        },
        session: defaultSession(config),
      });
      context.judgeWith(strict);
      for (const index of [1, 2]) {
        const paid = await attempt(weatherUrl(context), {
          buyer: strict,
          key: `${context.key}-${String(index)}`,
        });
        if (!paid.ok) break;
      }
      return withPaidFirst(checkOutcome(check, attempts), attempts);
    }
    case "private-address":
      for (const target of PRIVATE_ADDRESS_TARGETS) {
        const paid = await payHttp(context, target);
        // Local mode allows loopback on purpose, so that target cannot prove anything there.
        attempts.push({ target, paid, exempt: config.mode === "local" && isLoopbackTarget(target) });
      }
      break;
  }
  return checkOutcome(check, attempts);
}

/** The session check's outcome, naming the transaction of the payment that fit before the refusal. */
function withPaidFirst(outcome: Outcome, attempts: readonly CheckAttempt[]): Outcome {
  const transactions = attempts.flatMap((attempt) =>
    attempt.paid.ok && typeof attempt.paid.result.payment?.transaction === "string"
      ? [attempt.paid.result.payment.transaction]
      : [],
  );
  return transactions.length === 0 ? outcome : { ...outcome, transactions };
}

/**
 * A session total that leaves room for one payment of `price` in your default window: what the window
 * already holds (spent and pending) plus the price, never above the total that applies now.
 */
async function roomForOnePayment(context: RunContext, price: string): Promise<string> {
  const { decimals, contract } = context.config.asset;
  const budget = (await context.buyer.budget()).assets.find((asset) => asset.contract === contract);
  const used =
    (toAtomic(budget?.spent ?? "0", decimals) ?? 0n) + (toAtomic(budget?.pending ?? "0", decimals) ?? 0n);
  const cap = toAtomic(budget?.sessionCap ?? price, decimals) ?? 0n;
  const wanted = used + (toAtomic(price, decimals) ?? 0n);
  return toDecimal(wanted < cap ? wanted : cap, decimals);
}

/** Whether a check target names a loopback address. */
function isLoopbackTarget(target: string): boolean {
  const host = new URL(target).hostname.replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127\./.test(host);
}
