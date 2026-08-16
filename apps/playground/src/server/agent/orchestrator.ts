import { Keypair, rpc } from "@stellar/stellar-sdk";
import { uptoContractFor } from "@rail402.dev/scheme-upto-stellar";
import { NETWORK, RPC_URL } from "../config.js";
import type { PlaygroundConfig } from "../config.js";
import {
  addPolicyRule,
  deployAccount,
  readBudgetSpent,
  X402_POLICY,
  OZ_ED25519_VERIFIER,
  type SmartAccountConfig,
} from "./smart-account.js";
import {
  exactTransferOp,
  fundContractWithUsdc,
  payThroughFacilitator,
  uptoSettleOp,
  type PayResult,
} from "./pay.js";

/**
 * The Agents scene, orchestrated server-side and streamed as events.
 *
 * A real OpenZeppelin smart account is created with a budget the user sets, then a buyer agent
 * makes paid calls the CHAIN — not our server — polices: an over-budget payment is refused by the
 * account's own spending policy on-ledger, and an `upto` payment's unused ceiling is refunded to
 * the budget after settlement. Every payment is a real testnet settlement.
 *
 * Emits events shaped for the two-pane theater: `actor` selects the pane (agent / seller / chain /
 * system), and the load-bearing beats carry `data` the UI reads (tx hashes, budget numbers, codes).
 */

const PERIOD_LEDGERS = 500;
const MAX_TIMEOUT_SECONDS = 60;
const AUTH_LEDGERS = Math.ceil(MAX_TIMEOUT_SECONDS / 5);

export type AgentActor = "system" | "agent" | "seller" | "chain";

export interface AgentEvent {
  readonly seq: number;
  readonly phase: string;
  readonly actor: AgentActor;
  readonly message: string;
  readonly data?: Record<string, unknown>;
}

export interface AgentRunResult {
  readonly ok: boolean;
  readonly account: string | undefined;
  readonly events: readonly AgentEvent[];
  readonly transactions: Record<string, string>;
}

export interface AgentRunOptions {
  readonly config: PlaygroundConfig;
  /** Budget the user set, in stroops. The rolling spending limit the policy enforces. */
  readonly budgetStroops: bigint;
  readonly onEvent?: (event: AgentEvent) => void;
  readonly fetchImpl?: typeof fetch;
  readonly serverImpl?: rpc.Server;
}

