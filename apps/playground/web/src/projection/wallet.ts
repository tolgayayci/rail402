/**
 * The wallet's facts, pure: the three setup steps the first-visit dialog shows (a key, Friendbot, test
 * funds; the last two are real testnet transactions), explorer links and balance formatting. The
 * wallet's key never reaches the page; only its address, its setup flags and the hashes of the setup
 * transactions do.
 */
import type { LabEvent } from "../engine/events.ts";
import type { WalletState } from "../engine/types.ts";

export type SetupStepId = "key" | "friendbot" | "usdc";
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
  /** The browser cannot store the key: it lives in this tab only. */
  readonly memory: boolean;
}

/** A setup the page follows: the events of its runs so far, whether it is still going, and why it stopped. */
export interface SetupRun {
  readonly events: readonly LabEvent[];
  readonly status: "running" | "ok" | "failed";
  readonly error?: { readonly code: string } | null;
}

/**
 * The setup step an error code belongs to: Friendbot's own failure, the trustline or the purchase of
 * test funds. Any other failure (the Stellar RPC not answering, for one) is not a step's: it is shown
 * on its own, and no step is marked failed for it.
 */
export function failedStep(code: string | undefined): SetupStepId | undefined {
  if (code === undefined) return undefined;
  if (code === "account_friendbot_failed") return "friendbot";
  if (code === "account_trustline_failed" || code === "account_funding_failed") return "usdc";
  if (code.startsWith("key_") || code === "playground_wallet_storage_unavailable") return "key";
  return undefined;
}

const ORDER: readonly SetupStepId[] = ["key", "friendbot", "usdc"];

/**
 * The three setup steps in order. A step is done when the wallet's setup flags say so or the run
 * reported it; the first open step is live while the setup runs. When the setup stops, the step its
 * error belongs to is marked failed (see failedStep); an error of no step marks none.
 */
export function setupSteps(
  wallet: WalletState,
  run: SetupRun | null,
  context: SetupContext,
): readonly SetupStep[] {
  const flags =
    wallet.status === "ready" ? wallet.setup : { account: false, trustline: false, funded: false };
  const seen = new Map<string, string | null>();
  for (const event of run?.events ?? []) {
    if (event.kind === "wallet") seen.set(event.step, event.transaction ?? null);
  }
  const done: Readonly<Record<SetupStepId, boolean>> = {
    key: wallet.status === "ready" || seen.has("created") || seen.has("imported"),
    friendbot: flags.account || seen.has("friendbot"),
    usdc: flags.funded || seen.has("bought"),
  };
  const transactions: Readonly<Record<SetupStepId, string | null>> = {
    key: null,
    friendbot: seen.get("friendbot") ?? null,
    usdc: seen.get("bought") ?? null,
  };
  const failed = run?.status === "failed" ? failedStep(run.error?.code) : undefined;
  const running = run?.status === "running";
  const firstOpen = ORDER.find((id) => !done[id]);
  return ORDER.map((id) => {
    const state: SetupStepState = done[id]
      ? "done"
      : id === failed
        ? "error"
        : id === firstOpen && running
          ? "live"
          : "pending";
    return { id, ...copy(id, done[id], context), state, transaction: transactions[id] };
  });
}

function copy(
  id: SetupStepId,
  done: boolean,
  context: SetupContext,
): { readonly title: string; readonly detail: string } {
  switch (id) {
    case "key":
      return {
        title: done ? "Key created" : "Creating a key",
        detail: context.memory
          ? "Kept in this tab only: this browser cannot store it"
          : "Encrypted in this browser",
      };
    case "friendbot":
      return {
        title: done ? "Funded with Friendbot" : "Funding with Friendbot",
        detail: "Free testnet XLM so the account exists",
      };
    case "usdc":
      return {
        title: done ? `Test ${context.symbol} added` : `Adding test ${context.symbol}`,
        detail: `A ${context.symbol} trustline and ${context.buyAmount} test ${context.symbol}`,
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

const ACCOUNT = /^G[A-Z2-7]{55}$/;

/**
 * An account link from the same explorer template (its `/tx/{hash}` becomes `/account/<address>`);
 * undefined for anything that is not an account address or a template without that path.
 */
export function accountLink(template: string, address: string): string | undefined {
  if (!ACCOUNT.test(address) || !template.includes("/tx/{hash}")) return undefined;
  const url = template.replace("/tx/{hash}", `/account/${address}`).replaceAll("{network}", "testnet");
  if (!URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "" ? url : undefined;
}
