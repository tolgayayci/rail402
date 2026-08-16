import { randomUUID } from "node:crypto";
import { Keypair, rpc } from "@stellar/stellar-sdk";
import { uptoContractFor } from "@rail402.dev/scheme-upto-stellar";
import { NETWORK, RPC_URL } from "../config.js";
import type { PlaygroundConfig } from "../config.js";
import {
  addPolicyRule,
  deployAccount,
  readBudgetSpent,
  setSpendingLimit,
  X402_POLICY,
  OZ_ED25519_VERIFIER,
  type SmartAccountConfig,
} from "../agent/smart-account.js";
import {
  exactTransferOp,
  fundContractWithUsdc,
  payThroughFacilitator,
  uptoSettleOp,
  type PayResult,
} from "../agent/pay.js";

/**
 * The C-Account Policy Lab — a self-contained sandbox for OpenZeppelin smart-account spending
 * policies, in an x402 context.
 *
 * It is deliberately independent of the other playground scenes: it needs no browser session
 * wallet. A user configures a budget, and we deploy a REAL OpenZeppelin smart account to testnet
 * with that policy, funded from the operator's dispenser wallet. The user then runs payments
 * against it and watches the chain — the account's own spending policy — allow, refuse, and (for
 * `upto`) refund, all on-ledger. Raising the limit is a real `set_spending_limit` call the account
 * owner authorizes, so "over budget → raise it → retry" is a genuine on-ledger change.
 *
 * What is fixed: the ONE policy contract type (a rolling spending budget). What is configurable:
 * the limit, the rolling window, and — through the two-rule layout the account carries — the fact
 * that `exact` and `upto` are budgeted separately, which the lab surfaces rather than hides.
 *
 * A smart-account operation is slow (several Soroban transactions), so deployment is a background
 * job the caller polls; payments and limit changes are awaited directly.
 */

const MAX_TIMEOUT_SECONDS = 60;
const AUTH_LEDGERS = Math.ceil(MAX_TIMEOUT_SECONDS / 5);
/** Default rolling window: ~8 min at 5s ledgers. Short enough that spending visibly ages out. */
export const DEFAULT_PERIOD_LEDGERS = 100;
export const MIN_PERIOD_LEDGERS = 20;
export const MAX_PERIOD_LEDGERS = 17_280; // ~24h
/** Cap the budget so a lab session cannot drain the dispenser. Amounts here are demonstrative. */
export const MAX_LIMIT_STROOPS = 3_000_000n; // 0.3 USDC
export const MIN_LIMIT_STROOPS = 500_000n; // 0.05 USDC
/**
 * Ceiling on a single test payment. An OVER-budget payment must still be funded, so the account's
 * own POLICY — not an insufficient balance — is what refuses it, which is the only way the chain
 * returns the clean `account_policy_refused` code instead of a raw balance error at client
 * simulation. That means an over-budget attempt parks its amount in the account, so it is capped.
 */
export const MAX_PAY_STROOPS = 9_000_000n; // 0.9 USDC

export type LabStatus = "deploying" | "ready" | "failed";

export interface LabEvent {
  readonly seq: number;
  readonly message: string;
}

export interface RuleBudget {
  readonly ruleId: number;
  readonly name: string;
  readonly scheme: "exact" | "upto";
  readonly spentStroops: string;
  readonly limitStroops: string;
}

export interface LabState {
  readonly id: string;
  readonly status: LabStatus;
  readonly account: string | undefined;
  readonly sessionKey: string | undefined;
  readonly periodLedgers: number;
  readonly usdc: { readonly code: string; readonly sac: string };
  readonly rules: readonly RuleBudget[];
  readonly events: readonly LabEvent[];
  readonly error: string | undefined;
}

export interface PayOutcome {
  readonly allowed: boolean;
  readonly scheme: "exact" | "upto";
  readonly code: string | undefined;
  readonly reason: string;
  readonly transaction: string | undefined;
  readonly explorerUrl: string | undefined;
  /** For upto: the unused ceiling refunded to the budget. */
  readonly refundStroops: string | undefined;
  readonly rules: readonly RuleBudget[];
}