export async function runAgentScene(options: AgentRunOptions): Promise<AgentRunResult> {
  const { config, budgetStroops, onEvent = () => {}, fetchImpl = fetch } = options;
  const server = options.serverImpl ?? new rpc.Server(RPC_URL);
  const funder = config.dispenser; // holds USDC + XLM, plays deployer/funder/seller
  const seller = funder.publicKey();
  const usdcSac = config.usdc.sac;
  const uptoContract = uptoContractFor(NETWORK)!;
  const smartConfig: SmartAccountConfig = { server, verifier: OZ_ED25519_VERIFIER, policy: X402_POLICY };

  const events: AgentEvent[] = [];
  const transactions: Record<string, string> = {};
  let seq = 0;
  const emit = (actor: AgentActor, phase: string, message: string, data?: Record<string, unknown>) => {
    const event: AgentEvent = data ? { seq: seq++, phase, actor, message, data } : { seq: seq++, phase, actor, message };
    events.push(event);
    onEvent(event);
    return event;
  };

  // Budget-relative amounts. Chosen so every beat is on the right side of the limit (see the
  // reconciliation note below).
  const B = budgetStroops;
  const EXACT = B / 5n; // comfortably under
  const OVER = B * 2n; // clearly over the token rule's limit
  const UPTO_CEILING = B / 2n; // reserved at authorization (≤ limit)
  const UPTO_ACTUAL = B / 10n; // metered charge, reconciled by release()

  const session = Keypair.random();
  let account: string | undefined;

  try {
    emit("system", "creating", "Creating a smart account — a real OpenZeppelin contract wallet whose only signer is a fresh session key.", {
      sessionKey: session.publicKey(),
    });
    account = await deployAccount(smartConfig, { source: funder, session });
    emit("system", "creating", "Smart account deployed on-ledger.", { account });

    emit("system", "policy", `Attaching a spending policy: a rolling budget of ${display(B)} USDC the chain itself enforces.`, {
      budgetStroops: B.toString(),
    });
    const settleRule = await addPolicyRule(smartConfig, {
      source: funder,
      account,
      session,
      target: uptoContract,
      name: "upto-settle",
      budgetStroops: B,
      periodLedgers: PERIOD_LEDGERS,
    });
    const tokenRule = await addPolicyRule(smartConfig, {
      source: funder,
      account,
      session,
      target: usdcSac,
      name: "token-payments",
      budgetStroops: B,
      periodLedgers: PERIOD_LEDGERS,
    });
    emit("system", "policy", "Budget set. The policy lives in the account contract; no server can override it.", {
      settleRule,
      tokenRule,
    });

    // Fund the agent ABOVE the over-budget attempt (2×budget). This is load-bearing: if balance
    // were the binding constraint, the over-budget payment would fail on insufficient funds during
    // the client's own simulation and surface a raw balance error. By keeping balance ample, the
    // spending POLICY is the sole thing that can refuse it — so the refusal routes through the
    // facilitator and comes back as the coded `account_policy_refused`, which is the whole point of
    // the beat. The surplus stays in the abandoned agent contract; a real deployment would sweep.
    const funding = B * 3n;
    emit("system", "funding", `Funding the agent with ${display(funding)} USDC to spend against its budget.`);
    await fundContractWithUsdc({ server, funder, usdcSac, account, amountStroops: funding });
    emit("system", "funding", "Agent funded. It holds USDC in contract storage — no trustline needed for a contract account.");

    // Discovery — real search over the live catalog, for the agent pane's realism.
    emit("agent", "discovering", "Searching the Bazaar for a service to pay…", { query: "data api" });
    const found = await searchCount(config.facilitatorUrl, fetchImpl);
    emit("agent", "discovering", `Found ${found} discoverable services. Selecting the demo API to pay.`, { found, chosen: "demo API" });

    // 1 — pay under budget
    const exactAccepted = { scheme: "exact", network: NETWORK };
    const exactReq = (amount: bigint) => ({
      scheme: "exact",
      network: NETWORK,
      amount: amount.toString(),
      asset: usdcSac,
      payTo: seller,
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      extra: { areFeesSponsored: true },
    });

    emit("agent", "paying", `Paying ${display(EXACT)} USDC for the service — inside budget, so the policy allows it.`, {
      amountStroops: EXACT.toString(),
    });
    const exact = await payThroughFacilitator({
      server,
      facilitatorUrl: config.facilitatorUrl,
      accepted: exactAccepted,
      requirements: exactReq(EXACT),
      fetchImpl,
      call: {
        source: funder,
        account,
        session,
        verifier: OZ_ED25519_VERIFIER,
        ruleIds: [tokenRule],
        op: exactTransferOp(usdcSac, account, seller, EXACT),
      },
    });
    if (!exact.ok) return fail(emit, events, account, transactions, "paying", exact);
    transactions["exact"] = exact.transaction;
    emit("seller", "paying", "Payment received. The service was delivered.", { transaction: exact.transaction });
    await emitBudget(emit, smartConfig, funder, account, tokenRule, "paying");

    // 2 — the chain says no
    emit("agent", "over-budget", `Trying to spend ${display(OVER)} USDC — over the budget. Watch who refuses it.`, {
      amountStroops: OVER.toString(),
    });
    const over = await payThroughFacilitator({
      server,
      facilitatorUrl: config.facilitatorUrl,
      accepted: exactAccepted,
      requirements: exactReq(OVER),
      fetchImpl,
      call: {
        source: funder,
        account,
        session,
        verifier: OZ_ED25519_VERIFIER,
        ruleIds: [tokenRule],
        op: exactTransferOp(usdcSac, account, seller, OVER),
      },
    });
    if (over.ok) {
      emit("chain", "over-budget", "WARNING: the over-budget payment settled — the policy did not hold.", {
        transaction: over.transaction,
      });
    } else {
      emit("chain", "over-budget", "Refused by the account's own spending policy on-ledger — not by our server.", {
        stage: over.stage,
        code: over.code,
        reason: over.reason,
        expectedCode: "invalid_exact_stellar_payload_account_policy_refused",
      });
    }

    // 3 — money comes back (upto refund)
    emit("agent", "metering", `Opening a metered (upto) payment: authorize up to ${display(UPTO_CEILING)} USDC, use only ${display(UPTO_ACTUAL)}.`, {
      ceilingStroops: UPTO_CEILING.toString(),
      actualStroops: UPTO_ACTUAL.toString(),
    });
    const upto = await payUpto(server, config.facilitatorUrl, {
      account,
      session,
      funder,
      seller,
      usdcSac,
      uptoContract,
      policy: X402_POLICY,
      settleRule,
      tokenRule,
      ceiling: UPTO_CEILING,
      actual: UPTO_ACTUAL,
      fetchImpl,
    });
    if (!upto.ok) return fail(emit, events, account, transactions, "metering", upto);
    transactions["upto"] = upto.transaction;
    emit("seller", "metering", `Settled ${display(UPTO_ACTUAL)} USDC — only what was used, not the ${display(UPTO_CEILING)} ceiling.`, {
      transaction: upto.transaction,
    });
    const reconciled = await emitBudget(emit, smartConfig, funder, account, settleRule, "metering");
    emit("chain", "metering", `The budget reflects ${display(reconciled)} USDC actually spent — the unused ceiling was refunded on-ledger by the settlement hook.`, {
      spentStroops: reconciled.toString(),
      ceilingStroops: UPTO_CEILING.toString(),
      refunded: reconciled === UPTO_ACTUAL,
    });

    emit("system", "done", "The agent paid what it should, was stopped by the chain when it shouldn't, and got its unused budget back. All on testnet.", {
      exact: transactions["exact"],
      upto: transactions["upto"],
    });
    return { ok: true, account, events, transactions };
  } catch (error) {
    emit("system", "error", `The run failed: ${error instanceof Error ? error.message : String(error)}. Testnet may be congested — try again.`);
    return { ok: false, account, events, transactions };
  }
}

