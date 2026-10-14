import { useEffect, useState, type ReactElement } from "react";
import type { CodedError, Engine } from "../engine/types.ts";
import { BudgetMeter, NetworkBadge, WalletChip } from "../ui/header.tsx";
import { ExternalLink } from "../ui/links.tsx";
import { Notice } from "../ui/Notice.tsx";
import { EngineProvider, toCodedError, useEngine, useEngineState } from "./engine.tsx";
import { AgentsPage } from "./pages/Agents.tsx";
import { BazaarPage } from "./pages/Bazaar.tsx";
import { LabPage } from "./pages/Lab.tsx";
import { PayPage } from "./pages/Pay.tsx";
import { SellPage } from "./pages/Sell.tsx";
import { WALLET_PANEL_ID, WalletPanelProvider, useWalletPanel } from "./wallet.tsx";
import { WalletPanel } from "./WalletPanel.tsx";
import { Link, useLocation } from "./router.tsx";
import { PAGES, documentTitle, pageFor, type PageId } from "./routes.ts";
import { RunsProvider, useRuns } from "./runs.tsx";

const VIEWS: Readonly<Record<PageId, () => ReactElement>> = {
  lab: LabPage,
  pay: PayPage,
  sell: SellPage,
  agents: AgentsPage,
  bazaar: BazaarPage,
};

/** The page with a ready engine. */
export function App({ engine }: { readonly engine: Engine }): ReactElement {
  return (
    <EngineProvider engine={engine}>
      <WalletPanelProvider>
        <RunsProvider>
          <Shell />
        </RunsProvider>
      </WalletPanelProvider>
    </EngineProvider>
  );
}

/** Loads the engine (configuration, wallet), then shows the page; a failure shows its code. */
export function Boot({ load }: { readonly load: () => Promise<Engine> }): ReactElement {
  const [engine, setEngine] = useState<Engine | null>(null);
  const [error, setError] = useState<CodedError | null>(null);
  useEffect(() => {
    let live = true;
    load().then(
      (ready) => {
        if (live) setEngine(ready);
      },
      (reason: unknown) => {
        if (live) setError(toCodedError(reason));
      },
    );
    return () => {
      live = false;
    };
  }, [load]);
  if (engine !== null) return <App engine={engine} />;
  return (
    <div className="boot">
      <span className="brand-mark" aria-hidden="true" />
      {error === null ? <p aria-busy="true">Loading the Playground…</p> : <Notice error={error} />}
    </div>
  );
}

function Shell(): ReactElement {
  const { pathname } = useLocation();
  const page = pageFor(pathname);
  const View = VIEWS[page];
  useEffect(() => {
    document.title = documentTitle(page);
  }, [page]);
  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <SiteHeader page={page} />
      <main id="main" className="page" tabIndex={-1}>
        <View />
      </main>
      <SiteFooter />
    </div>
  );
}

function SiteHeader({ page }: { readonly page: PageId }): ReactElement {
  const engine = useEngine();
  const state = useEngineState();
  const panel = useWalletPanel();
  const runs = useRuns();
  const { config } = engine;
  return (
    <header className="site-header">
      <div className="site-header-inner">
        <div className="site-nav-group">
          <Link to="/" className="brand">
            <span className="brand-mark" aria-hidden="true" />
            Rail402
          </Link>
          <nav aria-label="Pages" className="site-nav">
            {PAGES.map((entry) => (
              <Link
                key={entry.id}
                // The Playground link returns to the scenario the visitor last looked at.
                to={entry.id === "lab" ? runs.labPath : entry.path}
                aria-current={entry.id === page ? "page" : undefined}
              >
                {entry.title}
              </Link>
            ))}
            <ExternalLink href={config.urls.docs}>
              Docs <span aria-hidden="true">↗</span>
            </ExternalLink>
          </nav>
        </div>
        <div className="site-status">
          <NetworkBadge network={config.network} />
          <BudgetMeter budget={state.budget} symbol={config.asset.symbol} />
          <WalletChip
            wallet={state.wallet}
            balances={state.balances}
            symbol={config.asset.symbol}
            expanded={panel.open}
            controls={WALLET_PANEL_ID}
            onToggle={() => {
              panel.setOpen(!panel.open);
            }}
          />
        </div>
      </div>
      {panel.open ? (
        <div className="site-header-inner">
          <WalletPanel />
        </div>
      ) : null}
      {state.lastError !== null ? (
        <div className="site-header-inner">
          <Notice error={state.lastError} />
        </div>
      ) : null}
    </header>
  );
}

function SiteFooter(): ReactElement {
  const { config } = useEngine();
  return (
    <footer className="site-footer">
      <span>
        Stellar testnet only: test funds, real transactions. Playground {config.version}
        {config.commit === "" ? "" : ` (${config.commit})`}.
      </span>
      <ExternalLink href={config.urls.docs}>Documentation</ExternalLink>
    </footer>
  );
}
