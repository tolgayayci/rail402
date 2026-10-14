/**
 * The test wallet: create or import a testnet key, set it up with test funds (each step a real
 * transaction), see balances and the session budget, export the key file, or forget the wallet. The
 * key stays inside the engine: the page sees the address, setup flags and transaction hashes only, and
 * an imported seed goes from an uncontrolled password field straight to the engine.
 */
import { useEffect, useRef, useState, type ReactElement, type SubmitEvent } from "react";
import type { CodedError, EngineState, RunHandle, RunSummary } from "../engine/types.ts";
import { short } from "../projection/format.ts";
import {
  explorerLink,
  sessionTotalInput,
  setupComplete,
  setupSteps,
  type SetupStep,
} from "../projection/wallet.ts";
import { ExternalLink } from "../ui/links.tsx";
import { Notice } from "../ui/Notice.tsx";
import { clientError, toCodedError, useEngine, useEngineState, useRunView } from "./engine.tsx";
import { WALLET_PANEL_ID, useWalletPanel } from "./wallet.tsx";

type WalletRunKind = "create" | "import" | "fund" | "forget";

const RUN_LABEL: Readonly<Record<WalletRunKind, string>> = {
  create: "Creating a test wallet…",
  import: "Importing the key…",
  fund: "Setting up test funds…",
  forget: "Forgetting the wallet…",
};

/** The coded error of a wallet run that ended without success. */
export function summaryError(summary: RunSummary | null): CodedError | null {
  if (summary === null || summary.status === "ok" || summary.status === "info") return null;
  if (summary.code === undefined || summary.reason === undefined || summary.reason === "")
    return clientError("playground_unexpected_error");
  return { code: summary.code, reason: summary.reason, retryable: false };
}

export function WalletPanel(): ReactElement {
  const state = useEngineState();
  const panel = useWalletPanel();
  const heading = useRef<HTMLHeadingElement>(null);
  const [run, setRun] = useState<{ readonly kind: WalletRunKind; readonly handle: RunHandle } | null>(null);
  const view = useRunView(run?.handle ?? null);
  const running = run !== null && view.summary === null;

  useEffect(() => {
    heading.current?.focus();
  }, []);

  const [startError, setStartError] = useState<CodedError | null>(null);
  const start = (kind: WalletRunKind, begin: () => RunHandle): void => {
    if (running) return;
    setStartError(null);
    try {
      setRun({ kind, handle: begin() });
    } catch (error) {
      setRun(null);
      setStartError(toCodedError(error));
    }
  };
  const runError = summaryError(view.summary) ?? startError;

  return (
    <section
      id={WALLET_PANEL_ID}
      className="wallet-panel card"
      aria-labelledby="wallet-heading"
      onKeyDown={(event) => {
        if (event.key === "Escape") panel.setOpen(false);
      }}
    >
      <div className="card-head wallet-panel-head">
        <h2 id="wallet-heading" ref={heading} tabIndex={-1}>
          Test wallet
        </h2>
        <button
          type="button"
          className="button-secondary"
          onClick={() => {
            panel.setOpen(false);
          }}
        >
          Close
        </button>
      </div>
      <div className="card-body wallet-panel-body">
        <WalletBody
          state={state}
          running={running}
          run={run === null ? null : { kind: run.kind, events: view.events, summary: view.summary }}
          start={start}
        />
        {running ? (
          <p className="muted" role="status" aria-busy="true">
            {RUN_LABEL[run.kind]}
          </p>
        ) : null}
        {runError !== null && !running ? <Notice error={runError} /> : null}
        {run?.kind === "fund" && view.summary !== null && runError?.code === "account_funding_failed" ? (
          <FaucetFallback address={state.wallet.status === "ready" ? state.wallet.address : null} />
        ) : null}
      </div>
      <p className="wallet-foot muted">
        Testnet only. The key is made in this tab and kept in this browser, encrypted; it is never sent
        anywhere. What leaves are signatures: payments within your caps, and the two setup transactions.
      </p>
    </section>
  );
}

interface FollowedRun {
  readonly kind: WalletRunKind;
  readonly events: ReturnType<typeof useRunView>["events"];
  readonly summary: RunSummary | null;
}

function WalletBody({
  state,
  running,
  run,
  start,
}: {
  readonly state: EngineState;
  readonly running: boolean;
  readonly run: FollowedRun | null;
  readonly start: (kind: WalletRunKind, begin: () => RunHandle) => void;
}): ReactElement {
  const { wallet } = state;
  switch (wallet.status) {
    case "loading":
      return <p aria-busy="true">Opening the wallet…</p>;
    case "locked":
      return <Notice error={clientError("playground_wallet_locked")} tone="info" />;
    case "none":
      return <NoWallet memory={wallet.storage === "memory"} running={running} start={start} />;
    case "ready":
      return <ReadyWallet state={state} running={running} run={run} start={start} />;
  }
}

