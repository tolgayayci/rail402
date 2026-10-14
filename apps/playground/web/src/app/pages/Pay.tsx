/**
 * Pay for an API: call a paid endpoint with the test wallet. The resource is the demo weather route,
 * a Bazaar listing (`?listing=`), or any URL (`?url=`). Below it, the refusal checks prove what the
 * buyer refuses to sign.
 */
import { useEffect, useMemo, useRef, useState, type SubmitEvent, type ReactElement } from "react";
import type { CheckId, JsonValue, LabEvent, ListingView } from "../../engine/events.ts";
import type { CodedError, HttpMethod, PayRequest, PriceView, RunHandle } from "../../engine/types.ts";
import { CHECK_IDS, SCENARIO_DEFAULTS, SESSION_CHECK_WINDOW } from "../../../../src/shared/lab.ts";
import { capState } from "../../projection/cap.ts";
import {
  collectFacts,
  facilitatorShown,
  httpExchanges,
  paidAmount,
  paysMcpTool,
  settlementTx,
} from "../../projection/facts.ts";
import { displayUrl, duration, hostOf, short, signedAmount, toDecimal } from "../../projection/format.ts";
import { projectCheck, projectOutcome } from "../../projection/outcome.ts";
import { listingName, priceText, statusText, trustLabel } from "../../projection/rows.ts";
import { CapInput } from "../../ui/CapInput.tsx";
import { CodePanel } from "../../ui/CodePanel.tsx";
import { FlowLayout, useFlowProjection, useRowSelection } from "../../ui/flow.tsx";
import { DocLink, ExternalLink } from "../../ui/links.tsx";
import { Notice } from "../../ui/Notice.tsx";
import { payTabs, type PaySnippetRequest } from "../../ui/snippets.ts";
import { DOCS } from "../../projection/docs.ts";
import { toCodedError, useEngine, useEngineState, useRunView } from "../engine.tsx";
import { canRun } from "../gate.ts";
import { WalletPrompt } from "../wallet.tsx";
import { Link, useLocation } from "../router.tsx";
import { usePageRun, useRuns } from "../runs.tsx";
import { RunReportButton } from "./Lab.tsx";

const METHODS: readonly HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];

type Resource =
  { readonly kind: "demo" } | { readonly kind: "url" } | { readonly kind: "listing"; readonly id: string };

