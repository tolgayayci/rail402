/** The header's status pieces: network, wallet and session budget. */
import type { ReactElement } from "react";
import type { BalancesView, BudgetView, WalletState } from "../engine/types.ts";
import { short, toAtomic } from "../projection/format.ts";

export function NetworkBadge({ network }: { readonly network: string }): ReactElement {
  return (
    <span className="network-badge" data-tone="stellar" title={network}>
      <span className="dot" aria-hidden="true" />
      {network === "stellar:testnet" ? "Stellar testnet" : network}
    </span>
  );
}

export function WalletChip({
  wallet,
  balances,
  symbol,
  expanded,
  onToggle,
  controls,
}: {
  readonly wallet: WalletState;
  readonly balances: BalancesView | null;
  readonly symbol: string;
  /** With a toggle, the chip is the button that opens the wallet panel. */
  readonly expanded?: boolean;
  readonly onToggle?: () => void;
  readonly controls?: string;
}): ReactElement {
  const content = chipContent(wallet, balances, symbol);
  const state = wallet.status;
  const title =
    wallet.status === "ready"
      ? wallet.address
      : wallet.status === "locked"
        ? "The wallet is open in another tab."
        : undefined;
  if (onToggle === undefined) {
    return (
      <span className="wallet-chip" data-state={state} title={title} aria-busy={state === "loading"}>
        {content}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="wallet-chip"
      data-state={state}
      title={title}
      aria-expanded={expanded === true}
      aria-controls={controls}
      aria-busy={state === "loading"}
      onClick={onToggle}
    >
      {content}
    </button>
  );
}

function chipContent(wallet: WalletState, balances: BalancesView | null, symbol: string): ReactElement {
  switch (wallet.status) {
    case "loading":
      return <>Loading wallet…</>;
    case "none":
      return <>Set up a test wallet</>;
    case "locked":
      return <>Wallet in another tab</>;
    case "ready":
      return (
        <>
          <span className="avatar" data-tone="you" aria-hidden="true" />
          <span className="mono">{short(wallet.address)}</span>
          <span className="wallet-balance">
            {balances?.asset === null || balances === null
              ? wallet.setup.trustline
                ? `0 ${symbol}`
                : `no ${symbol} yet`
              : `${balances.asset} ${symbol}`}
          </span>
        </>
      );
  }
}

/** What share of the session budget is spent and held, for the meter. */
export function budgetShares(budget: BudgetView): { readonly spent: number; readonly pending: number } {
  const total = toAtomic(budget.sessionCap, 18);
  const spent = toAtomic(budget.spent, 18);
  const pending = toAtomic(budget.pending, 18);
  if (total === undefined || total <= 0n || spent === undefined || pending === undefined)
    return { spent: 0, pending: 0 };
  const share = (part: bigint): number => Math.min(1, Math.max(0, Number((part * 10_000n) / total) / 10_000));
  const spentShare = share(spent);
  return { spent: spentShare, pending: Math.min(1 - spentShare, share(pending)) };
}

export function BudgetMeter({
  budget,
  symbol,
}: {
  readonly budget: BudgetView | null;
  readonly symbol: string;
}): ReactElement | null {
  if (budget === null) return null;
  const shares = budgetShares(budget);
  const label = `Session budget: ${budget.spent} spent, ${budget.pending} held, ${budget.remaining} of ${budget.sessionCap} ${symbol} left`;
  return (
    <span className="budget" title={`Budget window ends ${budget.expiresAt}`}>
      <span
        className="budget-bar"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={shares.spent + shares.pending}
      >
        <span className="budget-spent" style={{ width: `${String(shares.spent * 100)}%` }} />
        <span className="budget-pending" style={{ width: `${String(shares.pending * 100)}%` }} />
      </span>
      <span className="budget-text">
        <span className="mono">{budget.remaining}</span> of {budget.sessionCap} {symbol} left
        {budget.awaitingProof > 0 ? ` · ${String(budget.awaitingProof)} awaiting proof` : ""}
      </span>
    </span>
  );
}
