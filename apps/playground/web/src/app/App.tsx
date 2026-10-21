import { useEffect, useRef, useState, type ReactElement } from "react";
import type { CodedError, Engine } from "../engine/types.ts";
import { Spinner } from "../ui/icons.tsx";
import { Notice } from "../ui/Notice.tsx";
import { EngineProvider, toCodedError, useEngineState } from "./engine.tsx";
import { SiteHeader } from "./Header.tsx";
import { AgentsPage } from "./pages/Agents.tsx";
import { BazaarPage } from "./pages/Bazaar.tsx";
import { LabPage } from "./pages/Lab.tsx";
import { SellPage } from "./pages/Sell.tsx";
import { navigate, useLocation } from "./router.tsx";
import { documentTitle, movedTo, pageFor, type PageId } from "./routes.ts";
import { RunsProvider } from "./runs.tsx";
import { WalletDialog } from "./WalletDialog.tsx";
import { WalletSetupProvider, useWalletSetup } from "./wallet-setup.tsx";

const VIEWS: Readonly<Record<PageId, () => ReactElement>> = {
  lab: LabPage,
  bazaar: BazaarPage,
  sell: SellPage,
  agents: AgentsPage,
};

/** The page with a ready engine. */
export function App({ engine }: { readonly engine: Engine }): ReactElement {
  return (
    <EngineProvider engine={engine}>
      <WalletSetupProvider>
        <RunsProvider>
          <Shell />
        </RunsProvider>
      </WalletSetupProvider>
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
      <span className="logo-block">RAIL402</span>
      {error === null ? (
        <p className="boot-status" aria-busy="true">
          <Spinner /> Loading the Playground…
        </p>
      ) : (
        <Notice error={error} />
      )}
    </div>
  );
}

/**
 * Background problems the page says elsewhere, not in the banner: a browser that cannot store the
 * wallet is told in the wallet dialog and menu, in plain words.
 */
const QUIET_CODES: ReadonlySet<string> = new Set(["playground_wallet_storage_unavailable"]);

function Shell(): ReactElement {
  const { pathname } = useLocation();
  const setup = useWalletSetup();
  const state = useEngineState();
  const page = pageFor(pathname);
  const View = VIEWS[page];
  useEffect(() => {
    document.title = documentTitle(page);
  }, [page]);
  // Moving to another page moves focus to its content, so a screen reader starts there; the first
  // page of a visit keeps the browser's own focus.
  const shownPage = useRef(page);
  useEffect(() => {
    if (shownPage.current === page) return;
    shownPage.current = page;
    document.getElementById("main")?.focus({ preventScroll: true });
  }, [page]);
  // A page that moved (the Pay page is now the Lab) keeps its query, such as `?url=`.
  useEffect(() => {
    const target = movedTo(pathname, window.location.search);
    if (target !== null) navigate(target, { replace: true });
  }, [pathname]);
  return (
    <>
      <div className="app" inert={setup.dialogOpen}>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <SiteHeader page={page} />
        {state.lastError !== null && !setup.dialogOpen && !QUIET_CODES.has(state.lastError.code) ? (
          <div className="site-alert">
            <Notice error={state.lastError} />
          </div>
        ) : null}
        <main id="main" className="page" data-page={page} tabIndex={-1}>
          <View key={page} />
        </main>
      </div>
      <WalletDialog />
    </>
  );
}
