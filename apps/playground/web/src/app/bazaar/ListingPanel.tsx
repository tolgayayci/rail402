/**
 * The chosen listing on the dark panel beside the list: what it is, its price, its paid calls, its
 * seller and trust, a form to try it with the wallet, and its public version history.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement, type Ref } from "react";
import type { ListingView, VersionView } from "../../engine/events.ts";
import type { CodedError } from "../../engine/types.ts";
import { DOCS } from "../../projection/docs.ts";
import { short } from "../../projection/format.ts";
import {
  listingCall,
  listingHeading,
  listingPrice,
  priceWords,
  schemeOf,
} from "../../projection/listings.ts";
import { trustLabel } from "../../projection/rows.ts";
import { addressLink } from "../../projection/stage.ts";
import { explorerLink } from "../../projection/wallet.ts";
import { ExternalIcon, Spinner } from "../../ui/icons.tsx";
import { DocLink, ExternalLink } from "../../ui/links.tsx";
import { Notice } from "../../ui/Notice.tsx";
import { toCodedError, useEngine } from "../engine.tsx";
import { TryIt, type FocusRequest } from "./TryIt.tsx";

export function ListingPanel({
  ref,
  listing,
  error,
  loading,
  focusForm,
}: {
  readonly ref?: Ref<HTMLElement>;
  readonly listing: ListingView | undefined;
  readonly error: CodedError | null;
  readonly loading: boolean;
  readonly focusForm: FocusRequest | null;
}): ReactElement {
  const engine = useEngine();
  const { config } = engine;
  const [history, setHistory] = useState(false);
  // The listing as read again after a payment from this panel: its count of paid calls moved.
  const [fresh, setFresh] = useState<ListingView | null>(null);
  const listingId = listing?.id;
  const reread = useCallback(() => {
    if (listingId === undefined) return;
    engine.listing(listingId).then(
      (read) => {
        setFresh(read);
      },
      () => undefined,
    );
  }, [engine, listingId]);
  // Another listing starts with its history closed.
  const [shownId, setShownId] = useState(listing?.id);
  if (shownId !== listing?.id) {
    setShownId(listing?.id);
    setHistory(false);
  }
  if (listing === undefined) {
    return (
      <section ref={ref} className="listing-panel on-dark" aria-label="Listing" aria-busy={loading}>
        <span className="eyebrow listing-panel-eyebrow">Listing</span>
        {error !== null ? (
          <Notice error={error} />
        ) : loading ? (
          <p className="listing-panel-empty">
            <Spinner /> Reading the Bazaar…
          </p>
        ) : (
          <p className="listing-panel-empty">Choose a listing to see its details and try it.</p>
        )}
      </section>
    );
  }
  const scheme = schemeOf(listing);
  const price = listingPrice(listing, config.asset.symbol);
  const settlements = Math.max(listing.settlements, fresh?.id === listing.id ? fresh.settlements : 0);
  const sellerHref = addressLink(config.explorerTemplate, listing.owner);
  return (
    <section
      ref={ref}
      className="listing-panel on-dark"
      data-mode={scheme ?? "exact"}
      aria-labelledby="listing-panel-title"
    >
      <div className="listing-panel-scroll" key={listing.id}>
        <div className="listing-panel-head">
          <span className="eyebrow listing-panel-eyebrow">Listing</span>
          <span className="listing-panel-badges">
            <span className="scheme-badge scheme-badge-dark mono" data-mode={scheme ?? undefined}>
              {listing.price?.scheme.toUpperCase() ?? "—"}
            </span>
            <span className="trust-badge" data-trust={listing.trust}>
              {trustLabel(listing.trust)}
            </span>
          </span>
        </div>
        <div className="listing-panel-heading">
          <h2 id="listing-panel-title">{listingHeading(listing)}</h2>
          <span className="listing-panel-call mono">{listingCall(listing)}</span>
        </div>
        <dl className="listing-facts">
          <div>
            <dt>Price</dt>
            <dd>{priceWords(price)}</dd>
          </div>
          <div>
            <dt>Paid calls</dt>
            <dd>
              <span key={settlements} className="listing-count">
                {String(settlements)}
              </span>
            </dd>
          </div>
          <div>
            <dt>Seller</dt>
            <dd>
              <ExternalLink className="mono" href={sellerHref}>
                {short(listing.owner)} {sellerHref === undefined ? null : <ExternalIcon />}
              </ExternalLink>
            </dd>
          </div>
          <div>
            <dt>Network</dt>
            <dd>{listing.network}</dd>
          </div>
        </dl>
        <TryIt
          listing={listing}
          focusForm={focusForm}
          onPaid={reread}
          footerEnd={
            <button
              type="button"
              className="stage-text-button listing-history-toggle"
              aria-expanded={history}
              aria-controls="listing-versions"
              onClick={() => {
                setHistory(!history);
              }}
            >
              {history ? "Hide version history" : "Version history"}
            </button>
          }
        />
        {history ? <VersionList listingId={listing.id} /> : null}
      </div>
    </section>
  );
}

/** The listing's public version history, read when first shown. */
function VersionList({ listingId }: { readonly listingId: string }): ReactElement {
  const engine = useEngine();
  const { config } = engine;
  const [versions, setVersions] = useState<readonly VersionView[] | null>(null);
  const [error, setError] = useState<CodedError | null>(null);
  const section = useRef<HTMLElement>(null);
  // Opened below the form, the history comes into view.
  useEffect(() => {
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    section.current?.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "nearest" });
  }, [versions]);
  useEffect(() => {
    let live = true;
    engine.versions(listingId).then(
      (read) => {
        if (live) setVersions(read);
      },
      (reason: unknown) => {
        if (live) setError(toCodedError(reason));
      },
    );
    return () => {
      live = false;
    };
  }, [engine, listingId]);
  return (
    <section ref={section} id="listing-versions" className="listing-versions" aria-label="Version history">
      <span className="eyebrow try-eyebrow">Version history</span>
      {error !== null ? (
        <Notice error={error} />
      ) : versions === null ? (
        <p className="listing-panel-empty">
          <Spinner /> Reading the history…
        </p>
      ) : (
        <ol className="version-list">
          {[...versions].reverse().map((version) => (
            <li key={version.version} className="version">
              <span className="version-number mono">v{String(version.version)}</span>
              <span className="version-what">
                {causeWords(version.cause)}
                {version.reason === null ? "" : ` · ${version.reason}`}
                <span className="version-meta">
                  {new Date(version.createdAt).toLocaleDateString(undefined, { dateStyle: "medium" })} ·{" "}
                  {trustLabel(version.trust)} · {version.state}
                </span>
              </span>
              {version.transaction === null ? null : (
                <ExternalLink
                  className="version-tx mono"
                  href={explorerLink(config.explorerTemplate, version.transaction)}
                >
                  {short(version.transaction)} <ExternalIcon />
                </ExternalLink>
              )}
            </li>
          ))}
        </ol>
      )}
      <DocLink doc={DOCS.listingTrust} docsUrl={config.urls.docs} className="listing-doc" />
    </section>
  );
}

const CAUSES: Readonly<Record<string, string>> = {
  settlement: "Changed by a payment",
  origin_verification: "Origin checked",
  domain_verification: "Domain checked",
  ownership_transfer: "Owner changed",
  quarantine: "Quarantined",
};

function causeWords(cause: string): string {
  return CAUSES[cause] ?? cause.replaceAll("_", " ");
}
