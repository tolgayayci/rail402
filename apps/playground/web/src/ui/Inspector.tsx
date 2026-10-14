import type { ReactElement } from "react";
import type { Source } from "../engine/events.ts";
import type { InspectorView } from "../projection/inspector.ts";
import { DocLink } from "./links.tsx";
import { sourceLabel } from "./Swimlane.tsx";

/** The colour of a source's dot: you, the seller, the chain or the Bazaar. */
const SOURCE_TONE: Readonly<Record<Source, string>> = {
  you: "you",
  seller: "seller",
  chain: "stellar",
  bazaar: "bazaar",
};

export function Inspector({
  view,
  docsUrl,
}: {
  readonly view: InspectorView;
  readonly docsUrl: string;
}): ReactElement {
  const sources = [...new Set(view.fields.map((field) => field.source))];
  return (
    <section className="card inspector" aria-label="Inspector">
      <div className="card-head">
        <span className="eyebrow-label">Inspector</span>
        <span className="route-pill" data-tone={view.tone}>
          {view.route}
        </span>
      </div>
      <div className="card-body" aria-live="polite">
        <div className="inspector-title">{view.title}</div>
        <p className="inspector-note">{view.note}</p>
        {view.fields.length > 0 ? (
          <dl className="fields">
            {view.fields.map((field, index) => (
              <div key={`${field.key}-${String(index)}`} className="field">
                <dt>
                  <span
                    className="source-dot"
                    data-tone={SOURCE_TONE[field.source]}
                    title={sourceLabel(field.source)}
                  />
                  {field.key}
                </dt>
                <dd className="mono">{field.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {sources.length > 0 ? (
          <ul className="source-key" aria-label="Where these facts come from">
            {sources.map((source) => (
              <li key={source}>
                <span className="source-dot" data-tone={SOURCE_TONE[source]} />
                {sourceLabel(source)}
              </li>
            ))}
          </ul>
        ) : null}
        <DocLink className="doc-link" doc={view.doc} docsUrl={docsUrl} />
      </div>
    </section>
  );
}
