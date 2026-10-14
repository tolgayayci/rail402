/**
 * Links. Untrusted URLs (from sellers, listings, receipts) become links only when they are https and
 * parse; anything else renders as plain text.
 */
import type { ReactElement, ReactNode } from "react";
import { docHref, type DocRef } from "../projection/docs.ts";
import { safeHttpsUrl } from "../projection/format.ts";

export function ExternalLink({
  href,
  children,
  className,
}: {
  readonly href: string | null | undefined;
  readonly children: ReactNode;
  readonly className?: string;
}): ReactElement {
  const safe = safeHttpsUrl(href);
  if (safe === undefined) return <span className={className}>{children}</span>;
  return (
    <a className={className} href={safe} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

export function DocLink({
  doc,
  docsUrl,
  className,
}: {
  readonly doc: DocRef;
  readonly docsUrl: string;
  readonly className?: string;
}): ReactElement {
  return (
    <ExternalLink className={className} href={docHref(doc, docsUrl)}>
      {doc.label} <span aria-hidden="true">↗</span>
    </ExternalLink>
  );
}
