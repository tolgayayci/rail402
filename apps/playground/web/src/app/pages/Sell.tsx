/**
 * Sell: what a seller declares and what agents see. The visitor picks what they sell, how they charge
 * and the price, and the page shows the 402 an agent receives, the code that declares it and the
 * listing it becomes; then one paid call from the seller's side, a check of their own route, and the
 * commands to go live.
 */
import { useState, type ReactElement, type ReactNode, type SyntheticEvent } from "react";
import { DOCS } from "../../projection/docs.ts";
import { short, toAtomic } from "../../projection/format.ts";
import { CodeBlock } from "../../ui/CodeBlock.tsx";
import { DocLink } from "../../ui/links.tsx";
import { Tabs } from "../../ui/Tabs.tsx";
import { useEngine } from "../engine.tsx";
import { navigate } from "../router.tsx";
import { labPath } from "../routes.ts";
import { CodingAgent } from "../guide/CodingAgent.tsx";
import { PickButton, Story, type Beat } from "../guide/parts.tsx";
import {
  SELL_PRICES,
  SNIPPET_SOURCES,
  sellCode,
  snippetText,
  type SellKind,
  type SellPrice,
  type SellScheme,
} from "../guide/snippets.ts";

const KINDS: readonly { readonly id: SellKind; readonly title: string; readonly detail: string }[] = [
  { id: "http", title: "An HTTP route", detail: "GET /forecast/:city" },
  { id: "mcp", title: "An MCP tool", detail: "tools/call forecast" },
];

const SCHEMES: readonly { readonly id: SellScheme; readonly detail: string }[] = [
  { id: "exact", detail: "A fixed price per call" },
  { id: "upto", detail: "Up to a cap, by use" },
];

type View = "receive" | "code" | "listing";

const VIEWS: readonly { readonly id: View; readonly label: string }[] = [
  { id: "receive", label: "What agents receive" },
  { id: "code", label: "Your code" },
  { id: "listing", label: "Bazaar listing" },
];

/** The share of the cap the examples charge on an upto call: the snippets' `"40%"`. */
const USED_SHARE = 0.4;

const EXAMPLE_URL = "https://your-api.example/forecast/Ankara";

interface Field {
  readonly key: string;
  readonly value: string;
  readonly why: string;
  readonly picked?: boolean;
}

/** Up to four decimals, without trailing zeros. */
function trimmed(value: number): string {
  return value.toFixed(4).replace(/\.?0+$/, "");
}

function Field({
  label,
  id,
  children,
}: {
  readonly label: string;
  readonly id: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div className="guide-field" role="group" aria-labelledby={id}>
      <span id={id} className="guide-label">
        {label}
      </span>
      {children}
    </div>
  );
}