function NoWallet({
  memory,
  running,
  start,
}: {
  readonly memory: boolean;
  readonly running: boolean;
  readonly start: (kind: WalletRunKind, begin: () => RunHandle) => void;
}): ReactElement {
  const engine = useEngine();
  const seedField = useRef<HTMLInputElement>(null);
  const importSeed = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const field = seedField.current;
    if (field === null) return;
    const seed = field.value.trim();
    field.value = "";
    if (seed === "") return;
    start("import", () => engine.wallet.import(seed));
  };
  return (
    <div className="stack">
      {memory ? <Notice error={clientError("playground_wallet_storage_unavailable")} tone="info" /> : null}
      <p>
        Payments here are signed by a throwaway testnet key that lives in this browser. Create one, then set
        it up with test funds: three testnet transactions, no real money.
      </p>
      <div>
        <button
          type="button"
          className="button-primary"
          disabled={running}
          onClick={() => {
            start("create", () => engine.wallet.create());
          }}
        >
          Create a test wallet
        </button>
      </div>
      <form className="stack-tight" onSubmit={importSeed} aria-labelledby="import-heading">
        <h3 id="import-heading">Or import a testnet key</h3>
        <label className="field-label" htmlFor="import-seed">
          Secret key (S…), testnet only
        </label>
        <div className="inline-form">
          <input
            ref={seedField}
            id="import-seed"
            className="text-input mono"
            type="password"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder="S…"
          />
          <button type="submit" className="button-secondary" disabled={running}>
            Import
          </button>
        </div>
        <span className="muted">
          Never paste a key that holds real funds: use a key made for the testnet. The field is cleared as
          soon as you press Import.
        </span>
      </form>
    </div>
  );
}

function ReadyWallet({
  state,
  running,
  run,
  start,
}: {
  readonly state: EngineState;
  readonly running: boolean;
  readonly run: FollowedRun | null;
  readonly start: (kind: WalletRunKind, begin: () => RunHandle) => void;
}): ReactElement | null {
  const engine = useEngine();
  const { config } = engine;
  const { wallet, balances } = state;
  if (wallet.status !== "ready") return null;
  const steps = setupSteps(wallet, run?.kind === "fund" ? run : null, {
    symbol: config.asset.symbol,
    buyAmount: config.onboarding.buyAmount,
    keepXlm: config.onboarding.keepXlm,
  });
  const complete = setupComplete(wallet);
  const failed = steps.some((step) => step.state === "error");
  return (
    <div className="wallet-grid">
      <div className="stack">
        {wallet.storage === "memory" ? (
          <Notice error={clientError("playground_wallet_storage_unavailable")} tone="info" />
        ) : null}
        <dl className="wallet-facts">
          <div>
            <dt>Address</dt>
            <dd className="mono wallet-address">{wallet.address}</dd>
          </div>
          <div>
            <dt>Network</dt>
            <dd>{wallet.network === "stellar:testnet" ? "Stellar testnet" : wallet.network}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{utcTime(wallet.createdAt)}</dd>
          </div>
          <div>
            <dt>Balances</dt>
            <dd>
              {balances === null ? (
                "not read yet"
              ) : balances.xlm === null ? (
                "the account does not exist yet"
              ) : (
                <>
                  <span className="mono">{balances.xlm}</span> XLM ·{" "}
                  {balances.asset === null ? (
                    `no ${config.asset.symbol} trustline yet`
                  ) : (
                    <>
                      <span className="mono">{balances.asset}</span> {config.asset.symbol}
                    </>
                  )}
                </>
              )}
            </dd>
          </div>
        </dl>

        <section aria-labelledby="setup-heading" className="stack-tight">
          <h3 id="setup-heading">{complete ? "Set up" : "Set up test funds"}</h3>
          <ol className="setup-steps">
            {steps.map((step) => (
              <SetupStepItem key={step.id} step={step} template={config.explorerTemplate} />
            ))}
          </ol>
          {complete ? null : (
            <div>
              <button
                type="button"
                className="button-primary"
                disabled={running}
                onClick={() => {
                  start("fund", () => engine.wallet.fund());
                }}
              >
                {failed ? "Try the setup again" : "Set up test funds"}
              </button>
            </div>
          )}
        </section>
      </div>

      <div className="stack">
        <BudgetSection state={state} />
        <KeySection running={running} start={start} address={wallet.address} />
      </div>
    </div>
  );
}

