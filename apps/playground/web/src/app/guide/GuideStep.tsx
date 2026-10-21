/** One numbered step of a setup panel: its number, title, an optional docs link, then its content. */
import type { CSSProperties, ReactElement, ReactNode } from "react";
import type { DocRef } from "../../projection/docs.ts";
import { DocLink } from "../../ui/links.tsx";

export function GuideStep({
  n,
  title,
  doc,
  docsUrl,
  aside,
  children,
}: {
  readonly n: number;
  readonly title: string;
  readonly doc?: DocRef;
  readonly docsUrl: string;
  /** Shown at the end of the title row instead of a docs link, such as tabs. */
  readonly aside?: ReactNode;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <li className="guide-step" style={{ "--step": n } as CSSProperties}>
      <div className="guide-step-head">
        <span className="guide-step-number" aria-hidden="true">
          {n}
        </span>
        <h3>
          <span className="visually-hidden">Step {n}: </span>
          {title}
        </h3>
        {aside ??
          (doc === undefined ? null : <DocLink doc={doc} docsUrl={docsUrl} className="guide-step-doc" />)}
      </div>
      {children}
    </li>
  );
}
