/** The site header: the Rail402 mark, the pages, the network, the wallet and the documentation. */
import type { ReactElement } from "react";
import { ExternalIcon } from "../ui/icons.tsx";
import { ExternalLink } from "../ui/links.tsx";
import { useEngine } from "./engine.tsx";
import { Link } from "./router.tsx";
import { PAGES, type PageId } from "./routes.ts";
import { useRuns } from "./runs.tsx";
import { WalletMenu } from "./WalletMenu.tsx";

export function SiteHeader({ page }: { readonly page: PageId }): ReactElement {
  const { config } = useEngine();
  const runs = useRuns();
  const build = `Playground ${config.version}${config.commit === "" ? "" : ` (${config.commit})`}`;
  return (
    <header className="site-header">
      <Link to={runs.labPath} className="brand" aria-label="Rail402 Playground" title={build}>
        <span className="logo-block" aria-hidden="true">
          RAIL402
        </span>
        <span className="eyebrow eyebrow-ink brand-label" aria-hidden="true">
          Playground
        </span>
      </Link>
      <nav aria-label="Pages" className="site-nav">
        {PAGES.map((entry) => (
          <Link
            key={entry.id}
            // The Lab link returns to the mode the visitor last looked at.
            to={entry.id === "lab" ? runs.labPath : entry.path}
            aria-current={entry.id === page ? "page" : undefined}
          >
            {entry.title}
          </Link>
        ))}
      </nav>
      <div className="site-header-end">
        <span className="network-badge" title={`${config.network}: test funds, real transactions`}>
          Testnet
        </span>
        <WalletMenu />
        <ExternalLink className="docs-link" href={config.urls.docs}>
          Docs <ExternalIcon />
        </ExternalLink>
      </div>
    </header>
  );
}
