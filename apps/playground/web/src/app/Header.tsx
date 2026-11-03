/**
 * The site header: the mark, the name and the product, then Docs, Explorer and GitHub (each opens in
 * a new tab), the network and the wallet. On a narrow screen the three links fold into a menu. Under
 * it, the Playground's own pages.
 */
import { useEffect, useRef, useState, type ReactElement } from "react";
import { RAIL402_EXPLORER_URL } from "@rail402.dev/sdk/browser";
import mark from "../design/logos/rail402-mark.svg";
import {
  AgentsIcon,
  BazaarIcon,
  DocsIcon,
  ExplorerIcon,
  ExternalIcon,
  GitHubIcon,
  LabIcon,
  MenuIcon,
  SellIcon,
} from "../ui/icons.tsx";
import { ExternalLink } from "../ui/links.tsx";
import { useEngine } from "./engine.tsx";
import { Link } from "./router.tsx";
import { PAGES, type PageId } from "./routes.ts";
import { useRuns } from "./runs.tsx";
import { WalletMenu } from "./WalletMenu.tsx";

/** The public source repository. */
export const SOURCE_URL = "https://github.com/tolgayayci/rail402";

const PAGE_ICONS: Readonly<Record<PageId, () => ReactElement>> = {
  lab: LabIcon,
  bazaar: BazaarIcon,
  sell: SellIcon,
  agents: AgentsIcon,
};

/** The Explorer's front page for this network: the configured Rail402 Explorer, else the public one. */
function explorerHome(explorer: unknown, network: string): string {
  const base =
    typeof explorer === "object" && explorer !== null && "rail402BaseUrl" in explorer
      ? String(explorer.rail402BaseUrl).replace(/\/+$/, "")
      : RAIL402_EXPLORER_URL;
  return network === "stellar:pubnet" ? base : `${base}/testnet`;
}

function SiteLinks({ docs, explorer }: { readonly docs: string; readonly explorer: string }): ReactElement {
  const links = [
    { label: "Docs", href: docs, icon: <DocsIcon /> },
    { label: "Explorer", href: explorer, icon: <ExplorerIcon /> },
    { label: "GitHub", href: SOURCE_URL, icon: <GitHubIcon /> },
  ];
  return (
    <>
      {links.map((link) => (
        <ExternalLink key={link.label} href={link.href} className="site-link">
          {link.icon}
          {link.label}
          <span className="visually-hidden"> (opens in a new tab)</span>
          <ExternalIcon />
        </ExternalLink>
      ))}
    </>
  );
}

export function SiteHeader({ page }: { readonly page: PageId }): ReactElement {
  const { config } = useEngine();
  const runs = useRuns();
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const build = `Playground ${config.version}${config.commit === "" ? "" : ` (${config.commit})`}`;
  const explorer = explorerHome(config.explorer, config.network);

  useEffect(() => {
    setMenuOpen(false);
  }, [page]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const close = (event: Event): void => {
      if (event instanceof KeyboardEvent) {
        if (event.key !== "Escape") return;
        menu.current?.querySelector<HTMLButtonElement>(".site-menu-button")?.focus();
      } else if (event.target instanceof Node && menu.current?.contains(event.target) === true) {
        return;
      }
      setMenuOpen(false);
    };
    document.addEventListener("keydown", close);
    document.addEventListener("pointerdown", close);
    return () => {
      document.removeEventListener("keydown", close);
      document.removeEventListener("pointerdown", close);
    };
  }, [menuOpen]);

  return (
    <>
      <header className="r4-header site-header">
        <Link to={runs.labPath} className="r4-brand" aria-label="Rail402 Playground" title={build}>
          <img src={mark} alt="" width={28} height={28} />
          <span className="r4-brand-name" aria-hidden="true">
            Rail402
          </span>
          <span className="r4-brand-product brand-label" aria-hidden="true">
            Playground
          </span>
        </Link>
        <nav aria-label="Rail402" className="r4-nav site-nav">
          <SiteLinks docs={config.urls.docs} explorer={explorer} />
        </nav>
        <div className="site-header-end">
          <span
            className="r4-badge network-badge"
            data-network={config.network}
            title={`${config.network}: test funds, real transactions`}
          >
            {config.network}
          </span>
          <WalletMenu />
          <div className="site-menu" ref={menu}>
            <button
              type="button"
              className="r4-icon-button site-menu-button"
              aria-expanded={menuOpen}
              aria-controls="site-menu-panel"
              aria-label="Menu"
              onClick={() => {
                setMenuOpen(!menuOpen);
              }}
            >
              <MenuIcon open={menuOpen} />
            </button>
            {menuOpen ? (
              <div id="site-menu-panel" className="site-menu-panel">
                {/* A link opens a new tab; the menu closes behind it. */}
                <nav
                  aria-label="Rail402 links"
                  className="site-menu-links"
                  onClick={() => {
                    setMenuOpen(false);
                  }}
                >
                  <SiteLinks docs={config.urls.docs} explorer={explorer} />
                </nav>
                <p className="site-menu-network">
                  Network
                  <span className="r4-badge" data-network={config.network}>
                    {config.network}
                  </span>
                </p>
              </div>
            ) : null}
          </div>
        </div>
      </header>
      <div className="page-tabs">
        <nav aria-label="Pages" className="page-tabs-nav">
          {PAGES.map((entry) => {
            const Icon = PAGE_ICONS[entry.id];
            return (
              <Link
                key={entry.id}
                // The Lab link returns to the mode the visitor last looked at.
                to={entry.id === "lab" ? runs.labPath : entry.path}
                aria-current={entry.id === page ? "page" : undefined}
              >
                <Icon />
                {entry.title}
              </Link>
            );
          })}
        </nav>
      </div>
    </>
  );
}
