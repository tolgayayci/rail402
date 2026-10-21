/** Sell: how a seller adds x402 to a route and gets listed after the first paid call. */
import type { ReactElement } from "react";
import { DOCS } from "../../projection/docs.ts";
import { CodeBlock } from "../../ui/CodeBlock.tsx";
import { DocLink } from "../../ui/links.tsx";
import { useEngine } from "../engine.tsx";
import { Link } from "../router.tsx";
import { SNIPPET_SOURCES, snippetText } from "../guide/snippets.ts";
import { GuideStep } from "../guide/GuideStep.tsx";

const FACTS = [
  { title: "Paid in USDC", detail: "straight to your Stellar address" },
  { title: "Listed automatically", detail: "after your first paid call, no sign-up" },
  { title: "No fees to manage", detail: "Rail402 pays the network fee" },
] as const;

export function SellPage(): ReactElement {
  const { config } = useEngine();
  const docsUrl = config.urls.docs;
  const text = (source: string): string =>
    snippetText(source, { facilitator: config.urls.facilitator, asset: config.asset.symbol });
  return (
    <div className="guide-page" data-mode="exact">
      <div className="guide-intro">
        <div className="guide-heading">
          <span className="eyebrow">Sell</span>
          <h1 className="page-title page-title-large">
            Sell your API <br />
            to agents
          </h1>
          <p className="page-lede">Add x402 to a route. Rail402 settles every payment on Stellar.</p>
        </div>
        <ul className="guide-facts">
          {FACTS.map((fact) => (
            <li key={fact.title}>
              <b>{fact.title}</b>
              <span>{fact.detail}</span>
            </li>
          ))}
        </ul>
        <nav className="guide-links" aria-label="Seller guides">
          <DocLink doc={DOCS.sellerQuickstart} docsUrl={docsUrl} />
          <DocLink doc={DOCS.sellMcpTool} docsUrl={docsUrl} />
          <DocLink doc={DOCS.sellUpto} docsUrl={docsUrl} />
        </nav>
      </div>

      <section className="guide-panel on-dark" aria-labelledby="sell-setup-title">
        <header className="guide-panel-head">
          <span className="eyebrow guide-eyebrow">Set up · Express example</span>
          <h2 id="sell-setup-title">From an API to a paid listing</h2>
        </header>
        <ol className="guide-steps">
          <GuideStep n={1} title="Install" doc={DOCS.sellerInstall} docsUrl={docsUrl}>
            <CodeBlock
              code={text(SNIPPET_SOURCES.sellerInstall)}
              language="shell"
              label="Copy the install command"
            />
          </GuideStep>
          <GuideStep n={2} title="Get an address to be paid to" doc={DOCS.cli} docsUrl={docsUrl}>
            <CodeBlock
              code={text(SNIPPET_SOURCES.sellerKeys)}
              language="shell"
              label="Copy the key commands"
            />
          </GuideStep>
          <GuideStep n={3} title="Price the route and use Rail402" doc={DOCS.sellHttpRoute} docsUrl={docsUrl}>
            <CodeBlock
              code={text(SNIPPET_SOURCES.sellerRoute)}
              language="ts"
              label="Copy the seller code"
              className="code-block-small"
              foldImports
            />
          </GuideStep>
          <GuideStep n={4} title="Check it, then make one paid call" doc={DOCS.listing} docsUrl={docsUrl}>
            <CodeBlock
              code={text(SNIPPET_SOURCES.sellerCheck)}
              language="shell"
              label="Copy the check command"
            />
            <p className="guide-note">
              Pay it once from another wallet, or paste its URL into the <Link to="/">Lab</Link>. After that
              first paid call, Rail402 checks your route&rsquo;s own 402 and lists it in the Bazaar, where
              agents can find and pay it.
            </p>
          </GuideStep>
        </ol>
      </section>
    </div>
  );
}