interface LabSession {
  id: string;
  status: LabStatus;
  account: string | undefined;
  session: Keypair;
  tokenRule: number | undefined;
  settleRule: number | undefined;
  periodLedgers: number;
  /** Per-rule limits, mirrored in memory so the lab can size funding without on-chain reads. */
  tokenLimit: bigint;
  settleLimit: bigint;
  fundedStroops: bigint;
  spentStroops: bigint;
  events: LabEvent[];
  error: string | undefined;
  seq: number;
  createdAt: number;
}

const MAX_SESSIONS = 200;

export interface LabDeps {
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly serverImpl?: rpc.Server;
}

const txUrl = (hash: string) => `https://stellar.expert/explorer/testnet/tx/${hash}`;

export function createLabStore(config: PlaygroundConfig, deps: LabDeps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const server = deps.serverImpl ?? new rpc.Server(RPC_URL);
  const smartConfig: SmartAccountConfig = { server, verifier: OZ_ED25519_VERIFIER, policy: X402_POLICY };
  const funder = config.dispenser;
  const seller = funder.publicKey();
  const usdcSac = config.usdc.sac;
  const uptoContract = uptoContractFor(NETWORK)!;

  const sessions = new Map<string, LabSession>();

  const emit = (s: LabSession, message: string) => s.events.push({ seq: s.seq++, message });

  /** Keep the account funded so any WITHIN-budget payment can settle. Over-budget attempts are
   *  refused by the policy before any transfer, so they never need funding. */
  async function ensureBalance(s: LabSession, targetStroops: bigint): Promise<void> {
    if (!s.account) return;
    const balance = s.fundedStroops - s.spentStroops;
    if (balance >= targetStroops) return;
    const topUp = targetStroops - balance;
    await fundContractWithUsdc({ server, funder, usdcSac, account: s.account, amountStroops: topUp });
    s.fundedStroops += topUp;
  }

  async function readRules(s: LabSession): Promise<RuleBudget[]> {
    if (s.account === undefined || s.tokenRule === undefined || s.settleRule === undefined) return [];
    const [token, settle] = await Promise.all([
      readBudgetSpent(smartConfig, { source: funder, account: s.account, ruleId: s.tokenRule }),
      readBudgetSpent(smartConfig, { source: funder, account: s.account, ruleId: s.settleRule }),
    ]);
    return [
      { ruleId: s.tokenRule, name: "token-payments", scheme: "exact", spentStroops: token.totalSpent.toString(), limitStroops: token.spendingLimit.toString() },
      { ruleId: s.settleRule, name: "upto-settle", scheme: "upto", spentStroops: settle.totalSpent.toString(), limitStroops: settle.spendingLimit.toString() },
    ];
  }

  function snapshot(s: LabSession, rules: readonly RuleBudget[] = []): LabState {
    return {
      id: s.id,
      status: s.status,
      account: s.account,
      sessionKey: s.session.publicKey(),
      periodLedgers: s.periodLedgers,
      usdc: { code: config.usdc.code, sac: usdcSac },
      rules,
      events: s.events,
      error: s.error,
    };
  }

  function evict(): void {
    while (sessions.size >= MAX_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest === undefined) break;
      sessions.delete(oldest);
    }
  }

  /** Start deploying a smart account with the given budget. Returns immediately; poll `get`. */
  function deploy(input: { limitStroops: bigint; periodLedgers: number }): { labId: string } {
    evict();
    const id = randomUUID();
    const s: LabSession = {
      id,
      status: "deploying",
      account: undefined,
      session: Keypair.random(),
      tokenRule: undefined,
      settleRule: undefined,
      periodLedgers: input.periodLedgers,
      tokenLimit: input.limitStroops,
      settleLimit: input.limitStroops,
      fundedStroops: 0n,
      spentStroops: 0n,
      events: [],
      error: undefined,
      seq: 0,
      createdAt: now(),
    };
    sessions.set(id, s);

    void (async () => {
      try {
        emit(s, "Deploying a real OpenZeppelin smart account (your key signs; the operator wallet pays the fees)…");
        s.account = await deployAccount(smartConfig, { source: funder, session: s.session });
        emit(s, `Account deployed: ${s.account}`);

        emit(s, `Attaching the spending policy at a limit of ${display(input.limitStroops)} USDC over a ${input.periodLedgers}-ledger window…`);
        s.settleRule = await addPolicyRule(smartConfig, {
          source: funder, account: s.account, session: s.session,
          target: uptoContract, name: "upto-settle", budgetStroops: input.limitStroops, periodLedgers: input.periodLedgers,
        });
        s.tokenRule = await addPolicyRule(smartConfig, {
          source: funder, account: s.account, session: s.session,
          target: usdcSac, name: "token-payments", budgetStroops: input.limitStroops, periodLedgers: input.periodLedgers,
        });
        emit(s, `Two rules attached: rule ${s.tokenRule} budgets exact payments, rule ${s.settleRule} budgets upto payments (policies are per-rule).`);

        // Fund so both rules can be fully exercised within budget.
        emit(s, "Funding the account so within-budget payments can settle…");
        await ensureBalance(s, s.tokenLimit + s.settleLimit);

        s.status = "ready";
        emit(s, "Ready. Run payments against the policy, or change the limit and retry.");
      } catch (err) {
        s.status = "failed";
        s.error = err instanceof Error ? err.message : String(err);
        emit(s, `Deployment failed: ${s.error}. Testnet may be congested — start a new lab.`);
      }
    })();

    return { labId: id };
  }

  async function get(labId: string): Promise<LabState | undefined> {
    const s = sessions.get(labId);
    if (!s) return undefined;
    // Only read on-ledger budgets once the account is ready (cheap poll while deploying).
    const rules = s.status === "ready" ? await readRules(s) : [];
    return snapshot(s, rules);
  }

  async function pay(
    labId: string,
    input:
      | { scheme: "exact"; amountStroops: bigint }
      | { scheme: "upto"; ceilingStroops: bigint; actualStroops: bigint },
  ): Promise<PayOutcome> {
    const s = requireReady(labId);
    const ruleId = input.scheme === "exact" ? s.tokenRule! : s.settleRule!;
    // Fund up to the ATTEMPTED amount, not just the limit, so that when a payment is over budget the
    // POLICY is what refuses it (returning the coded `account_policy_refused`), rather than an
    // insufficient balance failing at client simulation with a raw error. The extra parks in the
    // account and is reused by a later within-budget payment (e.g. after raising the limit).
    const target = input.scheme === "exact" ? input.amountStroops : input.ceilingStroops;
    await ensureBalance(s, target);

    let result: PayResult;
    let moved = 0n;
    if (input.scheme === "exact") {
      moved = input.amountStroops;
      result = await payThroughFacilitator({
        server, facilitatorUrl: config.facilitatorUrl, fetchImpl,
        accepted: { scheme: "exact", network: NETWORK },
        requirements: exactReq(input.amountStroops),
        call: { source: funder, account: s.account!, session: s.session, verifier: OZ_ED25519_VERIFIER, ruleIds: [ruleId], op: exactTransferOp(usdcSac, s.account!, seller, input.amountStroops) },
      });
    } else {
      moved = input.actualStroops;
      result = await payUpto(s, input.ceilingStroops, input.actualStroops);
    }

    if (result.ok) s.spentStroops += moved;
    const rules = await readRules(s);
    const refund =
      input.scheme === "upto" && result.ok ? (input.ceilingStroops - input.actualStroops).toString() : undefined;

    if (result.ok) {
      return {
        allowed: true, scheme: input.scheme, code: undefined,
        reason: input.scheme === "upto"
          ? `Allowed. Settled ${display(input.actualStroops)} of a ${display(input.ceilingStroops)} ceiling; the rest was refunded to the budget.`
          : `Allowed. The policy is within budget, so the payment settled.`,
        transaction: result.transaction, explorerUrl: txUrl(result.transaction),
        refundStroops: refund, rules,
      };
    }
    return {
      allowed: false, scheme: input.scheme, code: result.code,
      reason: refuseReason(result),
      transaction: undefined, explorerUrl: undefined, refundStroops: undefined, rules,
    };
  }

  async function setLimit(labId: string, input: { scheme: "exact" | "upto"; limitStroops: bigint }): Promise<LabState> {
    const s = requireReady(labId);
    const ruleId = input.scheme === "exact" ? s.tokenRule! : s.settleRule!;
    await setSpendingLimit(smartConfig, { source: funder, account: s.account!, session: s.session, ruleId, spendingLimitStroops: input.limitStroops });
    if (input.scheme === "exact") s.tokenLimit = input.limitStroops;
    else s.settleLimit = input.limitStroops;
    emit(s, `Changed the ${input.scheme} budget to ${display(input.limitStroops)} USDC (an on-ledger set_spending_limit the account owner authorized).`);
    // Keep funding sufficient for the new limits so a retry is not blocked by balance.
    await ensureBalance(s, s.tokenLimit + s.settleLimit);
    return snapshot(s, await readRules(s));
  }

  function exactReq(amount: bigint) {
    return {
      scheme: "exact", network: NETWORK, amount: amount.toString(), asset: usdcSac, payTo: seller,
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS, extra: { areFeesSponsored: true },
    };
  }

  async function payUpto(s: LabSession, ceiling: bigint, actual: bigint): Promise<PayResult> {
    const { sequence } = await server.getLatestLedger();
    const expirationLedger = sequence + AUTH_LEDGERS;
    const nonce = Buffer.from((() => { const b = new Uint8Array(32); globalThis.crypto.getRandomValues(b); return b; })());
    const accepted = {
      scheme: "upto", network: NETWORK, amount: ceiling.toString(), asset: usdcSac, payTo: seller,
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS, extra: { uptoContract, areFeesSponsored: true },
    };
    return payThroughFacilitator({
      server, facilitatorUrl: config.facilitatorUrl, fetchImpl,
      accepted, requirements: accepted, settleRequirements: { ...accepted, amount: actual.toString() },
      extraPayload: { maxAmount: ceiling.toString(), expirationLedger, nonce: nonce.toString("hex") },
      call: {
        source: funder, account: s.account!, session: s.session, verifier: OZ_ED25519_VERIFIER,
        ruleIds: [s.settleRule!, s.tokenRule!],
        op: uptoSettleOp({ uptoContract, usdcSac, account: s.account!, payTo: seller, ceiling, expirationLedger, nonce, policy: X402_POLICY }),
      },
    });
  }

  function requireReady(labId: string): LabSession {
    const s = sessions.get(labId);
    if (!s) throw new LabError(404, "playground_share_not_found", "No lab session with this id. Start a new one.");
    if (s.status !== "ready") {
      throw new LabError(409, "playground_invalid_request", `The lab is ${s.status}, not ready. Wait for the account to finish deploying.`);
    }
    return s;
  }

  return { deploy, get, pay, setLimit };
}

/** A coded lab failure carrying its HTTP status, mirroring MeterRefusal. */
export class LabError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 502, readonly code: string, message: string) {
    super(message);
  }
}

function refuseReason(result: Exclude<PayResult, { ok: true }>): string {
  if (result.code === "invalid_exact_stellar_payload_account_policy_refused") {
    return "Refused by the account's own spending policy on-ledger — the amount is over budget. Raise the limit and try again.";
  }
  return `Refused at ${result.stage}: ${result.reason}`;
}

function display(stroops: bigint): string {
  const whole = stroops / 10_000_000n;
  const frac = (stroops % 10_000_000n).toString().padStart(7, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
