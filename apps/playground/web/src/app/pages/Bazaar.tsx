/**
 * The Bazaar: search every API and MCP tool paid through Rail402 in plain language, and pay one from
 * the Pay page. Listings come from real payments; sellers never register.
 */
import { useCallback, useEffect, useState, type SubmitEvent, type ReactElement } from "react";
import type { ListingView, VersionView } from "../../engine/events.ts";
import type { CodedError, SearchPage, SearchRequest } from "../../engine/types.ts";
import { hostOf } from "../../projection/format.ts";
import { listingName, priceText, trustLabel } from "../../projection/rows.ts";
import { DocLink } from "../../ui/links.tsx";
import { Notice } from "../../ui/Notice.tsx";
import { DOCS } from "../../projection/docs.ts";
import { toCodedError, useEngine } from "../engine.tsx";
import { Link } from "../router.tsx";
import { payListingPath } from "./Pay.tsx";
import { VersionList } from "./Sell.tsx";

type Filter = "all" | "http" | "mcp" | "exact" | "upto" | "verified";

const FILTERS: readonly { readonly id: Filter; readonly label: string }[] = [
  { id: "all", label: "All" },
  { id: "http", label: "HTTP" },
  { id: "mcp", label: "MCP tools" },
  { id: "exact", label: "Fixed price" },
  { id: "upto", label: "Pay per use" },
  { id: "verified", label: "Verified sellers" },
];

const DEFAULT_QUERY = "weather for a city";

/** The Bazaar request for a query and filter. Scheme filters apply to the returned page. */
export function searchRequest(query: string, filter: Filter, cursor?: string): SearchRequest {
  return {
    query,
    limit: 10,
    ...(filter === "http" || filter === "mcp" ? { type: filter } : {}),
    ...(filter === "verified" ? { minimumTrust: "domain_verified" as const } : {}),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

function shown(items: readonly ListingView[], filter: Filter): readonly ListingView[] {
  if (filter !== "exact" && filter !== "upto") return items;
  return items.filter((item) => item.price?.scheme === filter);
}

export function BazaarPage(): ReactElement {
  const engine = useEngine();
  const { config } = engine;
  const [query, setQuery] = useState(DEFAULT_QUERY);
  const [filter, setFilter] = useState<Filter>("all");
  const [submitted, setSubmitted] = useState({ query: DEFAULT_QUERY, filter: "all" as Filter });
  const [pages, setPages] = useState<readonly SearchPage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CodedError | null>(null);

  const load = useCallback(
    (request: SearchRequest, append: boolean): (() => void) => {
      let live = true;
      setBusy(true);
      setError(null);
      engine
        .search(request)
        .then(
          (page) => {
            if (live) setPages((current) => (append ? [...current, page] : [page]));
          },
          (reason: unknown) => {
            if (live) setError(toCodedError(reason));
          },
        )
        .finally(() => {
          if (live) setBusy(false);
        });
      return () => {
        live = false;
      };
    },
    [engine],
  );

  useEffect(() => load(searchRequest(submitted.query, submitted.filter), false), [load, submitted]);

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (query.trim() === "") return;
    setSubmitted({ query: query.trim(), filter });
  };

  const items = pages.flatMap((page) => shown(page.items, submitted.filter));
  const last = pages.at(-1);
  const partial = pages.some((page) => page.partialResults);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Bazaar</h1>
          <p className="lead">
            Every API and MCP tool paid through Rail402, searchable in plain language. Listings come from real
            payments: sellers never register.
          </p>
        </div>
        <span className="endpoint-pill mono">GET /discovery/search?query=…</span>
      </div>

      <form role="search" className="search-form" onSubmit={submit}>
        <label htmlFor="bazaar-query" className="visually-hidden">
          Search the Bazaar
        </label>
        <input
          id="bazaar-query"
          className="text-input search-input"
          type="search"
          maxLength={500}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
        <button type="submit" className="button-dark" disabled={busy || query.trim() === ""}>
          Search
        </button>
      </form>
      <div className="filters" role="group" aria-label="Filters">
        {FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            className="chip"
            aria-pressed={item.id === filter}
            onClick={() => {
              setFilter(item.id);
              setSubmitted({ query: query.trim() === "" ? submitted.query : query.trim(), filter: item.id });
            }}
          >
            {item.label}
          </button>
        ))}
      </div>

      {error !== null ? <Notice error={error} /> : null}
      {partial ? (
        <p className="note" role="status">
          Partial results: the Bazaar answered from part of its index, so the ranking may be incomplete.
        </p>
      ) : null}

      <div className="card table-card" aria-busy={busy}>
        <table className="listings">
          <thead>
            <tr>
              <th scope="col">Resource</th>
              <th scope="col">Type</th>
              <th scope="col">Price</th>
              <th scope="col">Seller</th>
              <th scope="col">
                <span className="visually-hidden">Action</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <ListingRow key={item.id} listing={item} />
            ))}
          </tbody>
        </table>
        {items.length === 0 && !busy ? (
          <p className="card-body muted">No listing matches. Try other words or another filter.</p>
        ) : null}
        <div className="table-foot">
          <span className="muted">
            {last?.method === null || last === undefined ? "" : `Ranked by ${last.method} search`}
          </span>
          {last?.cursor !== null && last?.cursor !== undefined ? (
            <button
              type="button"
              className="button-secondary"
              disabled={busy}
              onClick={() => {
                load(searchRequest(submitted.query, submitted.filter, last.cursor ?? undefined), true);
              }}
            >
              More results
            </button>
          ) : null}
        </div>
      </div>
      <p className="muted">
        <span className="verified-mark">✓</span> verified: the seller&apos;s domain publishes its Stellar
        address in stellar.toml. <Link to="/sell">List your own API →</Link>{" "}
        <DocLink doc={DOCS.search} docsUrl={config.urls.docs} />
      </p>
    </>
  );
}

