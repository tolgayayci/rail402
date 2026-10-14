/**
 * Charge for your API: the seller code, a live check of your endpoint the way the catalog checks it,
 * and your listing in the Bazaar, read by your payTo.
 */
import { useEffect, useMemo, useState, type SubmitEvent, type ReactElement } from "react";
import type { ListingView, VersionView } from "../../engine/events.ts";
import type { CodedError, SellerCheckView } from "../../engine/types.ts";
import { hostOf, short } from "../../projection/format.ts";
import { listingName, priceText, trustLabel } from "../../projection/rows.ts";
import { DocLink } from "../../ui/links.tsx";
import { Notice } from "../../ui/Notice.tsx";
import { SNIPPET_SOURCES, fillSnippet } from "../../ui/snippets.ts";
import { parseSnippet, snippetText } from "../../projection/code.ts";
import { toCodedError, useEngine } from "../engine.tsx";
import { Link } from "../router.tsx";
import { payUrlPath } from "./Pay.tsx";

const LISTING_POLL_MS = 5_000;
const LISTING_POLL_LIMIT = 24;

function Snippet({ source }: { readonly source: string }): ReactElement {
  const { config } = useEngine();
  const text = useMemo(
    () => snippetText(parseSnippet(fillSnippet(source, { cap: config.caps.perCallDefault, config }))),
    [source, config],
  );
  return <pre className="code code-block">{text}</pre>;
}

export function SellPage(): ReactElement {
  const { config } = useEngine();
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Charge for your API</h1>
          <p className="lead">
            Add x402 to an Express route or an MCP tool. Payments settle in {config.asset.symbol} to your
            Stellar address, and the first sale lists you in the Bazaar: no sign-up.
          </p>
        </div>
      </div>
      <div className="sell-grid">
        <ol className="steps">
          <li className="step">
            <span className="step-number">1</span>
            <div className="step-body">
              <h2>Install</h2>
              <Snippet source={SNIPPET_SOURCES.sellerInstall} />
            </div>
          </li>
          <li className="step">
            <span className="step-number">2</span>
            <div className="step-body">
              <h2>Describe and price the route</h2>
              <p>The description and parameters are what agents read in the Bazaar.</p>
              <Snippet source={SNIPPET_SOURCES.sellerRoute} />
            </div>
          </li>
          <li className="step">
            <span className="step-number">3</span>
            <div className="step-body">
              <h2>Use Rail402 as your facilitator</h2>
              <p>It verifies each payment, settles it on Stellar and pays the network fee.</p>
              <Snippet source={SNIPPET_SOURCES.sellerServer} />
            </div>
          </li>
          <li className="step">
            <span className="step-number">4</span>
            <div className="step-body">
              <h2>Get paid, and listed</h2>
              <p>
                The first settled payment adds the route to the Bazaar. The catalog then calls your endpoint
                to confirm it really asks for this price before agents can find it.
              </p>
              <p>
                <Link to="/?scenario=sell">Watch it happen in the lab</Link> with the Playground&apos;s sample
                route.
              </p>
            </div>
          </li>
        </ol>
        <aside className="sell-aside">
          <EndpointCheck />
          <YourListing />
          <p className="muted">
            Selling an MCP tool instead?{" "}
            <DocLink
              doc={{ label: "Use mcpTool()", path: "/sellers/helpers#an-mcp-tool" }}
              docsUrl={config.urls.docs}
            />
            . Billing by usage?{" "}
            <DocLink
              doc={{ label: "Use upto()", path: "/sellers/helpers#charge-what-a-call-used-upto" }}
              docsUrl={config.urls.docs}
            />
            .
          </p>
        </aside>
      </div>
    </>
  );
}

type CheckItem = {
  readonly state: "ok" | "fail" | "optional" | "unknown";
  readonly text: string;
  readonly detail?: string;
};

