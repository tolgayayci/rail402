import {
  DEFAULT_SESSION,
  toDecimal,
  windowSpecFor,
  type BudgetWindow,
  type SpendLedger,
} from "@rail402.dev/sdk";
import { booleanFlag } from "../args.ts";
import { usage } from "../codes.ts";
import type { CommandHandler, CommandInput, CommandOutcome } from "../command.ts";
import { fields } from "../output.ts";
import type { OpenedBuyer } from "../runtime.ts";
import { budgetLines, withBuyer } from "./common.ts";

/**
 * `rail402 session show|list|start|end|reconcile`: budget windows of the configured key in the shared
 * SQLite ledger. The session is `--name` (default "default", a 24 h window that renews itself); a
 * named session started here runs for `--ttl` and does not renew. The caps that apply are always the
 * lower of the session's own and the configured ones.
 */
export const session: CommandHandler = {
  pays: false,
  run: (input) =>
    withBuyer(input, { signer: true, requireSigner: true }, async (opened) => {
      const { subcommand } = input.parsed;
      if (subcommand === "show") {
        const name = input.context.agent.session.name;
        const known = opened.ledger
          .listWindows(opened.buyer.network, opened.buyer.address ?? "")
          .some((window) => window.name === name);
        // Showing never creates a named session; only the default one opens on first use.
        if (!known && name !== DEFAULT_SESSION.name) throw usage(`No session named "${name}" exists.`);
        return show(opened);
      }
      if (subcommand === "list") return list(opened);
      if (subcommand === "start") return start(input, opened);
      if (subcommand === "end") return end(input, opened);
      return reconcileNow(opened);
    }),
};

async function show({ buyer }: OpenedBuyer): Promise<CommandOutcome> {
  const budget = await buyer.budget();
  return {
    result: budget,
    human: () =>
      [
        fields([
          ["session", budget.session],
          ["payer", budget.payer],
          ["network", budget.network],
          ["window", `${budget.startedAt} to ${budget.expiresAt}${budget.autoRenew ? " (renews)" : ""}`],
          ["awaiting proof", budget.awaitingProof === 0 ? undefined : String(budget.awaitingProof)],
          ["false claims", budget.falseClaims === 0 ? undefined : String(budget.falseClaims)],
        ]),
        "budget:",
        ...budgetLines(budget),
      ].join("\n"),
  };
}

function list({ buyer, ledger }: OpenedBuyer): Promise<CommandOutcome> {
  const payer = buyer.address ?? "";
  const now = Date.now();
  const windows = ledger
    .listWindows(buyer.network, payer)
    .map((window) => windowView(ledger, window, buyer.policy.assets, now));
  return Promise.resolve({
    result: { payer, network: buyer.network, windows },
    human: () =>
      windows.length === 0
        ? "No budget sessions yet."
        : windows
            .map((window) =>
              [
                `${window.name}  ${window.status}  ${window.startedAt} to ${window.endedAt ?? window.expiresAt}`,
                ...window.assets.map(
                  (asset) =>
                    `  ${asset.asset}: spent ${asset.spent}, pending ${asset.pending} of ${asset.sessionCap}`,
                ),
              ].join("\n"),
            )
            .join("\n"),
  });
}

async function start(input: CommandInput, { buyer, ledger }: OpenedBuyer): Promise<CommandOutcome> {
  const name = input.context.agent.session.name;
  const payer = buyer.address ?? "";
  const ttlMs = input.context.agent.session.ttlMs;
  const open = openWindow(ledger, buyer.network, payer, name);
  if (open !== undefined && !booleanFlag(input.parsed.flags, "force")) {
    throw usage(
      `The session "${name}" is open until ${new Date(open.expiresAt).toISOString()}; add --force to end it and start a new one.`,
    );
  }
  const spec = windowSpecFor(buyer.policy, payer, {
    name,
    ttlMs,
    autoRenew: name === DEFAULT_SESSION.name,
  });
  ledger.startWindow(spec);
  return show({ buyer, ledger, close: () => Promise.resolve() });
}

function end(input: CommandInput, { buyer, ledger }: OpenedBuyer): Promise<CommandOutcome> {
  const name = input.context.agent.session.name;
  const open = openWindow(ledger, buyer.network, buyer.address ?? "", name);
  if (open === undefined) throw usage(`No session named "${name}" is open.`);
  ledger.endWindow(open.id);
  const ended = { session: name, window: open.id, endedAt: new Date().toISOString() };
  return Promise.resolve({
    result: ended,
    human: () =>
      `Ended session "${name}". Payments still pending in it settle or return as the chain proves them (rail402 session reconcile).`,
  });
}

async function reconcileNow({ buyer }: OpenedBuyer): Promise<CommandOutcome> {
  const report = await buyer.reconcile();
  const budget = await buyer.budget();
  return {
    result: { reconcile: report, budget },
    human: () =>
      [
        `checked ${String(report.checked)}: ${String(report.settled)} settled, ${String(report.released)} released, ${String(report.waiting)} waiting for expiry, ${String(report.awaitingProof)} awaiting proof, ${String(report.unprovable)} no longer provable (counted as spent), ${String(report.deferred)} deferred`,
        `budget (session ${budget.session}):`,
        ...budgetLines(budget),
      ].join("\n"),
  };
}

function openWindow(
  ledger: SpendLedger,
  network: BudgetWindow["network"],
  payer: string,
  name: string,
  now = Date.now(),
): BudgetWindow | undefined {
  return ledger
    .listWindows(network, payer)
    .find((window) => window.name === name && window.endedAt === undefined && now < window.expiresAt);
}

interface AssetInfo {
  readonly contract: string;
  readonly symbol: string;
}

function windowView(ledger: SpendLedger, window: BudgetWindow, assets: readonly AssetInfo[], now: number) {
  const usageOf = ledger.usage(window.id);
  const status = window.endedAt !== undefined ? "ended" : now >= window.expiresAt ? "expired" : "open";
  return {
    id: window.id,
    name: window.name,
    status,
    startedAt: new Date(window.startedAt).toISOString(),
    expiresAt: new Date(window.expiresAt).toISOString(),
    endedAt: window.endedAt === undefined ? null : new Date(window.endedAt).toISOString(),
    autoRenew: window.autoRenew,
    assets: Object.entries(window.caps).map(([contract, caps]) => {
      const used = usageOf.assets.get(contract) ?? { spent: 0n, pending: 0n };
      return {
        asset: assets.find((asset) => asset.contract === contract)?.symbol ?? contract,
        contract,
        perCallCap: toDecimal(caps.perCall, caps.decimals),
        sessionCap: toDecimal(caps.total, caps.decimals),
        spent: toDecimal(used.spent, caps.decimals),
        pending: toDecimal(used.pending, caps.decimals),
      };
    }),
    awaitingProof: usageOf.awaitingProof,
  };
}
