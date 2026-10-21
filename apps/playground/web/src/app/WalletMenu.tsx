/**
 * The header's wallet pill and the menu it opens: the balance, the full address to copy, more test
 * funds, the account on the explorer, the key file, and a reset that makes a new wallet. The key is
 * never shown; the key file is written by the engine after a confirmation.
 */
import { useEffect, useId, useRef, useState, type ReactElement } from "react";
import type { CodedError, EngineState } from "../engine/types.ts";
import { groupedAmount, short } from "../projection/format.ts";
import { accountLink, setupComplete } from "../projection/wallet.ts";
import { CopyButton } from "../ui/CopyButton.tsx";
import { ExternalIcon, Spinner } from "../ui/icons.tsx";
import { ExternalLink } from "../ui/links.tsx";
import { Notice } from "../ui/Notice.tsx";
import { clientError, toCodedError, useEngine, useEngineState } from "./engine.tsx";
import { Faucet, WALLET_PILL_ID } from "./WalletDialog.tsx";
import { useRuns } from "./runs.tsx";
import { useWalletSetup, type WalletSetup } from "./wallet-setup.tsx";

export function WalletMenu(): ReactElement {
  const state = useEngineState();
  const setup = useWalletSetup();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const { wallet } = state;
  const settingUp = setup.busy && setup.task?.kind !== "topUp";
  const canOpen = (wallet.status === "ready" || wallet.status === "locked") && !settingUp;

  useEffect(() => {
    if (!open) return undefined;
    const away = (event: PointerEvent): void => {
      if (event.target instanceof Node && root.current?.contains(event.target) !== true) setOpen(false);
    };
    // Escape closes the menu wherever focus is: a confirmation that went away leaves it on the page.
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setOpen(false);
      document.getElementById(WALLET_PILL_ID)?.focus();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  useEffect(() => {
    if (!canOpen) setOpen(false);
  }, [canOpen]);

  const close = (): void => {
    setOpen(false);
    document.getElementById(WALLET_PILL_ID)?.focus();
  };

  return (
    <div className="wallet" ref={root}>
      <Pill
        state={state}
        setup={setup}
        settingUp={settingUp}
        expanded={open}
        controls={canOpen ? menuId : undefined}
        onClick={() => {
          if (canOpen) setOpen(!open);
          else if (wallet.status === "none" && !setup.busy) setup.retry();
        }}
      />
      {open ? (
        <div id={menuId} className="wallet-menu" role="dialog" aria-label="Test wallet">
          {wallet.status === "locked" ? (
            <Notice error={clientError("playground_wallet_locked")} tone="info" />
          ) : (
            <MenuBody
              state={state}
              setup={setup}
              onReset={() => {
                close();
                setup.reset();
              }}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}

function Pill({
  state,
  setup,
  settingUp,
  expanded,
  controls,
  onClick,
}: {
  readonly state: EngineState;
  readonly setup: WalletSetup;
  readonly settingUp: boolean;
  readonly expanded: boolean;
  readonly controls: string | undefined;
  readonly onClick: () => void;
}): ReactElement {
  const { config } = useEngine();
  const { heldBalance } = useRuns();
  const { wallet } = state;
  const symbol = config.asset.symbol;
  const busy = wallet.status === "loading" || settingUp;
  let content: ReactElement;
  if (busy) {
    const label =
      wallet.status === "loading"
        ? "Opening wallet…"
        : setup.task?.kind === "reset"
          ? "Resetting wallet…"
          : setup.task?.createsKey === true
            ? "Creating wallet…"
            : "Adding test funds…";
    content = (
      <>
        <Spinner />
        <span>{label}</span>
      </>
    );
  } else if (wallet.status === "ready") {
    content = (
      <>
        <span className="wallet-dot" data-state={dotState(state)} aria-hidden="true" />
        <span className="wallet-pill-address mono">{short(wallet.address)}</span>
        <span className="wallet-pill-balance">
          <PillBalance state={state} held={heldBalance} symbol={symbol} />
        </span>
      </>
    );
  } else if (wallet.status === "locked") {
    content = (
      <>
        <span className="wallet-dot" aria-hidden="true" />
        <span>Open in another tab</span>
      </>
    );
  } else {
    content = <span>Set up a test wallet</span>;
  }
  return (
    <button
      type="button"
      id={WALLET_PILL_ID}
      className="wallet-pill"
      data-status={busy ? "busy" : wallet.status}
      aria-busy={busy}
      aria-expanded={controls === undefined ? undefined : expanded}
      aria-controls={controls}
      aria-label={wallet.status === "ready" && !busy ? `Test wallet ${wallet.address}` : undefined}
      onClick={onClick}
    >
      {content}
    </button>
  );
}

/** The wallet dot: set up, not set up, or not known yet (the chain has not been read). */
function dotState(state: EngineState): "ready" | "setup" | "unknown" {
  if (state.balancesRead !== "ok") return "unknown";
  return setupComplete(state.wallet) ? "ready" : "setup";
}

/**
 * The pill's balance: read from the chain, or held at its value before the run the Lab is playing.
 * Before the first read it says so, and a failed read is never shown as an empty wallet.
 */
function PillBalance({
  state,
  held,
  symbol,
}: {
  readonly state: EngineState;
  readonly held: string | null;
  readonly symbol: string;
}): ReactElement {
  const { balances, balancesRead } = state;
  const amount = held ?? balances?.asset ?? null;
  if (amount !== null) {
    return (
      <>
        <b key={amount} className="wallet-pill-amount">
          {groupedAmount(amount, 4)}
        </b>{" "}
        <span className="muted">{symbol}</span>
      </>
    );
  }
  if (balances === null) {
    return balancesRead === "failed" ? (
      <span className="muted">balance unavailable</span>
    ) : (
      <span className="wallet-pill-reading">
        <span aria-hidden="true">…</span>
        <span className="visually-hidden">reading the balance</span>
      </span>
    );
  }
  return <>no {symbol} yet</>;
}

function MenuBody({
  state,
  setup,
  onReset,
}: {
  readonly state: EngineState;
  readonly setup: WalletSetup;
  readonly onReset: () => void;
}): ReactElement | null {
  const { config } = useEngine();
  const heading = useRef<HTMLHeadingElement>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const { wallet, balances, unfinished } = state;
  useEffect(() => {
    heading.current?.focus();
  }, []);
  if (wallet.status !== "ready") return null;
  const symbol = config.asset.symbol;
  const account = accountLink(config.explorerTemplate, wallet.address);
  const toppingUp = setup.busy && setup.task?.kind === "topUp";
  const topUpTask = setup.task?.kind === "topUp" ? setup.task : null;
  return (
    <>
      <div className="wallet-menu-head">
        <h2 className="eyebrow eyebrow-ink" ref={heading} tabIndex={-1}>
          Test wallet
        </h2>
        <span className="wallet-menu-where">
          {wallet.storage === "memory" ? "this tab only" : "kept in this browser"}
        </span>
      </div>
      <div className="wallet-balance">
        <b className="wallet-balance-amount">
          {balances === null ? "—" : balances.asset === null ? "0" : groupedAmount(balances.asset, 4)}
        </b>
        <span className="muted">{symbol}</span>
        <span className="wallet-balance-xlm">
          {balances === null
            ? state.balancesRead === "failed"
              ? "balance unavailable: the Stellar RPC did not answer"
              : "reading the balance…"
            : balances.xlm === null
              ? "no XLM yet"
              : `${groupedAmount(balances.xlm)} XLM`}
        </span>
      </div>
      {wallet.storage === "memory" ? (
        <p className="wallet-menu-note">
          This browser can&apos;t keep the wallet, so it lasts until you close this tab.
        </p>
      ) : null}
      <div className="address-box">
        <span className="address-text mono" title={wallet.address}>
          {wallet.address}
        </span>
        <CopyButton text={wallet.address} label="Copy address" />
      </div>
      <div className="wallet-menu-actions">
        <button
          type="button"
          className="button button-dark"
          disabled={setup.busy || state.activeRun !== null}
          aria-busy={toppingUp}
          onClick={setup.topUp}
        >
          {toppingUp ? (
            <>
              <Spinner /> Adding…
            </>
          ) : (
            `Add test ${symbol}`
          )}
        </button>
        <ExternalLink className="button button-outline" href={account}>
          stellar.expert <ExternalIcon />
        </ExternalLink>
      </div>
      {topUpTask?.status === "ok" ? (
        <p className="wallet-menu-note" role="status">
          Added {config.onboarding.buyAmount} test {symbol}.
        </p>
      ) : null}
      {topUpTask !== null && topUpTask.error !== null ? <Notice error={topUpTask.error} /> : null}
      {topUpTask?.error?.code === "account_funding_failed" ? <Faucet address={wallet.address} /> : null}
      {unfinished > 0 ? (
        <p className="wallet-menu-note">
          {unfinished === 1 ? "1 payment waits" : `${String(unfinished)} payments wait`} for proof on chain.
          The page checks again every 20 seconds.
        </p>
      ) : null}
      <KeyFile address={wallet.address} />
      <div className="wallet-menu-reset">
        {confirmReset ? (
          <div className="wallet-confirm" role="group" aria-label="Confirm the reset">
            <p>
              This deletes the key from this browser and makes a new wallet. The old account keeps its test
              funds on the testnet.
            </p>
            <div className="wallet-confirm-actions">
              <button type="button" className="button button-danger" disabled={setup.busy} onClick={onReset}>
                Reset wallet
              </button>
              <button
                type="button"
                className="button button-outline"
                onClick={() => {
                  setConfirmReset(false);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            <span className="wallet-menu-hint">
              Reset makes a new wallet. This key is deleted from the browser.
            </span>
            <button
              type="button"
              className="button button-danger"
              disabled={setup.busy || state.activeRun !== null}
              onClick={() => {
                setConfirmReset(true);
              }}
            >
              Reset wallet
            </button>
          </>
        )}
      </div>
    </>
  );
}

/** The key as a file for the CLI, the SDK or an MCP client, after a confirmation that names the risk. */
function KeyFile({ address }: { readonly address: string }): ReactElement {
  const engine = useEngine();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<CodedError | null>(null);
  const download = (): void => {
    setBusy(true);
    setError(null);
    engine.wallet.exportFile().then(
      ({ fileName }) => {
        setBusy(false);
        setConfirm(false);
        setSaved(fileName);
      },
      (reason: unknown) => {
        setBusy(false);
        setError(toCodedError(reason));
      },
    );
  };
  return (
    <div className="wallet-keyfile">
      {confirm ? (
        <div className="wallet-confirm" role="group" aria-label="Confirm the key download">
          <p>
            The file holds the secret key of {short(address)} on the Stellar <strong>testnet</strong>. Anyone
            with it can spend this wallet&apos;s test funds.
          </p>
          <div className="wallet-confirm-actions">
            <button type="button" className="button button-dark" disabled={busy} onClick={download}>
              Download the key file
            </button>
            <button
              type="button"
              className="button button-outline"
              onClick={() => {
                setConfirm(false);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="text-button"
          onClick={() => {
            setSaved(null);
            setConfirm(true);
          }}
        >
          Use this wallet in the CLI: download the key file
        </button>
      )}
      {saved !== null ? (
        <p className="wallet-menu-note" role="status">
          Saved as <span className="mono">{saved}</span>. Import it with{" "}
          <code>rail402 keys import &lt; {saved}</code>, then delete the download.
        </p>
      ) : null}
      {error !== null ? <Notice error={error} /> : null}
    </div>
  );
}