const STEP_MARK: Readonly<Record<SetupStep["state"], string>> = {
  done: "✓",
  live: "…",
  pending: "○",
  error: "✕",
};

const STEP_STATE: Readonly<Record<SetupStep["state"], string>> = {
  done: "done",
  live: "in progress",
  pending: "to do",
  error: "failed",
};

function SetupStepItem({
  step,
  template,
}: {
  readonly step: SetupStep;
  readonly template: string;
}): ReactElement {
  const link = step.transaction === null ? undefined : explorerLink(template, step.transaction);
  return (
    <li className="setup-step" data-state={step.state}>
      <span className="check-mark" aria-hidden="true">
        {STEP_MARK[step.state]}
      </span>
      <div>
        <div className="setup-title">
          {step.title} <span className="visually-hidden">({STEP_STATE[step.state]})</span>
        </div>
        <div className="muted">{step.detail}</div>
        {step.transaction !== null ? (
          <ExternalLink className="tx-link mono" href={link}>
            {short(step.transaction, 6)}
            {link === undefined ? "" : " ↗"}
          </ExternalLink>
        ) : null}
      </div>
    </li>
  );
}

function FaucetFallback({ address }: { readonly address: string | null }): ReactElement {
  const { config } = useEngine();
  return (
    <div className="faucet note" role="status">
      <p>
        The testnet exchange could not sell {config.asset.symbol} just now. Get test {config.asset.symbol}{" "}
        from the <ExternalLink href={config.onboarding.faucetUrl}>testnet faucet ↗</ExternalLink> instead,
        sent to this address:
      </p>
      {address === null ? null : <p className="mono wallet-address">{address}</p>}
      <p className="muted">The balance here updates on its own once the funds arrive.</p>
    </div>
  );
}

function BudgetSection({ state }: { readonly state: EngineState }): ReactElement | null {
  const engine = useEngine();
  const { config } = engine;
  const { budget } = state;
  const [total, setTotal] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CodedError | null>(null);
  const [done, setDone] = useState<string | null>(null);
  if (budget === null) return null;
  const symbol = config.asset.symbol;

  const lower = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const input = sessionTotalInput(total, budget.sessionCap, config.asset.decimals);
    setDone(null);
    if (!input.valid) {
      setError(input.error);
      return;
    }
    setBusy(true);
    setError(null);
    engine.lowerSessionTotal(input.value).then(
      () => {
        setBusy(false);
        setTotal("");
        setDone(input.value);
      },
      (reason: unknown) => {
        setBusy(false);
        setError(toCodedError(reason));
      },
    );
  };

  return (
    <section aria-labelledby="budget-heading" className="stack-tight">
      <h3 id="budget-heading">Session budget</h3>
      <dl className="wallet-facts">
        <div>
          <dt>Spent</dt>
          <dd className="mono">
            {budget.spent} {symbol}
          </dd>
        </div>
        <div>
          <dt>Held for payments in flight</dt>
          <dd className="mono">
            {budget.pending} {symbol}
          </dd>
        </div>
        <div>
          <dt>Left</dt>
          <dd className="mono">
            {budget.remaining} of {budget.sessionCap} {symbol}
          </dd>
        </div>
        <div>
          <dt>Per call, at most</dt>
          <dd className="mono">
            {budget.perCallCap} {symbol}
          </dd>
        </div>
        <div>
          <dt>Window ends</dt>
          <dd>{utcTime(budget.expiresAt)}</dd>
        </div>
      </dl>
      {budget.falseClaims > 0 ? (
        <p className="note" role="status">
          {String(budget.falseClaims)} reported settlement(s) were not confirmed on chain; they stay counted
          against the budget.
        </p>
      ) : null}
      <Reconcile unfinished={state.unfinished} awaitingProof={budget.awaitingProof} />
      <form className="stack-tight" onSubmit={lower}>
        <label className="field-label" htmlFor="session-total">
          Lower the session budget
        </label>
        <div className="inline-form">
          <input
            id="session-total"
            className="text-input mono"
            inputMode="decimal"
            autoComplete="off"
            placeholder={budget.sessionCap}
            value={total}
            onChange={(event) => {
              setTotal(event.target.value);
            }}
          />
          <button type="submit" className="button-secondary" disabled={busy}>
            Lower
          </button>
        </div>
        <span className="muted">It can only go down. The window renews every day.</span>
      </form>
      {error !== null ? <Notice error={error} /> : null}
      {done !== null ? (
        <p className="muted" role="status">
          The session budget is now {done} {symbol}.
        </p>
      ) : null}
    </section>
  );
}

