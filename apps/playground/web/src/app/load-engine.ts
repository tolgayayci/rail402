/**
 * Creates the page's engine, once per page load. The real engine reads `/api/config` and then the
 * wallet; StrictMode runs effects twice, so every caller shares one engine (and one wallet lock). A
 * failed start is not kept: the next call tries again. The browser gives the wallet lock up when the
 * page goes away.
 *
 * In Vite's `fake` mode (`dev:fake`) the engine is the replaying fake, which signs and sends nothing;
 * production builds drop that branch and never contain the fake. In fake mode,
 * `?fake-wallet=none|memory|locked|unfunded` starts with another wallet state and
 * `?fake-fund=purchase-fails` makes test-funds setup take the faucet path; `?fake-unfinished=1`
 * starts with a payment awaiting chain proof.
 */
import type { Engine } from "../engine/types.ts";

let pending: Promise<Engine> | undefined;

export function loadEngine(): Promise<Engine> {
  if (pending === undefined) {
    pending = start();
    pending.catch(() => {
      pending = undefined;
    });
  }
  return pending;
}

async function start(): Promise<Engine> {
  if (import.meta.env.MODE === "fake") {
    const { createFakeEngine, FAKE_WALLETS } = await import("../dev/fake-engine.ts");
    const query = new URLSearchParams(window.location.search);
    const wallet = FAKE_WALLETS.find((item) => item === query.get("fake-wallet"));
    return createFakeEngine({
      ...(wallet === undefined ? {} : { wallet }),
      ...(query.get("fake-fund") === "purchase-fails" ? { fund: "purchase-fails" as const } : {}),
      unfinished: query.get("fake-unfinished") === "1" ? 1 : 0,
    });
  }
  const [{ loadConfig }, { createEngine }] = await Promise.all([
    import("../engine/context.ts"),
    import("../engine/engine.ts"),
  ]);
  // The engine reads the wallet in the background; the page shows it loading meanwhile.
  return createEngine({ config: await loadConfig() });
}
