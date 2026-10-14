/**
 * Agents: the rail402-mcp setup and tools, an example run of the scripted agent on testnet, and the
 * limits the agent cannot exceed.
 */
import { useMemo, useState, type ReactElement } from "react";
import type { CodedError, RunHandle } from "../../engine/types.ts";
import { AGENT_PLANNER_LABEL, SCENARIO_DEFAULTS } from "../../../../src/shared/lab.ts";
import { collectFacts } from "../../projection/facts.ts";
import { short } from "../../projection/format.ts";
import { at, bool, list, str } from "../../projection/json.ts";
import { parseSnippet, snippetText } from "../../projection/code.ts";
import { DocLink, ExternalLink } from "../../ui/links.tsx";
import { Notice } from "../../ui/Notice.tsx";
import { SNIPPET_SOURCES, fillSnippet } from "../../ui/snippets.ts";
import { DOCS } from "../../projection/docs.ts";
import { toCodedError, useEngine, useEngineState, useRunView } from "../engine.tsx";
import { canRun } from "../gate.ts";
import { WalletPrompt } from "../wallet.tsx";
import { Link } from "../router.tsx";

export function AgentsPage(): ReactElement {
  const engine = useEngine();
  const { config } = engine;
  const tools = engine.toolDefinitions();
  const configText = useMemo(
    () =>
      snippetText(
        parseSnippet(fillSnippet(SNIPPET_SOURCES.mcpConfig, { cap: config.caps.perCallDefault, config })),
      ),
    [config],
  );
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Give your agent a budget, not a credit card</h1>
          <p className="lead">
            rail402-mcp lets any MCP client search the Bazaar and pay for APIs and tools. Every payment is
            checked against limits you set before the key signs.
          </p>
        </div>
      </div>
      <div className="agents-grid">
        <div className="stack-wide">
          <section className="card" aria-labelledby="install-heading">
            <div className="card-body">
              <h2 id="install-heading">Add it to your MCP client</h2>
              <pre className="code code-block">{configText}</pre>
              <p className="muted">
                No key yet? <code>rail402 keys new</code> and <code>rail402 account setup --usdc 1</code>{" "}
                create a funded test wallet. <DocLink doc={DOCS.mcpServer} docsUrl={config.urls.docs} />
              </p>
            </div>
          </section>
          <section className="card" aria-labelledby="tools-heading">
            <div className="card-body">
              <h2 id="tools-heading">Tools your agent gets</h2>
              <ul className="tool-list">
                {tools.map((tool) => (
                  <li key={tool.name}>
                    <code className="tool-name">{tool.name}</code>
                    <span>{tool.description}</span>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        </div>
        <ExampleRun />
      </div>
      <section className="card section" aria-labelledby="limits-heading">
        <div className="card-body">
          <h2 id="limits-heading">Limits the agent cannot exceed</h2>
          <div className="limits">
            <div className="limit">
              <div className="limit-title">Per call</div>
              <div className="muted">
                The most one payment may cost. Here: {config.caps.perCallDefault} {config.asset.symbol} by
                default, never above {config.caps.perCallCeiling}.
              </div>
            </div>
            <div className="limit">
              <div className="limit-title">Per session</div>
              <div className="muted">
                A rolling total: {config.caps.sessionTotal} {config.asset.symbol} per{" "}
                {String(Math.round(config.caps.sessionTtlMs / 3_600_000))} hours here.
              </div>
            </div>
            <div className="limit">
              <div className="limit-title">Who and what</div>
              <div className="muted">
                Allowed networks, assets and recipients. This Playground pays on testnet only.
              </div>
            </div>
            <div className="limit">
              <div className="limit-title">Safe URLs</div>
              <div className="muted">Private addresses and unsafe redirects are refused.</div>
            </div>
          </div>
          <p className="muted">
            <Link to="/pay">See each refusal for yourself</Link> on the Pay page.
          </p>
        </div>
      </section>
    </>
  );
}

/** The scripted agent's run on testnet, as a short transcript. */
function ExampleRun(): ReactElement {
  const engine = useEngine();
  const state = useEngineState();
  const { config } = engine;
  const [handle, setHandle] = useState<RunHandle | null>(null);
  const [error, setError] = useState<CodedError | null>(null);
  const view = useRunView(handle);
  const facts = useMemo(() => collectFacts(view.events), [view.events]);
  const running = handle !== null && view.summary === null;
  const { city, hours } = SCENARIO_DEFAULTS.agent.arguments;

  const search = facts.tools.find((tool) => tool.name === "search_stellar_resources");
  const pay = facts.tools.find((tool) => tool.name === "pay_and_call");
  const searchCount = facts.searches[0]?.count ?? list(search?.result?.result, "results").length;
  const paid = str(pay?.result?.result, "payment", "settled", "amount");
  const transaction = str(pay?.result?.result, "payment", "transaction");
  const explorer = str(pay?.result?.result, "payment", "explorerUrl");
  const answer = answerText(pay?.result?.result);
  const budget = state.budget;

  const start = (): void => {
    setError(null);
    try {
      setHandle(engine.run({ scenario: "agent", experiment: "normal", cap: config.caps.perCallDefault }));
    } catch (reason) {
      setError(toCodedError(reason));
    }
  };

  return (
    <section className="card example-run" aria-label="Example run">
      <div className="card-head">
        <span className="eyebrow-label">Example run</span>
        <span className="muted">
          {budget === null ? "" : `Spent ${budget.spent} of ${budget.sessionCap} ${config.asset.symbol}`}
        </span>
      </div>
      <div className="card-body stack">
        <div className="bubble bubble-user">
          What will the weather be in {city} over the next {String(hours)} hours?
        </div>
        <p className="muted">{AGENT_PLANNER_LABEL}</p>
        {search !== undefined ? (
          <div className="bubble bubble-tool">
            <div className="bubble-head">
              <code>search_stellar_resources</code>
              <span>{search.result === undefined ? "searching…" : `${String(searchCount)} results`}</span>
            </div>
            <div className="muted mono">query: &quot;{str(search.call.args, "query") ?? ""}&quot;</div>
          </div>
        ) : null}
        {pay !== undefined ? (
          <div className="bubble bubble-tool">
            <div className="bubble-head">
              <code>pay_and_call</code>
              <span>
                {pay.result === undefined
                  ? "paying…"
                  : paid === undefined
                    ? (str(pay.result.result, "error", "code") ?? "not paid")
                    : `paid ${paid} ${config.asset.symbol}${
                        bool(pay.result.result, "payment", "verifiedOnChain") === true
                          ? ""
                          : " · not proven on chain yet"
                      }`}
              </span>
            </div>
            <div className="muted mono">
              tool: {str(pay.result?.result, "target", "toolName") ?? "…"} · cap:{" "}
              {str(pay.call.args, "spendingCap", "amount") ?? "?"} {config.asset.symbol}
              {str(pay.result?.result, "payment", "scheme") === undefined
                ? ""
                : ` · scheme: ${str(pay.result?.result, "payment", "scheme") ?? ""}`}
            </div>
            {transaction !== undefined ? (
              <ExternalLink className="mono" href={explorer}>
                tx {short(transaction, 8)} <span aria-hidden="true">↗</span>
              </ExternalLink>
            ) : null}
          </div>
        ) : null}
        {answer !== undefined ? <div className="bubble bubble-agent">{answer}</div> : null}
        {view.summary !== null && view.summary.status !== "ok" ? (
          <Notice
            error={{
              code: view.summary.code ?? "playground_unexpected_error",
              reason: view.summary.reason ?? "The run did not finish.",
            }}
          />
        ) : null}
        {error !== null ? <Notice error={error} /> : null}
        <WalletPrompt state={state} running={running} />
        <div className="row-actions">
          <button
            type="button"
            className="button-primary"
            disabled={running || !canRun(state)}
            onClick={start}
          >
            {running ? "Running…" : handle === null ? "Run it on testnet" : "Run it again"}
          </button>
          <Link to="/?scenario=agent">See every message in the lab</Link>
        </div>
      </div>
    </section>
  );
}

/** The tool's answer as text: its text content, else its structured result. Seller data, shown as text. */
function answerText(result: Parameters<typeof str>[0]): string | undefined {
  const text = list(result, "response", "content")
    .map((item) => str(item, "text"))
    .filter((item): item is string => item !== undefined)
    .join("\n");
  if (text !== "") return text;
  const structured = at(result, "response", "structuredContent");
  return structured === undefined ? undefined : JSON.stringify(structured);
}