/** The checklist, from the check's public result. */
export function checklist(view: SellerCheckView, symbol: string): readonly CheckItem[] {
  const required = view.required;
  const items: CheckItem[] = [
    {
      state: view.status === 402 && required !== null ? "ok" : "fail",
      text: "Answers 402 with an x402 price",
      ...(view.status === null
        ? { detail: "no answer" }
        : view.status === 402
          ? {}
          : { detail: `answered ${String(view.status)}` }),
    },
  ];
  if (view.validation !== null) {
    items.push({
      state: view.validation.catalogable ? "ok" : "fail",
      text: "Discovery metadata is valid",
      ...(view.validation.code === null
        ? {}
        : { detail: `${view.validation.code}: ${view.validation.reason ?? ""}` }),
    });
  } else {
    items.push({ state: "fail", text: "Discovery metadata is valid", detail: "no metadata to check" });
  }
  const receivable = view.receivable;
  items.push({
    state:
      receivable.length === 0
        ? "unknown"
        : receivable.every((item) => item.receivable === true)
          ? "ok"
          : receivable.some((item) => item.receivable === false)
            ? "fail"
            : "unknown",
    text: `payTo can receive ${symbol} (trustline)`,
    ...(receivable[0] === undefined ? {} : { detail: short(receivable[0].payTo) }),
  });
  items.push({
    state: view.domain?.claimsOwner === true ? "ok" : "optional",
    text: "stellar.toml lists payTo",
    detail: "optional, earns “domain verified”",
  });
  if (view.domain?.claimsOwner === true) {
    items.push({
      state:
        view.domain.homeDomainMatches === true
          ? "ok"
          : view.domain.homeDomainMatches === false
            ? "fail"
            : "unknown",
      text: `payTo's home domain is ${view.domain.host}`,
    });
  }
  return items;
}

const MARK: Readonly<Record<CheckItem["state"], string>> = {
  ok: "✓",
  fail: "✗",
  optional: "○",
  unknown: "?",
};

function EndpointCheck(): ReactElement {
  const engine = useEngine();
  const { config } = engine;
  const [url, setUrl] = useState("");
  const [toolName, setToolName] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SellerCheckView | null>(null);
  const [error, setError] = useState<CodedError | null>(null);

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    engine
      .sellerCheck({ url: url.trim(), ...(toolName.trim() === "" ? {} : { toolName: toolName.trim() }) })
      .then(setResult, (reason: unknown) => {
        setError(toCodedError(reason));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  if (!config.sellerCheck.enabled) {
    return (
      <section className="card" aria-label="Check your endpoint">
        <div className="card-body">
          <h2>Check your endpoint</h2>
          <Notice
            tone="info"
            error={{
              code: "playground_feature_disabled",
              reason: "The operator has turned the endpoint check off.",
            }}
          />
        </div>
      </section>
    );
  }

  return (
    <section className="card" aria-label="Check your endpoint">
      <form className="card-body stack" onSubmit={submit}>
        <h2>Check your endpoint</h2>
        <label className="field-label" htmlFor="check-url">
          Endpoint URL
        </label>
        <div className="inline-form">
          <input
            id="check-url"
            className="text-input mono"
            type="url"
            required
            placeholder="https://api.example.com/forecast/Ankara"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
            }}
          />
          <button type="submit" className="button-dark" disabled={busy || url.trim() === ""}>
            {busy ? "Checking…" : "Check"}
          </button>
        </div>
        <label className="field-label" htmlFor="check-tool">
          MCP tool name <span className="muted">(only for an MCP endpoint)</span>
        </label>
        <input
          id="check-tool"
          className="text-input mono"
          value={toolName}
          onChange={(event) => {
            setToolName(event.target.value);
          }}
        />
        {error !== null ? <Notice error={error} /> : null}
        {result !== null ? <CheckResultView view={result} /> : null}
        <div className="muted mono">same check: rail402 seller check &lt;url&gt;</div>
      </form>
    </section>
  );
}

function CheckResultView({ view }: { readonly view: SellerCheckView }): ReactElement {
  const { config } = useEngine();
  const items = checklist(view, config.asset.symbol);
  return (
    <div className="check-results" aria-live="polite">
      <ul className="checklist">
        {items.map((item) => (
          <li key={item.text} data-state={item.state}>
            <span className="check-mark" aria-hidden="true">
              {MARK[item.state]}
            </span>
            <span>
              {item.text}
              {item.detail !== undefined ? <span className="muted"> · {item.detail}</span> : null}
            </span>
          </li>
        ))}
      </ul>
      {view.validation !== null && view.validation.lint.length > 0 ? (
        <ul className="findings" aria-label="Metadata notes">
          {view.validation.lint.map((lint) => (
            <li key={lint.code}>
              <code>{lint.code}</code> {lint.reason}
            </li>
          ))}
        </ul>
      ) : null}
      {view.validation !== null && view.validation.dropped.length > 0 ? (
        <p className="muted">Fields the catalog would drop: {view.validation.dropped.join(", ")}</p>
      ) : null}
      {view.findings.length > 0 ? (
        <ul className="findings" aria-label="Findings">
          {view.findings.map((finding, index) => (
            <li key={`${finding.code}-${String(index)}`}>
              <code>{finding.code}</code> {finding.reason}
            </li>
          ))}
        </ul>
      ) : null}
      {view.type === "http" ? (
        <Link className="button-secondary" to={payUrlPath(view.url)}>
          Pay it once from here
        </Link>
      ) : null}
    </div>
  );
}