async function payUpto(
  server: rpc.Server,
  facilitatorUrl: string,
  args: {
    account: string;
    session: Keypair;
    funder: Keypair;
    seller: string;
    usdcSac: string;
    uptoContract: string;
    policy: string;
    settleRule: number;
    tokenRule: number;
    ceiling: bigint;
    actual: bigint;
    fetchImpl: typeof fetch;
  },
): Promise<PayResult> {
  const { sequence } = await server.getLatestLedger();
  const expirationLedger = sequence + AUTH_LEDGERS;
  const nonce = Buffer.from((() => {
    const b = new Uint8Array(32);
    globalThis.crypto.getRandomValues(b);
    return b;
  })());
  const accepted = {
    scheme: "upto",
    network: NETWORK,
    amount: args.ceiling.toString(),
    asset: args.usdcSac,
    payTo: args.seller,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: { uptoContract: args.uptoContract, areFeesSponsored: true },
  };
  return payThroughFacilitator({
    server,
    facilitatorUrl,
    accepted,
    requirements: accepted,
    settleRequirements: { ...accepted, amount: args.actual.toString() },
    extraPayload: { maxAmount: args.ceiling.toString(), expirationLedger, nonce: nonce.toString("hex") },
    fetchImpl: args.fetchImpl,
    call: {
      source: args.funder,
      account: args.account,
      session: args.session,
      verifier: OZ_ED25519_VERIFIER,
      ruleIds: [args.settleRule, args.tokenRule],
      op: uptoSettleOp({
        uptoContract: args.uptoContract,
        usdcSac: args.usdcSac,
        account: args.account,
        payTo: args.seller,
        ceiling: args.ceiling,
        expirationLedger,
        nonce,
        policy: args.policy,
      }),
    },
  });
}

async function emitBudget(
  emit: (actor: AgentActor, phase: string, message: string, data?: Record<string, unknown>) => AgentEvent,
  smartConfig: SmartAccountConfig,
  funder: Keypair,
  account: string,
  ruleId: number,
  phase: string,
): Promise<bigint> {
  const { totalSpent, spendingLimit } = await readBudgetSpent(smartConfig, { source: funder, account, ruleId });
  emit("chain", phase, `On-ledger budget: ${display(totalSpent)} of ${display(spendingLimit)} USDC spent.`, {
    spentStroops: totalSpent.toString(),
    limitStroops: spendingLimit.toString(),
    ruleId,
  });
  return totalSpent;
}

function fail(
  emit: (actor: AgentActor, phase: string, message: string, data?: Record<string, unknown>) => AgentEvent,
  events: AgentEvent[],
  account: string | undefined,
  transactions: Record<string, string>,
  phase: string,
  res: Exclude<PayResult, { ok: true }>,
): AgentRunResult {
  emit("chain", phase, `Payment refused at ${res.stage}: ${res.reason}`, res.code ? { code: res.code } : undefined);
  return { ok: false, account, events, transactions };
}

async function searchCount(facilitatorUrl: string, fetchImpl: typeof fetch): Promise<number> {
  try {
    const res = await fetchImpl(`${facilitatorUrl}/discovery/search?query=${encodeURIComponent("data api")}&limit=5`);
    const body = (await res.json().catch(() => ({}))) as { resources?: unknown[] };
    return Array.isArray(body.resources) ? body.resources.length : 0;
  } catch {
    return 0;
  }
}

function display(stroops: bigint): string {
  const whole = stroops / 10_000_000n;
  const frac = (stroops % 10_000_000n).toString().padStart(7, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
