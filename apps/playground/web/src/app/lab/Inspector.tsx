/**
 * The inspector beside the swimlane: the current (or chosen) step in plain words with its key facts,
 * and the list of every step, which is also how a keyboard moves through the run.
 */
import type { ReactElement, ReactNode } from "react";
import type { StageFact, StageStep } from "../../projection/stage.ts";
import { ExternalIcon, Spinner } from "../../ui/icons.tsx";
import { DocLink, ExternalLink } from "../../ui/links.tsx";
import type { StepLook } from "../../ui/Swimlane.tsx";
import { WAIT_SHOWN_AFTER_MS, useElapsed } from "./waiting.ts";

function two(n: number): string {
  return String(n).padStart(2, "0");
}

/** Readable key and value pairs; values with an https link open the explorer. */
export function FactList({
  facts,
  className = "fact-list",
}: {
  readonly facts: readonly StageFact[];
  readonly className?: string;
}): ReactElement | null {
  if (facts.length === 0) return null;
  return (
    <dl className={className}>
      {facts.map((fact) => (
        <div key={`${fact.label}-${fact.value}`} className="fact" data-long={fact.value.length > 30}>
          <dt>{fact.label}</dt>
          <dd className={fact.mono === true ? "mono" : undefined}>
            {fact.href === undefined ? (
              fact.value
            ) : (
              <ExternalLink href={fact.href}>
                {fact.value} <ExternalIcon />
              </ExternalLink>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * What the run waits for, once the wait has lasted long enough to notice, with a seconds counter:
 * a settlement or a chain read can take a while, and the page says so instead of only spinning.
 */
export function WaitLine({
  text,
  waitKey,
}: {
  readonly text: string;
  readonly waitKey: string;
}): ReactElement | null {
  const elapsed = useElapsed(`${waitKey}:${text}`);
  if (elapsed < WAIT_SHOWN_AFTER_MS) return null;
  return (
    <p className="step-wait">
      <Spinner />
      <span>
        {text}
        <span className="step-wait-time mono"> · {String(Math.floor(elapsed / 1_000))} s</span>
      </span>
    </p>
  );
}

/** One step: where it is in the run, what happened, its facts and where to read more. */
export function StepDetail({
  step,
  index,
  total,
  now,
  docsUrl,
  back,
  waiting = null,
}: {
  readonly step: StageStep;
  readonly index: number;
  readonly total: number;
  /** The step is the one playing now. */
  readonly now: boolean;
  readonly docsUrl: string;
  /** A way back to following the run, or to its proof. */
  readonly back?: ReactNode;
  /** What the run waits for while this step is the current one. */
  readonly waiting?: string | null;
}): ReactElement {
  return (
    <div className="step-detail" key={step.id}>
      <div className="step-detail-head">
        <span className="eyebrow step-count">
          Step {two(index + 1)} / {two(total)}
          {now ? " · now" : step.planned ? " · to come" : ""}
        </span>
        {back}
      </div>
      <h2 className="step-title">{step.title}</h2>
      <p className="step-explain">{step.explain}</p>
      {waiting === null ? null : <WaitLine text={waiting} waitKey={step.id} />}
      <FactList facts={step.facts} />
      {step.result.length > 0 ? (
        <div className="result-card">
          <span className="eyebrow">What came back</span>
          <FactList facts={step.result} className="fact-list fact-list-compact" />
        </div>
      ) : null}
      {step.planned ? null : <DocLink className="step-doc" doc={step.doc} docsUrl={docsUrl} />}
    </div>
  );
}

/** Every step of the run, in order, as buttons that show each one in the inspector. */
export function StepList({
  steps,
  lookOf,
  selected,
  onSelect,
}: {
  readonly steps: readonly StageStep[];
  readonly lookOf: (step: StageStep) => StepLook;
  readonly selected: string | null;
  readonly onSelect: (id: string) => void;
}): ReactElement {
  return (
    <ol className="step-list" aria-label="Steps">
      {steps.map((step, index) => {
        const look = lookOf(step);
        return (
          <li key={step.id}>
            <button
              type="button"
              className="step-list-item"
              data-look={look}
              aria-current={look === "current" ? "step" : undefined}
              aria-pressed={step.id === selected}
              onClick={() => {
                onSelect(step.id);
              }}
            >
              <span className="step-mark" aria-hidden="true">
                {look === "done" ? (
                  <svg width="8" height="8" viewBox="0 0 8 8">
                    <path
                      d="M1.5 4.2 L3.3 5.8 L6.5 2.4"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      fill="none"
                      strokeLinecap="round"
                    />
                  </svg>
                ) : look === "error" ? (
                  <svg width="8" height="8" viewBox="0 0 8 8">
                    <path
                      d="M2 2 L6 6 M6 2 L2 6"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                    />
                  </svg>
                ) : null}
              </span>
              <span className="visually-hidden">{`Step ${String(index + 1)}: `}</span>
              <span className="step-list-title">{step.title}</span>
              <span className="visually-hidden">{LOOK_TEXT[look]}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

const LOOK_TEXT: Readonly<Record<StepLook, string>> = {
  pending: ", to come",
  current: ", now",
  done: ", done",
  error: ", failed",
};
