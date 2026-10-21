/**
 * The setup dialog: shown while the page makes the visitor's test wallet (a key, Friendbot, test
 * funds), one step at a time, then closes on its own. A setup that stops shows its code and reason,
 * with a way to try again; when only the purchase of test funds failed, it points to the faucet.
 */
import { useEffect, useRef, type ReactElement } from "react";
import type { EngineState } from "../engine/types.ts";
import { explorerLink, setupSteps, type SetupStep, type SetupStepState } from "../projection/wallet.ts";
import { CopyButton } from "../ui/CopyButton.tsx";
import { DoneIcon, ExternalIcon, FailedIcon, Spinner } from "../ui/icons.tsx";
import { ExternalLink } from "../ui/links.tsx";
import { Notice } from "../ui/Notice.tsx";
import { useEngine, useEngineState } from "./engine.tsx";
import { useWalletSetup, type WalletTask } from "./wallet-setup.tsx";

export const WALLET_PILL_ID = "wallet-pill";

const STATE_TEXT: Readonly<Record<SetupStepState, string>> = {
  done: "done",
  live: "in progress",
  pending: "to do",
  error: "failed",
};

export function WalletDialog(): ReactElement | null {
  const setup = useWalletSetup();
  const state = useEngineState();
  const { task } = setup;
  if (!setup.dialogOpen || task === null) return null;
  return <SetupDialog task={task} state={state} onClose={setup.closeDialog} onRetry={setup.retry} />;
}

function SetupDialog({
  task,
  state,
  onClose,
  onRetry,
}: {
  readonly task: WalletTask;
  readonly state: EngineState;
  readonly onClose: () => void;
  readonly onRetry: () => void;
}): ReactElement {
  const { config } = useEngine();
  const dialog = useRef<HTMLElement>(null);
  const { wallet, balances } = state;
  const symbol = config.asset.symbol;
  const memory = wallet.status !== "loading" && wallet.status !== "locked" && wallet.storage === "memory";
  const steps = setupSteps(wallet, task, { symbol, buyAmount: config.onboarding.buyAmount, memory });
  const live = steps.find((step) => step.state === "live");

  const status = useRef(task.status);
  status.current = task.status;
  useEffect(() => {
    dialog.current?.focus();
    return () => {
      // A finished setup hands the page back; one that stopped, the wallet pill to try again from.
      document.getElementById(status.current === "ok" ? "main" : WALLET_PILL_ID)?.focus();
    };
  }, []);

  const title =
    task.status === "ok"
      ? "Your test wallet is ready"
      : task.status === "failed"
        ? "The wallet setup stopped"
        : task.createsKey
          ? "Creating your test wallet"
          : "Adding test funds to your wallet";
  const lede =
    task.status === "ok"
      ? balances?.asset === null || balances === null
        ? "Payments on this page are signed by it."
        : `It holds ${balances.asset} test ${symbol} to try payments with.`
      : task.status === "failed"
        ? "Nothing was spent. Try again in a moment."
        : memory
          ? "Made for this tab only: this browser cannot store it, so a refresh starts over."
          : task.createsKey
            ? "Made once, kept in this browser. It survives a refresh."
            : "The wallet is kept in this browser; it only needs test funds.";

  return (
    <div className="dialog-backdrop">
      <section
        ref={dialog}
        className="wallet-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wallet-dialog-title"
        aria-describedby="wallet-dialog-lede"
        data-status={task.status}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape" && task.status !== "running") onClose();
        }}
      >
        <div className="wallet-dialog-top">
          <span className="eyebrow eyebrow-accent">{task.createsKey ? "First visit" : "Test funds"}</span>
          {task.status === "running" ? <span className="wallet-dialog-eta">about 30 s</span> : null}
        </div>
        <div className="wallet-dialog-heading">
          <h2 id="wallet-dialog-title">{title}</h2>
          <p id="wallet-dialog-lede">{lede}</p>
        </div>
        <div className="segments" aria-hidden="true">
          {steps.map((step) => (
            <span key={step.id} className="segment" data-state={step.state} />
          ))}
        </div>
        <ol className="setup-list" aria-label="Setup steps">
          {steps.map((step) => (
            <StepItem key={step.id} step={step} template={config.explorerTemplate} />
          ))}
        </ol>
        <span className="visually-hidden" role="status">
          {live === undefined ? (task.status === "ok" ? title : "") : `${live.title}…`}
        </span>
        {task.error !== null ? <Notice error={task.error} /> : null}
        {task.error?.code === "account_funding_failed" && wallet.status === "ready" ? (
          <Faucet address={wallet.address} />
        ) : null}
        {task.status === "failed" ? (
          <div className="wallet-dialog-actions">
            <button type="button" className="button button-dark" onClick={onRetry}>
              Try again
            </button>
            <button type="button" className="button button-outline" onClick={onClose}>
              Close
            </button>
          </div>
        ) : null}
        <p className="wallet-dialog-foot">
          Testnet only, no real money. Reset it any time from the wallet menu.
        </p>
      </section>
    </div>
  );
}

function StepItem({ step, template }: { readonly step: SetupStep; readonly template: string }): ReactElement {
  const link = step.transaction === null ? undefined : explorerLink(template, step.transaction);
  return (
    <li className="setup-step" data-state={step.state}>
      <span className="setup-mark">
        {step.state === "done" ? (
          <DoneIcon />
        ) : step.state === "live" ? (
          <Spinner size={16} />
        ) : step.state === "error" ? (
          <FailedIcon />
        ) : (
          <span className="setup-pending" />
        )}
      </span>
      <span className="setup-text">
        <span className="setup-title">
          {step.title}
          <span className="visually-hidden"> ({STATE_TEXT[step.state]})</span>
        </span>
        <span className="setup-detail">
          {step.detail}
          {link === undefined ? null : (
            <>
              {" · "}
              <ExternalLink className="setup-tx" href={link}>
                transaction <ExternalIcon />
              </ExternalLink>
            </>
          )}
        </span>
      </span>
    </li>
  );
}

/** Starts the wallet setup again from a notice that says the wallet cannot pay yet. */
export function FinishSetup(): ReactElement {
  const setup = useWalletSetup();
  return (
    <button type="button" className="notice-action" disabled={setup.busy} onClick={setup.retry}>
      {setup.busy ? "Setting up…" : "Finish setup"}
    </button>
  );
}

/** When the testnet exchange cannot sell test funds, the faucet can send them to this address. */
export function Faucet({ address }: { readonly address: string }): ReactElement {
  const { config } = useEngine();
  const symbol = config.asset.symbol;
  return (
    <div className="faucet" role="status">
      <p>
        The testnet exchange could not sell {symbol} just now. Get test {symbol} from the{" "}
        <ExternalLink href={config.onboarding.faucetUrl}>
          testnet faucet <ExternalIcon />
        </ExternalLink>{" "}
        instead, sent to this address. The balance updates on its own once it arrives.
      </p>
      <div className="address-box">
        <span className="address-text mono">{address}</span>
        <CopyButton text={address} label="Copy address" />
      </div>
    </div>
  );
}
