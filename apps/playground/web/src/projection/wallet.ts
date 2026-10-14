/**
 * The wallet panel's facts, pure: the setup steps (each a real testnet transaction), transaction links
 * and the session-budget form. The wallet's key never reaches the page; only its address, its setup
 * flags and the hashes of the setup transactions do.
 */
import type { LabEvent } from "../engine/events.ts";
import type { CodedError, RunSummary, WalletState } from "../engine/types.ts";
import { compareDecimal, toAtomic, toDecimal } from "./format.ts";

export type SetupStepId = "friendbot" | "trustline" | "bought";
export type SetupStepState = "done" | "live" | "pending" | "error";

export interface SetupStep {
  readonly id: SetupStepId;
  readonly title: string;
  readonly detail: string;
  readonly state: SetupStepState;
  /** The step's transaction hash, when this page load saw it happen. */
  readonly transaction: string | null;
}

export interface SetupContext {
  readonly symbol: string;
  readonly buyAmount: string;
  readonly keepXlm: string;
}

/** A setup run as the panel follows it: its events, and its summary once it ended. */
export interface SetupRun {
  readonly events: readonly LabEvent[];
  readonly summary: RunSummary | null;
}

const ORDER: readonly SetupStepId[] = ["friendbot", "trustline", "bought"];

/**
 * The three setup steps in order. A step is done when the wallet's setup flags say so or the run
 * reported its transaction; the first open step is live while a setup run is going, and failed when
 * that run ended without finishing.
 */
export function setupSteps(
  wallet: WalletState,
  run: SetupRun | null,
  context: SetupContext,
): readonly SetupStep[] {
  const flags =
    wallet.status === "ready" ? wallet.setup : { account: false, trustline: false, funded: false };
  const seen = new Map<SetupStepId, string | null>();
  for (const event of run?.events ?? []) {
    if (event.kind === "wallet" && isSetupStep(event.step)) seen.set(event.step, event.transaction ?? null);
  }
  const doneByFlag: Readonly<Record<SetupStepId, boolean>> = {
    friendbot: flags.account,
    trustline: flags.trustline,
    bought: flags.funded,
  };
  const failed = run?.summary !== null && run?.summary !== undefined && run.summary.status !== "ok";
  const running = run !== null && run.summary === null;
  const firstOpen = ORDER.find((id) => !doneByFlag[id] && !seen.has(id));
  return ORDER.map((id) => {
    const done = doneByFlag[id] || seen.has(id);
    const state: SetupStepState = done
      ? "done"
      : id !== firstOpen
        ? "pending"
        : running
          ? "live"
          : failed
            ? "error"
            : "pending";
    return { id, ...copy(id, context), state, transaction: seen.get(id) ?? null };
  });
}

function isSetupStep(step: string): step is SetupStepId {
  return (ORDER as readonly string[]).includes(step);
}

function copy(id: SetupStepId, context: SetupContext): { readonly title: string; readonly detail: string } {
  switch (id) {
    case "friendbot":
      return {
        title: "Create the account with Friendbot",
        detail: "Friendbot sends test XLM, which opens the account on the testnet.",
      };
    case "trustline":
      return {
        title: `Trust ${context.symbol}`,
        detail: `A trustline lets the account hold ${context.symbol}. Your key signs it; it changes nothing else.`,
      };
    case "bought":
      return {
        title: `Buy ${context.buyAmount} ${context.symbol}`,
        detail: `Swaps test XLM for ${context.symbol} on the testnet exchange, keeping ${context.keepXlm} XLM for reserves and fees.`,
      };
  }
}

/** Whether the wallet can pay: it exists, trusts the asset and holds some. */
export function setupComplete(wallet: WalletState): boolean {
  return wallet.status === "ready" && wallet.setup.account && wallet.setup.trustline && wallet.setup.funded;
}

const HASH = /^[0-9a-f]{64}$/i;

/**
 * A transaction link from the configured explorer template (`{network}` and `{hash}`); undefined for
 * anything that is not a transaction hash or a template that does not give an https URL.
 */
export function explorerLink(template: string, hash: string): string | undefined {
  if (!HASH.test(hash)) return undefined;
  const url = template.replaceAll("{network}", "testnet").replaceAll("{hash}", hash.toLowerCase());
  if (!URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "" ? url : undefined;
}

export type SessionTotalInput =
  { readonly valid: true; readonly value: string } | { readonly valid: false; readonly error: CodedError };

/**
 * Reads the "lower the session budget" field: a positive decimal within the asset's decimals and not
 * above the current total. Raising it is refused here as the engine would refuse it.
 */
export function sessionTotalInput(input: string, current: string, decimals: number): SessionTotalInput {
  const text = input.trim();
  const atomic = /^\d+(\.\d+)?$/.test(text) ? toAtomic(text, decimals) : undefined;
  if (atomic === undefined || atomic <= 0n) {
    return invalid(`Enter a positive amount with at most ${String(decimals)} decimals, such as ${current}.`);
  }
  const value = toDecimal(atomic.toString(), decimals) ?? text;
  if (compareDecimal(value, current, decimals) === 1) {
    return invalid(`The session budget can only be lowered; it is ${current} now.`);
  }
  return { valid: true, value };
}

function invalid(reason: string): SessionTotalInput {
  return { valid: false, error: { code: "playground_request_invalid", reason, retryable: false } };
}