export function PayPage(): ReactElement {
  const engine = useEngine();
  const state = useEngineState();
  const { config } = engine;
  const { search } = useLocation();

  const listingId = search.get("listing");
  const urlParam = search.get("url");
  const resource: Resource =
    listingId !== null
      ? { kind: "listing", id: listingId }
      : urlParam !== null
        ? { kind: "url" }
        : { kind: "demo" };

  const [city, setCity] = useState<string>(SCENARIO_DEFAULTS.pay.query.city);
  const [url, setUrl] = useState(urlParam ?? "");
  const [method, setMethod] = useState<HttpMethod>("GET");
  const [body, setBody] = useState("");
  const [params, setParams] = useState("{}");
  // Set once the visitor types parameters, so a listing that loads later never overwrites them.
  const paramsEdited = useRef(false);
  const [cap, setCap] = useState(config.caps.perCallDefault);
  // The last payment stays on the page while the visitor looks at other pages.
  const [handle, setHandle] = usePageRun("pay");
  const [formError, setFormError] = useState<CodedError | null>(null);

  const [listing, setListing] = useState<ListingView | null>(null);
  const [listingError, setListingError] = useState<CodedError | null>(null);
  useEffect(() => {
    if (listingId === null) return undefined;
    let live = true;
    paramsEdited.current = false;
    setListing(null);
    setListingError(null);
    engine.listing(listingId).then(
      (found) => {
        if (!live) return;
        setListing(found);
        // Prefill the parameters with the seller's example, and every path parameter by name,
        // unless the visitor already typed their own.
        if (!paramsEdited.current) setParams(paramsTemplate(found));
      },
      (reason: unknown) => {
        if (live) setListingError(toCodedError(reason));
      },
    );
    return () => {
      live = false;
    };
  }, [engine, listingId]);

  useEffect(() => {
    if (urlParam !== null) setUrl(urlParam);
  }, [urlParam]);

  const demoUrl = useMemo(() => {
    const target = new URL(SCENARIO_DEFAULTS.pay.path, `${config.urls.demoSeller.replace(/\/+$/, "")}/`);
    target.searchParams.set("city", city);
    return target.href;
  }, [config.urls.demoSeller, city]);

  const capCheck = capState(cap, config.caps.perCallCeiling, config.asset.decimals);
  const payUrl =
    resource.kind === "demo" ? demoUrl : resource.kind === "url" ? url : (listing?.resource ?? "");
  const snippetRequest = useMemo(
    () => snippetRequestOf(resource, { method, body, params, listing }),
    // The resource is derived from the query: its kind and the listing id stand for it.
    [resource.kind, listingId, method, body, params, listing],
  );
  const tabs = useMemo(
    () =>
      payTabs({
        cap: capCheck.valid ? capCheck.effective : cap,
        config,
        url: payUrl === "" ? "https://…" : payUrl,
        ...(snippetRequest === undefined ? {} : { request: snippetRequest }),
      }),
    [capCheck, cap, config, payUrl, snippetRequest],
  );

  const view = useRunView(handle);
  const running = handle !== null && view.summary === null;

  // The demo route's price, read from one unpaid request (nothing is signed), so the button says it.
  const [demoPrice, setDemoPrice] = useState<PriceView | null>(null);
  const walletReady = state.wallet.status === "ready";
  useEffect(() => {
    if (resource.kind !== "demo" || !walletReady) return undefined;
    let live = true;
    const timer = setTimeout(() => {
      engine.quote(demoUrl).then(
        (price) => {
          if (live) setDemoPrice(price);
        },
        () => {
          if (live) setDemoPrice(null);
        },
      );
    }, 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [engine, resource.kind, demoUrl, walletReady]);
  const price: { readonly text: string; readonly upto: boolean } | null =
    resource.kind === "demo"
      ? demoPrice === null || demoPrice.amount === null
        ? null
        : { text: `${demoPrice.amount} ${demoPrice.symbol}`, upto: demoPrice.scheme === "upto" }
      : resource.kind === "listing" && listing?.price !== null && listing?.price !== undefined
        ? {
            text:
              listing.price.decimal === null
                ? `${listing.price.amount} base units`
                : `${listing.price.decimal} ${listing.price.symbol ?? config.asset.symbol}`,
            upto: listing.price.scheme === "upto",
          }
        : null;

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!capCheck.valid || running || !canRun(state)) return;
    const request = buildRequest(resource, {
      demoUrl,
      url,
      method,
      body,
      params,
      cap: capCheck.value,
      ...(listing === null ? {} : { listingType: listing.type }),
    });
    if ("code" in request) {
      setFormError(request);
      return;
    }
    setFormError(null);
    try {
      setHandle(engine.pay(request));
    } catch (error) {
      setFormError(toCodedError(error));
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Pay for an API</h1>
          <p className="lead">
            Call a paid endpoint with your test wallet. The same request runs from the SDK, the CLI or an
            agent.
          </p>
        </div>
      </div>

      <div className="pay-grid">
        <form className="card pay-request" aria-label="Request" onSubmit={submit}>
          <div className="card-body stack">
            <span className="field-label">Resource</span>
            {resource.kind === "demo" ? (
              <div className="resource">
                <span className="resource-name mono">
                  GET {displayUrl(`${config.urls.demoSeller}/weather`)}
                </span>
                <span className="resource-desc">Current weather for a city, from the demo seller</span>
                <span className="resource-meta">
                  {demoPrice === null || demoPrice.amount === null
                    ? walletReady
                      ? "reading the price…"
                      : "the price comes in the seller's 402"
                    : `${demoPrice.scheme === "upto" ? "up to " : ""}${demoPrice.amount} ${demoPrice.symbol}`}
                </span>
              </div>
            ) : null}
            {resource.kind === "listing" ? (
              listing !== null ? (
                <ListingSummary listing={listing} />
              ) : listingError !== null ? (
                <Notice error={listingError} />
              ) : (
                <p aria-busy="true">Loading the listing…</p>
              )
            ) : null}
            {resource.kind === "url" ? (
              <div className="stack-tight">
                <label className="field-label" htmlFor="pay-url">
                  URL
                </label>
                <input
                  id="pay-url"
                  className="text-input mono"
                  type="url"
                  required
                  placeholder="https://api.example.com/resource"
                  value={url}
                  onChange={(event) => {
                    setUrl(event.target.value);
                  }}
                />
                {urlParam !== null && urlParam !== "" && url === urlParam ? (
                  <span className="muted">
                    This URL came from the link you opened. Check where it points before you pay it or run the
                    code below.
                  </span>
                ) : null}
                <label className="field-label" htmlFor="pay-method">
                  Method
                </label>
                <select
                  id="pay-method"
                  className="text-input"
                  value={method}
                  onChange={(event) => {
                    setMethod(event.target.value as HttpMethod);
                  }}
                >
                  {METHODS.map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
                {method === "POST" || method === "PUT" || method === "PATCH" ? (
                  <>
                    <label className="field-label" htmlFor="pay-body">
                      JSON body
                    </label>
                    <textarea
                      id="pay-body"
                      className="text-input mono"
                      rows={4}
                      value={body}
                      onChange={(event) => {
                        setBody(event.target.value);
                      }}
                    />
                  </>
                ) : null}
              </div>
            ) : null}
            <div className="resource-links">
              <Link to="/bazaar">Choose another from the Bazaar</Link>
              {resource.kind !== "url" ? (
                <Link to="/pay?url=">Pay any URL</Link>
              ) : (
                <Link to="/pay">Back to the demo route</Link>
              )}
            </div>

            {resource.kind === "demo" ? (
              <div className="stack-tight">
                <label className="field-label" htmlFor="pay-city">
                  city
                </label>
                <input
                  id="pay-city"
                  className="text-input"
                  required
                  value={city}
                  onChange={(event) => {
                    setCity(event.target.value);
                  }}
                />
              </div>
            ) : null}
            {resource.kind === "listing" ? (
              <div className="stack-tight">
                <label className="field-label" htmlFor="pay-params">
                  {listing?.type === "mcp" ? "Tool arguments (JSON)" : "Path and query parameters (JSON)"}
                </label>
                {listing?.input !== undefined && listing.input.required.length > 0 ? (
                  <span className="muted">
                    Required: {listing.input.required.join(", ")}
                    {listing.input.pathParams.length > 0
                      ? ` (path: ${listing.input.pathParams.join(", ")})`
                      : ""}
                    . The example comes from the seller.
                  </span>
                ) : null}
                <textarea
                  id="pay-params"
                  className="text-input mono"
                  rows={3}
                  value={params}
                  onChange={(event) => {
                    paramsEdited.current = true;
                    setParams(event.target.value);
                  }}
                />
              </div>
            ) : null}

            <CapInput
              value={cap}
              onChange={setCap}
              ceiling={config.caps.perCallCeiling}
              decimals={config.asset.decimals}
              symbol={config.asset.symbol}
              presets={[
                {
                  label: `${config.caps.perCallDefault} ${config.asset.symbol}`,
                  value: config.caps.perCallDefault,
                },
                {
                  label: `${config.caps.perCallLowPreset} ${config.asset.symbol}`,
                  value: config.caps.perCallLowPreset,
                },
              ]}
            />
            <button
              type="submit"
              className="button-primary button-wide"
              disabled={
                !capCheck.valid ||
                running ||
                !canRun(state) ||
                (resource.kind === "listing" && listing === null)
              }
            >
              {running
                ? "Paying…"
                : price === null
                  ? `Pay up to ${capCheck.valid ? capCheck.effective : "your cap"} ${config.asset.symbol} and call`
                  : `Pay ${price.upto ? "up to " : ""}${price.text} and call`}
            </button>
            {price !== null ? (
              <span className="muted">
                Your cap: {capCheck.valid ? capCheck.effective : cap} {config.asset.symbol} per call; a higher
                price is refused before signing.
              </span>
            ) : null}
            <span className="muted">No XLM needed: the facilitator pays the network fee.</span>
            {!config.relay.enabled ? (
              <Notice
                tone="info"
                error={{
                  code: "playground_feature_disabled",
                  reason: "The relay is turned off on this Playground, so it cannot call other sellers.",
                }}
              />
            ) : null}
            <WalletPrompt state={state} running={running} />
            {formError !== null ? <Notice error={formError} /> : null}
          </div>
        </form>

        <PayResult events={view.events} running={running} started={handle !== null} />
      </div>

      <section className="card section" aria-labelledby="code-heading">
        <div className="card-body">
          <h2 id="code-heading">Run it from your code</h2>
          <CodePanel tabs={tabs} step={undefined} hint="same request, other surfaces" />
        </div>
      </section>

      {handle !== null ? (
        <details className="card section under-the-hood" open={view.summary !== null}>
          <summary>What happened under the hood</summary>
          <UnderTheHood events={view.events} target={payUrl} />
          {view.summary !== null ? <RunReportButton runId={view.runId} /> : null}
        </details>
      ) : (
        <details className="card section under-the-hood">
          <summary>What happens under the hood</summary>
          <p className="card-body">
            A 402 with the price → your buyer signs one authorization within your cap → the facilitator
            verifies and settles it on Stellar → the API returns the response and a receipt. Pay once to see
            every message.
          </p>
        </details>
      )}

      <ChecksPanel />
    </>
  );
}

interface FormValues {
  readonly demoUrl: string;
  readonly url: string;
  readonly method: HttpMethod;
  readonly body: string;
  readonly params: string;
  readonly cap: string;
  /** The listing's type, once it has been read. */
  readonly listingType?: "http" | "mcp";
}

/** The engine request for the form, or a coded error for invalid input. */
export function buildRequest(resource: Resource, values: FormValues): PayRequest | CodedError {
  const invalid = (reason: string): CodedError => ({
    code: "playground_request_invalid",
    reason,
    retryable: false,
  });
  switch (resource.kind) {
    case "demo":
      return { target: values.demoUrl, method: "GET", cap: values.cap };
    case "url": {
      if (!URL.canParse(values.url))
        return invalid("Enter an absolute URL, such as https://api.example.com/resource.");
      const withBody = values.method === "POST" || values.method === "PUT" || values.method === "PATCH";
      if (!withBody || values.body.trim() === "")
        return { target: values.url, method: values.method, cap: values.cap };
      const parsed = parseJson(values.body);
      if (parsed === undefined) return invalid("The body is not valid JSON.");
      return { target: values.url, method: values.method, body: parsed, cap: values.cap };
    }
    case "listing": {
      const parsed = values.params.trim() === "" ? {} : parseJson(values.params);
      if (parsed === undefined || parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
        return invalid('The parameters must be a JSON object, such as { "city": "Ankara" }.');
      return {
        listingId: resource.id,
        ...(values.listingType === undefined ? {} : { type: values.listingType }),
        params: parsed as Readonly<Record<string, JsonValue>>,
        cap: values.cap,
      };
    }
  }
}

function parseJson(text: string): JsonValue | undefined {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

function ListingSummary({ listing }: { readonly listing: ListingView }): ReactElement {
  return (
    <div className="resource">
      <span className="resource-name mono">
        {listing.type === "mcp" ? `${listing.toolName ?? "tool"} · MCP` : listingName(listing)}
      </span>
      <span className="resource-desc">{listing.description ?? displayUrl(listing.resource)}</span>
      <span className="resource-meta">
        {priceText(listing)} · {hostOf(listing.resource)} · {trustLabel(listing.trust)}
      </span>
    </div>
  );
}

/** The result card: the outcome of the last payment, with the money, the fee and the transaction. */
function PayResult({
  events,
  running,
  started,
}: {
  readonly events: readonly LabEvent[];
  readonly running: boolean;
  readonly started: boolean;
}): ReactElement {
  const { config } = useEngine();
  const outcome = useMemo(
    () =>
      projectOutcome(events, { asset: config.asset, sellerLabel: "Seller", facilitatorLabel: "Facilitator" }),
    [events, config.asset],
  );
  const facts = useMemo(() => collectFacts(events), [events]);
  const exchanges = httpExchanges(facts);
  const paid = exchanges.paid;
  const mcp = paysMcpTool(facts);
  const paidSoFar = paidAmount(facts);
  const tx = settlementTx(facts);
  if (!started) {
    return (
      <section className="card pay-result" aria-label="Result" data-state="idle">
        <div className="card-body">
          <p className="muted">
            Pay once to see the result here: what you paid, who paid the network fee, the transaction on
            Stellar, and the response.
          </p>
        </div>
      </section>
    );
  }
  if (outcome === undefined) {
    return (
      <section className="card pay-result" aria-label="Result" aria-busy={running}>
        <div className="card-body">
          <p>Paying… {events.length > 0 ? `${String(events.length)} steps so far.` : ""}</p>
        </div>
      </section>
    );
  }
  const response = paid?.response ?? exchanges.probe?.response;
  const delivery = facts.delivery;
  const toolName = paid?.request.rpc?.toolName ?? undefined;
  return (
    <section className="pay-result outcome" data-kind={outcome.kind} aria-label="Result">
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
      <dl className="stats">
        <div>
          <dt>Paid</dt>
          <dd className="mono">
            {paidSoFar === undefined
              ? `0 ${config.asset.symbol}`
              : `${toDecimal(paidSoFar.atomic, config.asset.decimals) ?? paidSoFar.atomic} ${config.asset.symbol}${
                  paidSoFar.proven ? "" : " (reported, not proven)"
                }`}
          </dd>
        </div>
        <div>
          <dt>Network fee</dt>
          <dd>{tx === undefined ? "none" : tx.feeBump === null ? "paid by the payer" : "Sponsored"}</dd>
        </div>
        <div>
          <dt>Settled in</dt>
          <dd className="mono">{paid?.response === undefined ? "—" : duration(paid.response.ms)}</dd>
        </div>
      </dl>
      <div className="result-links">
        {outcome.tx !== null ? (
          <ExternalLink className="tx-link mono" href={outcome.tx.explorerUrl}>
            tx {short(outcome.tx.hash, 8)} in the explorer <span aria-hidden="true">↗</span>
          </ExternalLink>
        ) : null}
        <DocLink doc={DOCS.x402} docsUrl={config.urls.docs} />
      </div>
      {mcp ? (
        delivery !== undefined || response !== undefined ? (
          <div className="response-line">
            <span className="eyebrow-label">Response</span>
            <span className="mono">
              {delivery?.isError === true || response?.rpc?.isError === true
                ? "tool error"
                : `tool result${toolName === undefined ? "" : ` from ${toolName}`}`}
            </span>
          </div>
        ) : null
      ) : response !== undefined ? (
        <div className="response-line">
          <span className="eyebrow-label">Response</span>
          <span className="mono">
            {response.status} {statusText(response.status)}
            {delivery?.contentType === undefined || delivery.contentType === null
              ? ""
              : ` · ${delivery.contentType}`}
          </span>
        </div>
      ) : null}
      {delivery?.body !== undefined && delivery.body !== null ? (
        <pre className="response-body mono" aria-label="Response body">
          {bodyText(delivery.body, delivery.contentType)}
          {delivery.truncated ? "\n…" : ""}
        </pre>
      ) : null}
    </section>
  );
}

/** A delivered body as text: JSON indented, anything else as it came. Seller content: text only. */
function bodyText(body: string, contentType: string | null): string {
  if (contentType === null || !/json/i.test(contentType)) return body;
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function UnderTheHood({
  events,
  target,
}: {
  readonly events: readonly LabEvent[];
  readonly target: string;
}): ReactElement {
  const { config } = useEngine();
  const runId = events[0]?.runId ?? null;
  // The facilitator lane is Rail402 only when Rail402's /supported advertises its settler or fee payer.
  const rail402 = useMemo(() => facilitatorShown(collectFacts(events)), [events]);
  const projection = useFlowProjection(
    events,
    "pay",
    {
      sellerHost: hostOf(target),
      sellerLabel: "Seller",
      ...(rail402 ? {} : { facilitatorLabel: "Facilitator" }),
    },
    config.asset,
  );
  const { selected, select } = useRowSelection(projection.rows, runId);
  return (
    <FlowLayout
      scenario="pay"
      projection={projection}
      selected={selected}
      onSelect={select}
      codeTabs={[]}
      docsUrl={config.urls.docs}
      idle={null}
      head={<span className="flow-url mono">{displayUrl(target)}</span>}
    />
  );
}

const CHECKS: Readonly<Record<CheckId, { readonly title: string; readonly how: string }>> = {
  network: { title: "Wrong network", how: "A 402 that asks to be paid on stellar:pubnet." },
  asset: { title: "Asset not allowed", how: "A 402 priced in an asset your policy does not list." },
  amount: { title: "Amount not allowed", how: "A 402 that asks for an amount of 0." },
  recipient: { title: "Recipient blocked", how: "The demo route, with its payTo on your deny list." },
  "per-call-cap": { title: "Over the per-call cap", how: "The demo route with a cap below its price." },
  "session-budget": {
    title: "Session budget used up",
    how: `Pays ${SESSION_CHECK_WINDOW.total} USDC once from your session budget, with room left for that one payment only; the second payment is refused.`,
  },
  "private-address": { title: "Private address", how: "Pay a loopback and a cloud-metadata address." },
};

/** The refusal checks: each must end refused with its code, nothing signed and balances unchanged. */
function ChecksPanel(): ReactElement {
  const engine = useEngine();
  const state = useEngineState();
  const runs = useRuns();
  const offered = CHECK_IDS.filter((id) => engine.config.lab.checks.includes(id));
  const turnedOff = CHECK_IDS.filter((id) => !engine.config.lab.checks.includes(id));
  const { handles, sequence, error } = runs.checks;
  const { stopChecks } = runs;
  // Leaving the page stops "run all" after the check in progress: nothing keeps paying unseen.
  useEffect(() => stopChecks, [stopChecks]);

  const start = (id: CheckId): RunHandle | undefined => runs.startCheck(id);
  const runAll = (): Promise<void> => runs.runAllChecks(offered);

  const busy = sequence || state.activeRun !== null;
  return (
    <section className="card section" aria-labelledby="checks-heading">
      <div className="card-body">
        <div className="section-head">
          <div>
            <h2 id="checks-heading">What your buyer refuses</h2>
            <p className="muted">
              Each check sends a payment your policy must refuse. A check passes when it is refused with the
              expected code, nothing is signed, and your balance does not move; the session budget check pays
              once first, so its first payment is the only one that moves funds.
            </p>
          </div>
          <button
            type="button"
            className="button-secondary"
            disabled={busy || !canRun(state)}
            onClick={() => {
              void runAll();
            }}
          >
            {sequence ? "Running the checks…" : "Run all checks"}
          </button>
        </div>
        {error !== null ? <Notice error={error} /> : null}
        {turnedOff.length > 0 ? (
          <Notice
            tone="info"
            error={{
              code: "playground_feature_disabled",
              reason: `Turned off on this Playground: ${turnedOff.map((id) => CHECKS[id].title).join(", ")}.`,
            }}
          />
        ) : null}
        <ul className="checks">
          {offered.map((id) => (
            <CheckRow
              key={id}
              check={id}
              handle={handles[id] ?? null}
              disabled={busy || !canRun(state)}
              onRun={() => {
                runs.clearCheckError();
                start(id);
              }}
            />
          ))}
        </ul>
      </div>
    </section>
  );
}

function CheckRow({
  check,
  handle,
  disabled,
  onRun,
}: {
  readonly check: CheckId;
  readonly handle: RunHandle | null;
  readonly disabled: boolean;
  readonly onRun: () => void;
}): ReactElement {
  const { config } = useEngine();
  const view = useRunView(handle);
  const result = useMemo(
    () => projectCheck(check, view.events, config.asset.decimals),
    [check, view.events, config.asset.decimals],
  );
  const state = handle === null ? "idle" : !result.finished ? "running" : result.passed ? "passed" : "failed";
  return (
    <li className="check" data-state={state}>
      <div className="check-main">
        <span className="check-mark" aria-hidden="true">
          {state === "passed" ? "✓" : state === "failed" ? "✗" : state === "running" ? "…" : "○"}
        </span>
        <div>
          <div className="check-title">{CHECKS[check].title}</div>
          <div className="muted">{CHECKS[check].how}</div>
          <div className="check-expected">
            expects <code>{result.expected}</code>
          </div>
        </div>
        <button type="button" className="button-secondary" disabled={disabled} onClick={onRun}>
          {handle === null ? "Run" : "Run again"}
        </button>
      </div>
      {result.finished ? (
        <dl className="check-result">
          <div>
            <dt>Result</dt>
            <dd>{state === "passed" ? "refused as expected" : "not as expected"}</dd>
          </div>
          <div>
            <dt>Code</dt>
            <dd>
              <code>{result.code ?? "none"}</code>
            </dd>
          </div>
          {result.reason !== null ? (
            <div>
              <dt>Reason</dt>
              <dd>{result.reason}</dd>
            </div>
          ) : null}
          {result.layer !== null ? (
            <div>
              <dt>Refused by</dt>
              <dd>{result.layer}</dd>
            </div>
          ) : null}
          <div>
            <dt>Signed</dt>
            <dd>{result.signed === 0 ? "nothing" : `${String(result.signed)} authorization(s)`}</dd>
          </div>
          {result.paid.length > 0 ? (
            <div>
              <dt>Paid</dt>
              <dd>
                {result.paid.map((tx) => (
                  <ExternalLink key={tx.hash} className="tx-link mono" href={tx.explorerUrl}>
                    tx {short(tx.hash, 8)} in the explorer <span aria-hidden="true">↗</span>
                  </ExternalLink>
                ))}
              </dd>
            </div>
          ) : null}
          <div>
            <dt>Balance</dt>
            <dd>
              {result.balance === "unchanged"
                ? "unchanged"
                : result.balance === "changed"
                  ? `${signedAmount(result.delta ?? "", config.asset.symbol)}${
                      check === "session-budget" ? " (the first payment, from your session budget)" : ""
                    }`
                  : "not read"}
            </dd>
          </div>
        </dl>
      ) : null}
    </li>
  );
}

/** The request the code tabs show for the form as it stands; undefined for the demo route. */
function snippetRequestOf(
  resource: Resource,
  values: {
    readonly method: HttpMethod;
    readonly body: string;
    readonly params: string;
    readonly listing: ListingView | null;
  },
): PaySnippetRequest | undefined {
  if (resource.kind === "url") {
    const withBody = values.method === "POST" || values.method === "PUT" || values.method === "PATCH";
    const body = withBody && values.body.trim() !== "" ? parseJson(values.body) : undefined;
    return { kind: "url", method: values.method, ...(body === undefined ? {} : { body }) };
  }
  if (resource.kind !== "listing" || values.listing === null) return undefined;
  const parsed = values.params.trim() === "" ? {} : parseJson(values.params);
  const params =
    parsed !== undefined && parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Readonly<Record<string, JsonValue>>)
      : {};
  return {
    kind: "listing",
    listingId: resource.id,
    type: values.listing.type,
    toolName: values.listing.toolName,
    pathParams: values.listing.input?.pathParams ?? [],
    params,
  };
}

/** The parameters box for a listing: the seller's example, with every path parameter named. */
export function paramsTemplate(listing: ListingView): string {
  const example = listing.input?.example;
  const base: Record<string, JsonValue> =
    example !== null && example !== undefined && typeof example === "object" && !Array.isArray(example)
      ? { ...(example as Readonly<Record<string, JsonValue>>) }
      : {};
  for (const name of listing.input?.pathParams ?? []) base[name] ??= "";
  return Object.keys(base).length === 0 ? "{}" : JSON.stringify(base, null, 2);
}

/** Opens the Pay page for a listing. */
export function payListingPath(listingId: string): string {
  return `/pay?${new URLSearchParams({ listing: listingId }).toString()}`;
}

/** Opens the Pay page for a URL. */
export function payUrlPath(url: string): string {
  return `/pay?${new URLSearchParams({ url }).toString()}`;
}