export function SellPage(): ReactElement {
  const { config } = useEngine();
  const docsUrl = config.urls.docs;
  const symbol = config.asset.symbol;
  const values = { facilitator: config.urls.facilitator, asset: symbol };
  const [kind, setKind] = useState<SellKind>("http");
  const [scheme, setScheme] = useState<SellScheme>("exact");
  const [price, setPrice] = useState<SellPrice>("0.01");
  const [view, setView] = useState<View>("receive");
  const [route, setRoute] = useState(EXAMPLE_URL);

  const upto = scheme === "upto";
  const mcp = kind === "mcp";
  const atomic = toAtomic(price, config.asset.decimals)?.toString() ?? price;
  const used = trimmed(Number(price) * USED_SHARE);
  const priceText = `${upto ? "up to " : ""}${price} ${symbol}`;
  const resource = mcp ? "https://your-api.example/mcp · tool forecast" : EXAMPLE_URL;

  const fields: readonly Field[] = [
    {
      key: "scheme",
      value: scheme,
      picked: true,
      why: upto
        ? "The agent signs for a cap; you charge what the call used, after serving it."
        : "Every call costs the same fixed amount.",
    },
    {
      key: "network",
      value: config.network,
      why: "Where the payment settles. Real USDC settles on stellar:pubnet.",
    },
    {
      key: "amount",
      value: atomic,
      picked: true,
      why: `${upto ? "The most one call can cost" : "What one call costs"}: ${price} ${symbol} in base units (${symbol} has ${String(config.asset.decimals)} decimals).`,
    },
    {
      key: "asset",
      value: short(config.asset.contract, 4),
      why: `The ${symbol} contract on ${config.network}.`,
    },
    { key: "payTo", value: "your G… address", why: "The money goes from the agent straight to you." },
    ...(upto
      ? [
          {
            key: "maxTimeoutSeconds",
            value: "120",
            why: "How long the signed cap stays valid: your handler and the settlement must fit in it.",
          },
        ]
      : []),
    {
      key: "resource",
      value: resource,
      why: mcp
        ? "Your MCP server and tool: the key of its Bazaar listing."
        : "The URL being paid for: the key of its Bazaar listing.",
    },
  ];

  const request = mcp ? 'tools/call forecast {"city": "Ankara"}' : "GET /forecast/Ankara HTTP/1.1";
  const beats: readonly Beat[] = [
    {
      title: "Calls your route",
      party: "Agent",
      body: "An agent finds your route in the Bazaar, or already knows it, and calls it without paying.",
      code: `${request}\n# no payment yet`,
    },
    {
      title: "Answers with a price",
      party: "Your API",
      body: "The payment middleware answers 402 Payment Required with the price you declared above. Your handler does not run.",
      code: `HTTP/1.1 402 Payment Required\nPAYMENT-REQUIRED: eyJ4NDAy…\n# scheme ${scheme} · amount ${atomic} · payTo your address`,
    },
    {
      title: "Signs a payment",
      party: "Agent",
      body: upto
        ? "The agent's wallet signs for the cap. Nothing moves yet, and it can never be charged more than the cap."
        : "The agent's wallet signs a transfer to your address for exactly that amount. Nothing moves yet.",
      code: `${request}\nPAYMENT-SIGNATURE: eyJ4NDAy…\n# a signed ${symbol} transfer, ${priceText}`,
    },
    {
      title: "Verifies it",
      party: "Rail402",
      body: "Your server asks Rail402 to check the signature, amount, address and expiry, and that it was never used before. Only then does your handler run.",
      code: "POST /verify\n# isValid: true",
    },
    {
      title: "Settles on Stellar",
      party: "Stellar",
      body: upto
        ? `You answer and charge what was used (${used} ${symbol} here). Rail402 settles that amount and pays the network fee; the rest of the cap is never taken.`
        : `You answer 200. Rail402 submits the transfer and pays the network fee. The ${symbol} goes from the agent straight to you.`,
      code: `POST /settle\n# success: true\n# +${upto ? used : price} ${symbol} to your address, fee paid by Rail402`,
    },
    {
      title: "Lists your route",
      party: "Rail402",
      body: "After the first settled call, Rail402 reads your route's own price and description and lists it in the Bazaar. No sign-up; only you can change your listing.",
      code: `GET /discovery/resources?payTo=G…\n# ${mcp ? "MCP tool forecast" : "GET /forecast/:city"} · ${priceText}`,
    },
  ];

  const target = route.trim() === "" ? EXAMPLE_URL : route.trim();
  const checkCommand = snippetText(SNIPPET_SOURCES.sellerCheck, values).replace(EXAMPLE_URL, target);
  const openInLab = (event: SyntheticEvent): void => {
    event.preventDefault();
    navigate(labPath(scheme, { url: target }));
  };

  return (
    <div className="guide-page" data-mode={scheme}>
      <header className="guide-head">
        <span className="r4-eyebrow">Sell · {config.network}</span>
        <h1 className="page-title page-title-large">Sell your API to agents</h1>
        <p className="page-lede">
          Pick what you sell and its price, and see what an agent receives, the code that does it, and how it
          is listed.
        </p>
      </header>

      <CodingAgent docsUrl={docsUrl} task="Ask your coding agent to add Rail402 to your API" />

      <section className="guide-section" aria-labelledby="sell-price-title">
        <div className="guide-section-head">
          <span className="r4-eyebrow" data-tone="accent">
            1 · Price it
          </span>
          <h2 id="sell-price-title" className="r4-h2">
            What you declare, and what agents see
          </h2>
        </div>
        <div className="guide-builder">
          <div className="guide-controls">
            <Field label="You sell" id="sell-kind-label">
              <div className="guide-options">
                {KINDS.map((item) => (
                  <PickButton
                    key={item.id}
                    className="guide-option"
                    pressed={kind === item.id}
                    onPick={() => {
                      setKind(item.id);
                    }}
                  >
                    <span className="guide-option-title">{item.title}</span>
                    <span className="guide-option-detail">{item.detail}</span>
                  </PickButton>
                ))}
              </div>
            </Field>
            <Field label="You charge" id="sell-scheme-label">
              <div className="guide-options">
                {SCHEMES.map((item) => (
                  <PickButton
                    key={item.id}
                    className="guide-option"
                    pressed={scheme === item.id}
                    onPick={() => {
                      setScheme(item.id);
                    }}
                  >
                    <span className="r4-badge" data-scheme={item.id}>
                      {item.id}
                    </span>
                    <span className="guide-option-detail">{item.detail}</span>
                  </PickButton>
                ))}
              </div>
            </Field>
            <Field label={upto ? "Most one call can cost" : "Price per call"} id="sell-price-label">
              <div className="guide-chips">
                {SELL_PRICES.map((item) => (
                  <PickButton
                    key={item}
                    className="guide-chip"
                    pressed={price === item}
                    onPick={() => {
                      setPrice(item);
                    }}
                  >
                    {`$${item}`}
                  </PickButton>
                ))}
              </div>
              <p className="guide-hint">
                {upto
                  ? "You charge what each call used, from 0 up to this cap."
                  : "Agents pay this on every call."}
              </p>
            </Field>
            <p className="guide-hint">
              Paid in {symbol} straight to your Stellar address. Rail402 pays the network fee and never holds
              the money.
            </p>
          </div>

          <div className="guide-preview">
            <div className="guide-preview-bar">
              <Tabs
                label="Preview"
                items={VIEWS}
                selected={view}
                onSelect={setView}
                idPrefix="sell-view"
                className="guide-tabs"
              />
              <span className="r4-badge" data-scheme={scheme}>
                {scheme} · {priceText}
              </span>
            </div>
            <div
              id="sell-view-panel"
              role="tabpanel"
              aria-labelledby={`sell-view-tab-${view}`}
              className="guide-preview-body"
              key={view}
            >
              {view === "receive" ? (
                <>
                  <p className="guide-status">
                    <span className="r4-badge" data-status="pending">
                      402
                    </span>
                    Payment Required · what your route answers before it is paid
                  </p>
                  <dl className="guide-fields">
                    {fields.map((field) => (
                      <div key={field.key}>
                        <dt>{field.key}</dt>
                        <dd
                          className="guide-field-value"
                          data-picked={field.picked === true ? "" : undefined}
                        >
                          {field.value}
                        </dd>
                        <dd className="guide-field-why">{field.why}</dd>
                      </div>
                    ))}
                  </dl>
                </>
              ) : view === "code" ? (
                <>
                  <CodeBlock
                    code={sellCode(kind, scheme, price, values)}
                    language="ts"
                    label="Copy the seller code"
                    title={mcp ? "mcp-server.ts" : "server.ts"}
                    foldImports
                  />
                  <p className="guide-hint">
                    {mcp
                      ? "Register the tool on your MCP server with the payment wrapper."
                      : "Put the middleware before your routes; your handler stays as it is."}{" "}
                    <DocLink
                      doc={mcp ? DOCS.sellMcpTool : upto ? DOCS.sellUpto : DOCS.sellHttpRoute}
                      docsUrl={docsUrl}
                    />
                  </p>
                </>
              ) : (
                <>
                  <p className="guide-status">How agents find it in the Bazaar after its first paid call</p>
                  <article className="guide-listing" aria-label="Listing preview">
                    <div className="guide-listing-top">
                      <span className="r4-badge" data-scheme={mcp ? "agent" : scheme}>
                        {mcp ? "MCP tool" : "HTTP · GET"}
                      </span>
                      <span className="guide-listing-price">{priceText}</span>
                    </div>
                    <h3>{mcp ? "forecast" : "Weather forecast"}</h3>
                    <p className="guide-listing-url">{resource}</p>
                    <p>Seven-day weather forecast for a city.</p>
                    <p>
                      Input: <code>city</code> (string, e.g. Ankara)
                    </p>
                  </article>
                </>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="guide-section" aria-labelledby="sell-story-title">
        <div className="guide-section-head">
          <span className="r4-eyebrow" data-tone="accent">
            2 · Get paid
          </span>
          <h2 id="sell-story-title" className="r4-h2">
            One paid call, seen from your side
          </h2>
        </div>
        <Story beats={beats} start={1} language="http" />
      </section>

      <section className="guide-section" aria-labelledby="sell-check-title">
        <div className="guide-section-head">
          <span className="r4-eyebrow" data-tone="accent">
            3 · Check it
          </span>
          <h2 id="sell-check-title" className="r4-h2">
            Check your route before agents do
          </h2>
          <p className="guide-hint">
            The CLI asks your route for its price the way the Bazaar will, without paying. The Lab shows its
            402 and pays it once from your test wallet when you press Run.
          </p>
        </div>
        <form className="guide-check" onSubmit={openInLab}>
          <label htmlFor="sell-route" className="guide-label">
            Route URL
          </label>
          <div className="guide-check-row">
            <input
              id="sell-route"
              className="r4-input"
              data-mono=""
              type="url"
              inputMode="url"
              spellCheck={false}
              value={route}
              onChange={(event) => {
                setRoute(event.target.value);
              }}
            />
            <button type="submit" className="r4-button">
              Open it in the Lab
            </button>
          </div>
        </form>
        <CodeBlock code={checkCommand} language="shell" label="Copy the check command" />
      </section>

      <section className="guide-section" aria-labelledby="sell-live-title">
        <div className="guide-section-head">
          <span className="r4-eyebrow" data-tone="accent">
            4 · Go live
          </span>
          <h2 id="sell-live-title" className="r4-h2">
            Install, then get an address to be paid to
          </h2>
        </div>
        <div className="guide-cards">
          <div className="guide-card">
            <span className="r4-eyebrow">Install</span>
            <CodeBlock
              code={snippetText(SNIPPET_SOURCES.sellerInstall, values)}
              language="shell"
              label="Copy the install command"
            />
            <DocLink doc={DOCS.sellerQuickstart} docsUrl={docsUrl} />
          </div>
          <div className="guide-card">
            <span className="r4-eyebrow">Get an address</span>
            <CodeBlock
              code={snippetText(SNIPPET_SOURCES.sellerKeys, values)}
              language="shell"
              label="Copy the key commands"
            />
            <DocLink doc={DOCS.cli} docsUrl={docsUrl} />
          </div>
        </div>
      </section>
    </div>
  );
}