function ListingRow({ listing }: { readonly listing: ListingView }): ReactElement {
  const engine = useEngine();
  const [versions, setVersions] = useState<readonly VersionView[] | null>(null);
  const [error, setError] = useState<CodedError | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr>
        <td>
          <div className="mono listing-name">{listingName(listing)}</div>
          <div className="muted">{listing.description ?? ""}</div>
        </td>
        <td>{listing.type === "mcp" ? "MCP tool" : "HTTP"}</td>
        <td className="mono">{priceText(listing)}</td>
        <td>
          {hostOf(listing.resource)}{" "}
          <span className="trust" data-trust={listing.trust} title={trustLabel(listing.trust)}>
            {listing.trust === "domain_verified" ? "✓" : trustLabel(listing.trust)}
          </span>
        </td>
        <td className="actions">
          <button
            type="button"
            className="link-button"
            aria-expanded={open}
            onClick={() => {
              setOpen(!open);
              if (versions === null) {
                engine.versions(listing.id).then(setVersions, (reason: unknown) => {
                  setError(toCodedError(reason));
                });
              }
            }}
          >
            History
          </button>
          {listing.callable === false ? (
            <span className="not-payable">
              <span className="muted">not payable here</span>
              {listing.notPayable !== undefined && listing.notPayable !== null ? (
                <>
                  <code>{listing.notPayable.code}</code>
                  <span className="muted">{listing.notPayable.reason}</span>
                </>
              ) : null}
            </span>
          ) : (
            <Link className="button-secondary" to={payListingPath(listing.id)}>
              Try
            </Link>
          )}
        </td>
      </tr>
      {open ? (
        <tr className="listing-details">
          <td colSpan={5}>
            {error !== null ? <Notice error={error} /> : null}
            {versions !== null ? (
              <VersionList versions={versions} />
            ) : error === null ? (
              <span aria-busy="true">Loading…</span>
            ) : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}
