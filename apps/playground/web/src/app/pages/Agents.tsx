/**
 * Agents: give an agent a budget and the Rail402 MCP server, and it pays tools on its own. The visitor
 * picks the limits and sees which Bazaar listings they allow and the client configuration that sets
 * them; then the three tools the agent uses, a prompt to try, and the setup commands.
 */
import { useState, type ReactElement } from "react";
import { DOCS } from "../../projection/docs.ts";
import { listingPrice, listingTitle, priceAboveCap, priceWords } from "../../projection/listings.ts";
import { CodeBlock } from "../../ui/CodeBlock.tsx";
import { CopyButton } from "../../ui/CopyButton.tsx";
import { DocLink } from "../../ui/links.tsx";
import { Tabs } from "../../ui/Tabs.tsx";
import { useAllListings } from "../bazaar/data.ts";
import { useEngine } from "../engine.tsx";
import { Link } from "../router.tsx";
import { CodingAgent } from "../guide/CodingAgent.tsx";
import { PickButton, Story, type Beat } from "../guide/parts.tsx";
import {
  AGENT_LIMITS,
  AGENT_PER_CALL,
  AGENT_PROMPT,
  AGENT_TOTAL,
  CLIENTS,
  SNIPPET_SOURCES,
  snippetText,
  type ClientSetup,
} from "../guide/snippets.ts";

/** How many Bazaar listings the limits are tried against. */
const SHOWN_LISTINGS = 5;

