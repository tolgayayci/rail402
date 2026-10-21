/** Agents: give an agent a budget and the Rail402 MCP server, and it pays tools on its own. */
import { useState, type ReactElement } from "react";
import { DOCS } from "../../projection/docs.ts";
import { CodeBlock } from "../../ui/CodeBlock.tsx";
import { CopyButton } from "../../ui/CopyButton.tsx";
import { DocLink } from "../../ui/links.tsx";
import { Tabs } from "../../ui/Tabs.tsx";
import { useEngine } from "../engine.tsx";
import { Link } from "../router.tsx";
import {
  AGENT_LIMITS,
  AGENT_PROMPT,
  AGENT_TOOLS,
  CLIENTS,
  SNIPPET_SOURCES,
  snippetText,
  type ClientSetup,
} from "../guide/snippets.ts";
import { GuideStep } from "../guide/GuideStep.tsx";

export function AgentsPage(): ReactElement {
  const { config } = useEngine();
  const docsUrl = config.urls.docs;
  const symbol = config.asset.symbol;
  const text = (source: string): string =>
    snippetText(source, { facilitator: config.urls.facilitator, asset: symbol });
  const [clientId, setClientId] = useState<ClientSetup["id"]>("claude-desktop");
  const client = CLIENTS.find((item) => item.id === clientId) ?? CLIENTS[0];
  const stats = [
    { value: AGENT_LIMITS.perCall, unit: symbol, label: "per call" },
    { value: AGENT_LIMITS.total, unit: symbol, label: "per session" },
    { value: "Testnet", unit: "", label: "network" },
  ];
  return (
    <div className="guide-page" data-mode="agent">
      <div className="guide-intro">
        <div className="guide-heading">
          <span className="eyebrow">Agents</span>
          <h1 className="page-title page-title-large">
            Give your agent <br />a budget
          </h1>
          <p className="page-lede">It finds paid tools on Stellar and pays them. Never above your limits.</p>
        </div>
        <dl className="guide-stats">
          {stats.map((stat) => (
            <div key={stat.label}>
              <dt>{stat.label}</dt>
              <dd>
                <b>{stat.value}</b>
                {stat.unit === "" ? null : <span>{stat.unit}</span>}
              </dd>
            </div>
          ))}
        </dl>
        <Link to="/?mode=agent" className="button guide-cta">
          Watch an agent pay <span aria-hidden="true">→</span>
        </Link>
        <nav className="guide-links" aria-label="Agent guides">
          <DocLink doc={DOCS.walletCli} docsUrl={docsUrl} />
        </nav>
      </div>

      <section className="guide-panel on-dark" aria-labelledby="agents-setup-title">
        <header className="guide-panel-head">
          <span className="eyebrow guide-eyebrow">Set up · About 2 minutes</span>
          <h2 id="agents-setup-title">From zero to a paid tool call</h2>
        </header>
        <ol className="guide-steps">
          <GuideStep n={1} title="Install the MCP server and the CLI" docsUrl={docsUrl}>
            <CodeBlock
              code={text(SNIPPET_SOURCES.agentInstall)}
              language="shell"
              label="Copy the install command"
            />
          </GuideStep>
          <GuideStep n={2} title="Create and fund a test wallet" docsUrl={docsUrl}>
            <CodeBlock
              code={text(SNIPPET_SOURCES.agentWallet)}
              language="shell"
              label="Copy the wallet commands"
            />
          </GuideStep>
          <GuideStep
            n={3}
            title="Add the server to your client"
            docsUrl={docsUrl}
            aside={
              <Tabs
                label="Client"
                items={CLIENTS.map((item) => ({ id: item.id, label: item.label }))}
                selected={client.id}
                onSelect={setClientId}
                idPrefix="agent-client"
                className="guide-tabs"
              />
            }
          >
            <div
              id="agent-client-panel"
              role="tabpanel"
              aria-labelledby={`agent-client-tab-${client.id}`}
              className="guide-tabpanel"
              key={client.id}
            >
              <CodeBlock
                code={text(client.source)}
                language={client.language}
                label={`Copy the ${client.label} configuration`}
              />
              <p className="guide-where">{client.where}</p>
            </div>
          </GuideStep>
          <GuideStep n={4} title="Ask your agent" docsUrl={docsUrl}>
            <div className="guide-prompt">
              <p>&ldquo;{AGENT_PROMPT}&rdquo;</p>
              <CopyButton text={AGENT_PROMPT} label="Copy the prompt" className="code-copy" />
            </div>
            <div className="guide-tools">
              <span>It will use</span>
              <ul>
                {AGENT_TOOLS.map((tool) => (
                  <li key={tool}>
                    <code>{tool}</code>
                  </li>
                ))}
              </ul>
              <DocLink doc={DOCS.mcpServer} docsUrl={docsUrl} className="guide-tools-doc" />
            </div>
          </GuideStep>
        </ol>
      </section>
    </div>
  );
}