function Reconcile({
  unfinished,
  awaitingProof,
}: {
  readonly unfinished: number;
  readonly awaitingProof: number;
}): ReactElement | null {
  const engine = useEngine();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CodedError | null>(null);
  if (unfinished === 0 && awaitingProof === 0 && error === null) return null;
  return (
    <div className="stack-tight">
      <p className="note">
        {String(unfinished)} payment(s) still wait for proof on chain
        {awaitingProof > 0 ? ` (${String(awaitingProof)} the chain can no longer prove either way)` : ""}. The
        page checks again every 20 seconds.
      </p>
      <div>
        <button
          type="button"
          className="button-secondary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            engine.reconcile().then(
              () => {
                setBusy(false);
              },
              (reason: unknown) => {
                setBusy(false);
                setError(toCodedError(reason));
              },
            );
          }}
        >
          {busy ? "Checking…" : "Check the chain now"}
        </button>
      </div>
      {error !== null ? <Notice error={error} /> : null}
    </div>
  );
}

function KeySection({
  running,
  start,
  address,
}: {
  readonly running: boolean;
  readonly start: (kind: WalletRunKind, begin: () => RunHandle) => void;
  readonly address: string;
}): ReactElement {
  const engine = useEngine();
  const [confirm, setConfirm] = useState<"export" | "forget" | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<CodedError | null>(null);
  const [busy, setBusy] = useState(false);

  const exportKey = (): void => {
    setBusy(true);
    setError(null);
    engine.wallet.exportFile().then(
      ({ fileName }) => {
        setBusy(false);
        setConfirm(null);
        setSaved(fileName);
      },
      (reason: unknown) => {
        setBusy(false);
        setError(toCodedError(reason));
      },
    );
  };

  return (
    <section aria-labelledby="key-heading" className="stack-tight">
      <h3 id="key-heading">Your key</h3>
      <p className="muted">
        Take this wallet to the CLI, the SDK or an MCP client as a key file. The key is never shown on screen.
      </p>
      {confirm === "export" ? (
        <div className="confirm" role="group" aria-label="Confirm the key download">
          <p>
            The file holds the secret key of {short(address)} on the Stellar <strong>testnet</strong>. Anyone
            with it can spend this wallet&apos;s test funds. Keep it private.
          </p>
          <div className="confirm-actions">
            <button type="button" className="button-dark" disabled={busy} onClick={exportKey}>
              Download the key file
            </button>
            <button
              type="button"
              className="button-secondary"
              onClick={() => {
                setConfirm(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : confirm === "forget" ? (
        <div className="confirm" role="group" aria-label="Confirm forgetting the wallet">
          <p>
            This deletes the key and its budget ledger from this browser. The account and its test funds stay
            on the testnet, reachable only with an exported key file.
          </p>
          <div className="confirm-actions">
            <button
              type="button"
              className="button-dark"
              disabled={running}
              onClick={() => {
                setConfirm(null);
                setSaved(null);
                start("forget", () => engine.wallet.forget());
              }}
            >
              Forget this wallet
            </button>
            <button
              type="button"
              className="button-secondary"
              onClick={() => {
                setConfirm(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="confirm-actions">
          <button
            type="button"
            className="button-secondary"
            disabled={running}
            onClick={() => {
              setSaved(null);
              setConfirm("export");
            }}
          >
            Download key file…
          </button>
          <button
            type="button"
            className="button-secondary"
            disabled={running}
            onClick={() => {
              setConfirm("forget");
            }}
          >
            Forget wallet…
          </button>
        </div>
      )}
      {saved !== null ? (
        <div className="muted stack-tight" role="status">
          <p>
            Saved as <span className="mono">{saved}</span>. Your browser saved it readable by others, which
            the CLI, the SDK and the MCP server refuse. Either import it as your default testnet key (the path
            the code on this page uses), then delete the download:
          </p>
          <pre className="mono">rail402 keys import &lt; {saved}</pre>
          <p>
            or make it private before pointing <span className="mono">RAIL402_SECRET_KEY_FILE</span> at it:
          </p>
          <pre className="mono">chmod 600 {saved}</pre>
        </div>
      ) : null}
      {error !== null ? <Notice error={error} /> : null}
    </section>
  );
}

/** `2026-10-03 11:58 UTC` from an ISO timestamp; the text itself when it does not parse. */
export function utcTime(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  return `${new Date(time).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