const EXAMPLE_LISTING = "3f2a9c41-7b0e-4d2a-9f6c-1e8b5d2a7c90";

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function AgentsPage(): ReactElement {
  const engine = useEngine();
  const { config } = engine;
  const docsUrl = config.urls.docs;
  const symbol = config.asset.symbol;
  const [perCall, setPerCall] = useState<string>(AGENT_LIMITS.perCall);
  const [total, setTotal] = useState<string>(AGENT_LIMITS.total);
  const [clientId, setClientId] = useState<ClientSetup["id"]>("claude-desktop");
  const client = CLIENTS.find((item) => item.id === clientId) ?? CLIENTS[0];
  const values = { facilitator: config.urls.facilitator, asset: symbol, perCall, total };
  const listings = useAllListings(engine);

  const tried = (listings.data ?? [])
    .map((listing) => ({ listing, price: listingPrice(listing, symbol) }))
    .filter((item) => item.price !== null)
    .slice(0, SHOWN_LISTINGS);

  const beats: readonly Beat[] = [
    {
      title: "search_stellar_resources",
      party: "Find · never pays",
      heading: "It searches the Bazaar in plain language",
      body: "Each result has its price, whether it fits your limits, and a listingId to pay it with. Seller text comes back marked as untrusted, so the agent does not follow it as instructions.",
      codeTitle: "search_stellar_resources · example",
      code: `// arguments\n${json({ query: "air quality Istanbul", limit: 3 })}\n\n// result, shortened\n${json(
        {
          ok: true,
          network: config.network,
          results: [
            {
              listingId: EXAMPLE_LISTING,
              prices: [{ scheme: "exact", amount: "0.001", asset: symbol }],
              withinPolicy: true,
              callable: true,
            },
          ],
        },
      )}`,
    },
    {
      title: "pay_and_call",
      party: "Pay · within your caps",
      heading: "It pays and calls in one step",
      body: "The agent must name a spending cap, and your per-call limit and budget still apply. It gets the answer, a receipt with the transaction hash, and what is left. A retry with the same key never pays twice.",
      codeTitle: "pay_and_call · example",
      code: `// arguments\n${json({
        listingId: EXAMPLE_LISTING,
        pathParams: { city: "Istanbul" },
        spendingCap: `${perCall} ${symbol}`,
      })}\n\n// result, shortened\n${json({
        ok: true,
        paid: "settled",
        payment: {
          status: "settled",
          scheme: "exact",
          settled: "0.001",
          transaction: "7c3f…e91a",
          verifiedOnChain: true,
        },
        response: { kind: "http", status: 200 },
      })}`,
    },
    {
      title: "get_budget",
      party: "Keep count · never pays",
      heading: "It checks what it has left",
      body: "Spent, pending and remaining for the current 24-hour window. With reconcile, open payments are checked on Stellar first and settled or released from on-chain proof.",
      codeTitle: "get_budget · example",
      code: `// result, shortened\n${json({
        ok: true,
        network: config.network,
        budget: {
          assets: [{ asset: symbol, perCallCap: perCall, sessionCap: total, spent: "0.001", pending: "0" }],
        },
      })}`,
    },
  ];

  return (
    <div className="guide-page" data-mode="agent">
      <header className="guide-head">
        <span className="r4-eyebrow">Agents · {config.network}</span>
        <h1 className="page-title page-title-large">Give your agent a budget</h1>
        <p className="page-lede">
          Set its limits, see what it may pay for, and follow the three tools it uses to find, pay and keep
          count.
        </p>
      </header>

      <CodingAgent docsUrl={docsUrl} task="Ask your coding agent to connect your agent to Rail402" />

      <section className="guide-section" aria-labelledby="agents-limits-title">
        <div className="guide-section-head">
          <span className="r4-eyebrow" data-tone="accent">
            1 · Set its limits
          </span>
          <h2 id="agents-limits-title" className="r4-h2">
            What your agent may spend
          </h2>
        </div>
        <div className="guide-builder">
          <div className="guide-controls">
            <div className="guide-field" role="group" aria-labelledby="agents-per-call-label">
              <span id="agents-per-call-label" className="guide-label">
                Most per call
              </span>
              <div className="guide-chips">
                {AGENT_PER_CALL.map((item) => (
                  <PickButton
                    key={item}
                    className="guide-chip"
                    pressed={perCall === item}
                    onPick={() => {
                      setPerCall(item);
                    }}
                  >
                    {`${item} ${symbol}`}
                  </PickButton>
                ))}
              </div>
              <p className="guide-hint">A tool priced above this is refused before anything is signed.</p>
            </div>
            <div className="guide-field" role="group" aria-labelledby="agents-total-label">
              <span id="agents-total-label" className="guide-label">
                Budget per 24 hours
              </span>
              <div className="guide-chips">
                {AGENT_TOTAL.map((item) => (
                  <PickButton
                    key={item}
                    className="guide-chip"
                    pressed={total === item}
                    onPick={() => {
                      setTotal(item);
                    }}
                  >
                    {`${item} ${symbol}`}
                  </PickButton>
                ))}
              </div>
              <p className="guide-hint">
                Everything it pays in a window adds up here. An <code>upto</code> cap is held, and what the
                seller did not use comes back.
              </p>
            </div>
            <DocLink doc={DOCS.agentLimits} docsUrl={docsUrl} />
          </div>

          <div className="guide-preview">
            <div className="guide-preview-body">
              <p className="guide-label">With these limits, from the Bazaar</p>
              {listings.error !== null ? (
                <div className="r4-notice" role="alert">
                  <span className="r4-notice-code">{listings.error.code}</span>
                  <span className="r4-notice-reason">{listings.error.reason}</span>
                </div>
              ) : listings.data === null ? (
                <p className="guide-hint">Reading the Bazaar…</p>
              ) : tried.length === 0 ? (
                <p className="guide-hint">No priced listings yet.</p>
              ) : (
                <ul className="guide-tried" aria-label="Listings tried against your limits">
                  {tried.map(({ listing, price }) => {
                    const refused = priceAboveCap(price, perCall, config.asset.decimals);
                    return (
                      <li key={listing.id}>
                        <span>
                          <span className="guide-tried-name">{listingTitle(listing)}</span>
                          <span className="guide-tried-detail">
                            {listing.type === "mcp" ? "MCP tool" : "HTTP"} · {listing.price?.scheme}
                          </span>
                        </span>
                        <span className="guide-tried-price">{priceWords(price)}</span>
                        <span className="r4-badge" data-status={refused ? "failed" : "settled"}>
                          {refused ? "Refused" : "Can pay"}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              <div className="guide-client-bar">
                <span className="guide-label">Your client</span>
                <Tabs
                  label="Client"
                  items={CLIENTS.map((item) => ({ id: item.id, label: item.label }))}
                  selected={client.id}
                  onSelect={setClientId}
                  idPrefix="agent-client"
                  className="guide-tabs"
                />
              </div>
              <div
                id="agent-client-panel"
                role="tabpanel"
                aria-labelledby={`agent-client-tab-${client.id}`}
                className="guide-tabpanel"
                key={client.id}
              >
                <CodeBlock
                  code={snippetText(client.source, values)}
                  language={client.language}
                  label={`Copy the ${client.label} configuration`}
                  title={client.file}
                />
                <p className="guide-hint">{client.where}</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="guide-section" aria-labelledby="agents-tools-title">
        <div className="guide-section-head">
          <span className="r4-eyebrow" data-tone="accent">
            2 · How it pays
          </span>
          <h2 id="agents-tools-title" className="r4-h2">
            Three tools: find, pay, keep count
          </h2>
        </div>
        <Story beats={beats} start={1} language="json" mono />
      </section>

      <section className="guide-section" aria-labelledby="agents-try-title">
        <div className="guide-section-head">
          <span className="r4-eyebrow" data-tone="accent">
            3 · Try it
          </span>
          <h2 id="agents-try-title" className="r4-h2">
            Ask your agent
          </h2>
        </div>
        <div className="guide-prompt">
          <p>&ldquo;{AGENT_PROMPT}&rdquo;</p>
          <div className="guide-prompt-actions">
            <CopyButton text={AGENT_PROMPT} label="Copy the prompt" className="guide-prompt-copy" />
            <Link to="/?mode=agent" className="r4-button">
              Watch an agent pay in the Lab
            </Link>
          </div>
        </div>
      </section>

      <section className="guide-section" aria-labelledby="agents-setup-title">
        <div className="guide-section-head">
          <span className="r4-eyebrow" data-tone="accent">
            4 · Set up
          </span>
          <h2 id="agents-setup-title" className="r4-h2">
            Install, then fund a test wallet
          </h2>
        </div>
        <div className="guide-cards">
          <div className="guide-card">
            <span className="r4-eyebrow">Install</span>
            <CodeBlock
              code={snippetText(SNIPPET_SOURCES.agentInstall, values)}
              language="shell"
              label="Copy the install command"
            />
            <DocLink doc={DOCS.mcpServer} docsUrl={docsUrl} />
          </div>
          <div className="guide-card">
            <span className="r4-eyebrow">Fund a test wallet</span>
            <CodeBlock
              code={snippetText(SNIPPET_SOURCES.agentWallet, values)}
              language="shell"
              label="Copy the wallet commands"
            />
            <DocLink doc={DOCS.walletCli} docsUrl={docsUrl} />
          </div>
        </div>
      </section>
    </div>
  );
}
