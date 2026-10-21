/**
 * The Bazaar: every paid API and MCP tool listed on Stellar, on one page. Search it in plain words,
 * narrow it with filters, and try a listing with the test wallet in the panel beside the list.
 * Listings come from real payments: sellers never register.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from "react";
import type { ListingView } from "../../engine/events.ts";
import { DOCS } from "../../projection/docs.ts";
import {
  BAZAAR_FILTERS,
  filterCounts,
  isBazaarFilter,
  listingPrice,
  listingTitle,
  matchesFilter,
  schemeOf,
  type BazaarFilter,
} from "../../projection/listings.ts";
import { displayUrl } from "../../projection/format.ts";
import { Spinner } from "../../ui/icons.tsx";
import { DocLink } from "../../ui/links.tsx";
import { Notice } from "../../ui/Notice.tsx";
import { useAllListings, useSearch } from "../bazaar/data.ts";
import { ListingPanel } from "../bazaar/ListingPanel.tsx";
import type { FocusRequest } from "../bazaar/TryIt.tsx";
import { toCodedError, useEngine } from "../engine.tsx";
import { navigate, useLocation } from "../router.tsx";

function SearchIcon(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" className="bazaar-search-icon">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.6" fill="none" />
      <path d="M10.5 10.5 L14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function BazaarPage(): ReactElement {
  const engine = useEngine();
  const { config } = engine;
  const { search } = useLocation();
  const all = useAllListings(engine);
  const [query, setQuery] = useState(() => search.get("q") ?? "");
  const requestedFilter = search.get("filter");
  const [filter, setFilter] = useState<BazaarFilter>(
    isBazaarFilter(requestedFilter) ? requestedFilter : "all",
  );
  const found = useSearch(engine, query);
  const searching = query.trim() !== "";
  const linkedId = search.get("listing");

  // The query, the filter and the chosen listing stay in the address, so a link shows the same view.
  const writeAddress = (next: { q?: string; filter?: BazaarFilter; listing?: string | null }): void => {
    const params = new URLSearchParams(window.location.search);
    const set = (key: string, value: string | null | undefined, empty: string): void => {
      if (value === undefined) return;
      if (value === null || value === empty) params.delete(key);
      else params.set(key, value);
    };
    set("q", next.q?.trim(), "");
    set("filter", next.filter, "all");
    set("listing", next.listing, "");
    const text = params.toString();
    navigate(text === "" ? "/bazaar" : `/bazaar?${text}`, { replace: true });
  };

  const base: readonly ListingView[] | null = searching ? (found.data?.items ?? null) : all.data;
  const counts = useMemo(() => filterCounts(base ?? []), [base]);
  const shown = useMemo(() => (base ?? []).filter((item) => matchesFilter(item, filter)), [base, filter]);

  // A listing linked by id that the list does not show (another filter, or not listed) is read alone.
  const [linked, setLinked] = useState<ListingView | null>(null);
  const [linkedError, setLinkedError] = useState<ReturnType<typeof toCodedError> | null>(null);
  const inList = (id: string): ListingView | undefined =>
    shown.find((item) => item.id === id) ?? all.data?.find((item) => item.id === id);
  const missingId =
    linkedId !== null && all.data !== null && inList(linkedId) === undefined ? linkedId : null;
  useEffect(() => {
    if (missingId === null) {
      setLinked(null);
      setLinkedError(null);
      return undefined;
    }
    let live = true;
    engine.listing(missingId).then(
      (item) => {
        if (live) setLinked(item);
      },
      (reason: unknown) => {
        if (live) setLinkedError(toCodedError(reason));
      },
    );
    return () => {
      live = false;
    };
  }, [engine, missingId]);

  const selected: ListingView | undefined =
    linkedId !== null ? (inList(linkedId) ?? linked ?? undefined) : shown[0];

  const panelRef = useRef<HTMLElement>(null);
  const [focusForm, setFocusForm] = useState<FocusRequest | null>(null);
  const choose = (listing: ListingView, tryIt: boolean): void => {
    writeAddress({ listing: listing.id });
    if (!tryIt) return;
    setFocusForm((current) => ({ id: listing.id, n: (current?.n ?? 0) + 1 }));
    // Beside the list the panel is in view; below it (narrow screens), bring it up.
    const panel = panelRef.current;
    if (panel !== null && window.matchMedia("(max-width: 1023px)").matches) {
      const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      panel.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
    }
  };

  const loading = searching ? found.busy && found.data === null : all.busy && all.data === null;
  const error = searching ? found.error : all.error;
  const total = all.data?.length;

  return (
    <div className="bazaar">
      <div className="bazaar-top">
        <div className="bazaar-title">
          <span className="eyebrow">Bazaar{total === undefined ? "" : ` · ${String(total)} listings`}</span>
          <h1>Find paid APIs and tools on Stellar, and try them</h1>
        </div>
        <p className="bazaar-lede">
          Listed only after a real payment. Try any of them with your test wallet.
        </p>
      </div>

      <div className="bazaar-body">
        <div className="bazaar-main">
          <form
            role="search"
            className="bazaar-search"
            onSubmit={(event) => {
              event.preventDefault();
              found.reload();
            }}
          >
            <SearchIcon />
            <label htmlFor="bazaar-query" className="visually-hidden">
              Search the Bazaar
            </label>
            <input
              id="bazaar-query"
              type="search"
              maxLength={500}
              autoComplete="off"
              placeholder="Search in plain words, e.g. weather in Ankara under a cent"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                writeAddress({ q: event.target.value, listing: null });
              }}
            />
            {found.busy ? <Spinner /> : null}
            <DocLink
              className="bazaar-search-doc"
              doc={{ ...DOCS.search, label: "How search works" }}
              docsUrl={config.urls.docs}
            />
          </form>

          <div className="bazaar-filters" role="group" aria-label="Filters">
            {BAZAAR_FILTERS.map((item) => (
              <button
                key={item.id}
                type="button"
                className="chip"
                aria-pressed={item.id === filter}
                onClick={() => {
                  setFilter(item.id);
                  writeAddress({ filter: item.id, listing: null });
                }}
              >
                {item.label}{" "}
                <span className="chip-count">· {base === null ? "…" : String(counts[item.id])}</span>
              </button>
            ))}
          </div>

          {error !== null ? (
            <Notice error={error}>
              <button type="button" className="text-button" onClick={searching ? found.reload : all.reload}>
                Try again
              </button>
            </Notice>
          ) : null}
          {searching && found.data?.partialResults === true ? (
            <p className="bazaar-note" role="status">
              Partial results: the Bazaar answered from part of its index, so the ranking may be incomplete.
            </p>
          ) : null}

          <div className="listing-head" aria-hidden="true">
            <span>Listing</span>
            <span>Type</span>
            <span>Scheme</span>
            <span className="listing-head-price">Price</span>
            <span />
          </div>
          <div className="listing-scroll" aria-busy={loading}>
            {loading ? (
              <ol className="listing-rows" aria-label="Loading listings">
                {[0, 1, 2, 3, 4].map((index) => (
                  <li key={index} className="listing-row listing-row-ghost" />
                ))}
              </ol>
            ) : (
              <ol
                className="listing-rows"
                aria-label={searching ? `Results for ${query.trim()}` : "Listings"}
                key={`${searching ? query.trim() : ""}:${filter}`}
              >
                {shown.map((item, index) => (
                  <ListingRow
                    key={item.id}
                    listing={item}
                    index={index}
                    symbol={config.asset.symbol}
                    selected={item.id === selected?.id}
                    onChoose={choose}
                  />
                ))}
              </ol>
            )}
            {!loading && base !== null && shown.length === 0 ? (
              <p className="bazaar-empty">
                {searching
                  ? "No listing matches these words. Try other words, or clear the search to see every listing."
                  : "No listing matches this filter yet."}
              </p>
            ) : null}
            {searching && found.data !== null && shown.length > 0 ? (
              <p className="bazaar-foot muted">
                {String(shown.length)} {shown.length === 1 ? "result" : "results"}
                {found.data.method === null ? "" : `, ranked by ${found.data.method} search`}.
              </p>
            ) : null}
          </div>
        </div>

        <ListingPanel
          ref={panelRef}
          listing={selected}
          error={selected === undefined ? linkedError : null}
          loading={loading || (missingId !== null && linked === null && linkedError === null)}
          focusForm={focusForm}
        />
      </div>
    </div>
  );
}

function ListingRow({
  listing,
  index,
  symbol,
  selected,
  onChoose,
}: {
  readonly listing: ListingView;
  readonly index: number;
  readonly symbol: string;
  readonly selected: boolean;
  readonly onChoose: (listing: ListingView, tryIt: boolean) => void;
}): ReactElement {
  const scheme = schemeOf(listing);
  const price = listingPrice(listing, symbol);
  const title = listingTitle(listing);
  return (
    <li
      className="listing-row"
      aria-current={selected ? "true" : undefined}
      style={{ "--order": Math.min(index, 12) } as CSSProperties}
    >
      <span className="listing-name">
        {/* The name's button covers the whole row, so a click anywhere on it shows the listing. */}
        <button
          type="button"
          className="listing-name-button"
          aria-pressed={selected}
          onClick={() => {
            onChoose(listing, false);
          }}
        >
          {title}
        </button>
        <span className="listing-url mono">{displayUrl(listing.resource)}</span>
      </span>
      <span className="listing-type">{listing.type === "mcp" ? "MCP" : "HTTP"}</span>
      <span className="scheme-badge mono" data-mode={scheme ?? undefined}>
        {listing.price?.scheme.toUpperCase() ?? "—"}
      </span>
      <span className="listing-price">
        {price === null ? (
          "—"
        ) : (
          <>
            {price.upto ? "≤ " : ""}
            {price.amount} <span className="listing-symbol">{price.symbol}</span>
          </>
        )}
      </span>
      <button
        type="button"
        className="listing-try"
        aria-label={`Try ${title}`}
        onClick={() => {
          onChoose(listing, true);
        }}
      >
        Try
      </button>
    </li>
  );
}