const TRUST_STEPS = ["settled", "origin_verified", "domain_verified"] as const;

function YourListing(): ReactElement {
  const engine = useEngine();
  const [payTo, setPayTo] = useState("");
  const [query, setQuery] = useState<string | null>(null);
  const [listings, setListings] = useState<readonly ListingView[] | null>(null);
  const [error, setError] = useState<CodedError | null>(null);
  const [polls, setPolls] = useState(0);

  useEffect(() => {
    if (query === null) return undefined;
    let live = true;
    engine.list({ payTo: query, limit: 20 }).then(
      (page) => {
        if (!live) return;
        setListings(page.items);
        setError(null);
      },
      (reason: unknown) => {
        if (live) setError(toCodedError(reason));
      },
    );
    return () => {
      live = false;
    };
  }, [engine, query, polls]);

  // Discovery lists published listings only: a new one appears once its origin check passed. While
  // there is none yet, or one is pending, read again every few seconds, for a while.
  const pending =
    listings !== null && (listings.length === 0 || listings.some((item) => item.state === "pending"));
  useEffect(() => {
    if (!pending || polls >= LISTING_POLL_LIMIT) return undefined;
    const timer = setTimeout(() => {
      setPolls((count) => count + 1);
    }, LISTING_POLL_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [pending, polls]);

  const valid = /^G[A-Z2-7]{55}$/.test(payTo.trim());
  return (
    <section className="card" aria-label="Your listing">
      <form
        className="card-body stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          setPolls(0);
          setListings(null);
          setQuery(payTo.trim());
        }}
      >
        <h2>Your listing</h2>
        <label className="field-label" htmlFor="listing-payto">
          Your payTo address
        </label>
        <div className="inline-form">
          <input
            id="listing-payto"
            className="text-input mono"
            placeholder="G…"
            spellCheck={false}
            value={payTo}
            onChange={(event) => {
              setPayTo(event.target.value);
            }}
          />
          <button type="submit" className="button-secondary" disabled={!valid}>
            Show
          </button>
        </div>
        {error !== null ? <Notice error={error} /> : null}
        {listings !== null && listings.length === 0 ? (
          <p className="muted">
            No listing for this address yet. The first settled payment with the bazaar extension creates it,
            and it is listed once Rail402 has checked its origin.
          </p>
        ) : null}
        {listings?.map((item) => (
          <ListingCard key={item.id} listing={item} />
        ))}
        {pending ? <p className="muted">This refreshes every few seconds for two minutes.</p> : null}
      </form>
    </section>
  );
}

function ListingCard({ listing }: { readonly listing: ListingView }): ReactElement {
  const engine = useEngine();
  const [versions, setVersions] = useState<readonly VersionView[] | null>(null);
  const [error, setError] = useState<CodedError | null>(null);
  const reached = TRUST_STEPS.indexOf(listing.trust);
  return (
    <div className="listing-card">
      <div className="listing-top">
        <span className="mono">{listingName(listing)}</span>
        <span className="mono">{priceText(listing)}</span>
      </div>
      <div className="muted">{listing.description ?? hostOf(listing.resource)}</div>
      <div className="trust-steps" aria-label={`Trust: ${trustLabel(listing.trust)}`}>
        {TRUST_STEPS.map((step, index) => (
          <span key={step} className="trust-step" data-reached={index <= reached}>
            {trustLabel(step)}
          </span>
        ))}
      </div>
      <div className="muted">
        {listing.state ?? "unknown"} · version {listing.version} · {listing.settlements} settlement
        {listing.settlements === 1 ? "" : "s"}
      </div>
      <button
        type="button"
        className="link-button"
        onClick={() => {
          engine.versions(listing.id).then(setVersions, (reason: unknown) => {
            setError(toCodedError(reason));
          });
        }}
      >
        Version history
      </button>
      {error !== null ? <Notice error={error} /> : null}
      {versions !== null ? <VersionList versions={versions} /> : null}
    </div>
  );
}

export function VersionList({ versions }: { readonly versions: readonly VersionView[] }): ReactElement {
  return (
    <ol className="versions">
      {versions.map((version) => (
        <li key={version.version}>
          <span className="mono">v{version.version}</span> {version.cause.replace(/_/g, " ")} ·{" "}
          {version.state} · {trustLabel(version.trust)} ·{" "}
          <time dateTime={version.createdAt}>{version.createdAt}</time>
          {version.reason !== null ? <span className="muted"> · {version.reason}</span> : null}
        </li>
      ))}
    </ol>
  );
}
