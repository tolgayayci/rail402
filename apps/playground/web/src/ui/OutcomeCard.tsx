import type { ReactElement } from "react";
import type { Outcome } from "../projection/outcome.ts";
import { short } from "../projection/format.ts";
import { DocLink, ExternalLink } from "./links.tsx";

/** The result of a finished run: who gained or lost what, the transaction, and what it shows. */
export function OutcomeCard({
  outcome,
  docsUrl,
  next,
}: {
  readonly outcome: Outcome;
  readonly docsUrl: string;
  readonly next?: { readonly label: string; readonly go: () => void } | undefined;
}): ReactElement {
  return (
    <div className="outcome-row">
      <section className="outcome" data-kind={outcome.kind} aria-label="Outcome">
        <div className="outcome-badge">
          <span className="dot" aria-hidden="true" />
          {outcome.badge}
        </div>
        <h2 className="outcome-headline">{outcome.headline}</h2>
        {outcome.code !== null ? (
          <div className="outcome-code">
            <code>{outcome.code}</code>
            {outcome.reason !== null ? <span>{outcome.reason}</span> : null}
          </div>
        ) : null}
        <ul className="money" aria-label="Money">
          {outcome.money.map((line, index) => (
            <li key={`${line.who}-${String(index)}`} className="money-line">
              <span className="money-who">
                <span className="swatch" data-tone={line.tone} aria-hidden="true" />
                {line.who}
              </span>
              <span className="money-delta mono" data-trend={line.trend}>
                {line.delta}
              </span>
            </li>
          ))}
        </ul>
        {outcome.tx !== null ? (
          <ExternalLink className="tx-link mono" href={outcome.tx.explorerUrl}>
            <span className="dot" data-tone="stellar" aria-hidden="true" />
            tx {short(outcome.tx.hash, 8)} · open in the explorer <span aria-hidden="true">↗</span>
          </ExternalLink>
        ) : null}
      </section>
      <section className="card learn" aria-label="What just happened">
        <div className="eyebrow-label">What just happened</div>
        <ul className="learn-list">
          {outcome.learn.map((point) => (
            <li key={point.lead}>
              <span className="swatch" data-tone={point.tone} aria-hidden="true" />
              <span>
                <strong>{point.lead}</strong> {point.text}
              </span>
            </li>
          ))}
        </ul>
        <div className="learn-actions">
          {outcome.docs.map((doc) => (
            <DocLink key={doc.label} className="button-secondary" doc={doc} docsUrl={docsUrl} />
          ))}
          {next !== undefined ? (
            <button type="button" className="button-dark" onClick={next.go}>
              {next.label} <span aria-hidden="true">→</span>
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}
