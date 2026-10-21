/**
 * The stage's request bar: the method, the URL (editable: paste any x402 URL) or what a fixed run
 * calls, the per-call cap, the refusals to try, and Run.
 */
import { useId, type ReactElement } from "react";
import { Spinner } from "../../ui/icons.tsx";
import { RefusalMenu } from "./RefusalMenu.tsx";
import type { RefusalEntry } from "./refusals.ts";

const RUN_TEXT = { idle: "Run", busy: "Running", again: "Run again" } as const;

export function RunBar({
  method,
  target,
  onUrl,
  urlPlaceholder,
  onLeaveRefusal,
  leaveLabel,
  cap,
  onCap,
  symbol,
  before,
  after,
  onRefusal,
  menuDisabled,
  running,
  finished,
  runnable,
  runText = RUN_TEXT,
  onRun,
}: {
  readonly method: string;
  /** An editable URL, or a fixed description of what the run calls. */
  readonly target: { readonly kind: "url" | "fixed"; readonly text: string };
  readonly onUrl: (value: string) => void;
  readonly urlPlaceholder: string;
  /** Leaves a refusal for the mode's own payment; undefined when no refusal is chosen. */
  readonly onLeaveRefusal: (() => void) | undefined;
  readonly leaveLabel: string;
  /** The cap as typed; null when the run sets its own (a refusal). */
  readonly cap: string | null;
  readonly onCap: (value: string) => void;
  readonly symbol: string;
  readonly before: readonly RefusalEntry[];
  readonly after: readonly RefusalEntry[];
  readonly onRefusal: (entry: RefusalEntry) => void;
  readonly menuDisabled: boolean;
  readonly running: boolean;
  readonly finished: boolean;
  readonly runnable: boolean;
  /** The run button's words: before a run, while it goes, and after it. */
  readonly runText?: { readonly idle: string; readonly busy: string; readonly again: string } | undefined;
  readonly onRun: () => void;
}): ReactElement {
  const id = useId();
  return (
    <form
      className="run-bar"
      onSubmit={(event) => {
        event.preventDefault();
        if (runnable) onRun();
      }}
    >
      <span className="run-method mono" aria-hidden="true">
        {method}
      </span>
      {target.kind === "url" ? (
        <>
          <label htmlFor={`${id}-url`} className="visually-hidden">
            URL to pay
          </label>
          <input
            id={`${id}-url`}
            className="run-url mono"
            type="text"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder={urlPlaceholder}
            title="Paste any x402 URL"
            value={target.text}
            disabled={running}
            onChange={(event) => {
              onUrl(event.target.value);
            }}
          />
        </>
      ) : (
        <span className="run-url run-url-fixed mono" title={target.text}>
          <span className="run-url-text">{target.text}</span>
          {onLeaveRefusal === undefined ? null : (
            <button
              type="button"
              className="run-url-clear"
              aria-label={leaveLabel}
              title={leaveLabel}
              disabled={running}
              onClick={onLeaveRefusal}
            >
              ×
            </button>
          )}
        </span>
      )}
      {cap === null ? null : (
        <span className="run-cap">
          <label htmlFor={`${id}-cap`}>Cap</label>
          <span className="run-cap-field">
            <input
              id={`${id}-cap`}
              className="mono"
              inputMode="decimal"
              autoComplete="off"
              spellCheck={false}
              required
              value={cap}
              disabled={running}
              onChange={(event) => {
                onCap(event.target.value);
              }}
            />
            <span className="run-cap-unit mono">{symbol}</span>
          </span>
        </span>
      )}
      <RefusalMenu before={before} after={after} disabled={menuDisabled} onChoose={onRefusal} />
      <button
        type="submit"
        className="stage-button stage-button-run"
        disabled={!runnable}
        aria-busy={running}
      >
        {running ? (
          <>
            <Spinner /> {runText.busy}
          </>
        ) : finished ? (
          runText.again
        ) : (
          runText.idle
        )}
      </button>
    </form>
  );
}
