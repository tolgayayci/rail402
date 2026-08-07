import { createApp } from "./app.js";
import { loadConfig, type FacilitatorConfig } from "./config/env.js";
import { X402Error } from "@x402-stellar/errors";
import { D1CatalogPersistence, type D1Like } from "@x402-stellar/bazaar";

/**
 * Cloudflare Workers entrypoint.
 *
 * The whole service is a Hono app, so the only Node-specific part is `index.ts`'s
 * `@hono/node-server` bootstrap. This file is the same app with a Workers bootstrap instead —
 * no forked logic, no divergent code path. Verified: bundles at ~384 KiB gzipped and answers
 * `/health`, `/supported` and `/discovery/*` under `workerd`, with real Stellar keypair loading.
 *
 * Requires `nodejs_compat`, because `@stellar/stellar-sdk` reaches for Node built-ins.
 *
 * ## Read this before deploying the Bazaar here
 *
 * **The catalog is in-memory, and a Worker isolate is ephemeral.** Cloudflare may run each request
 * in a fresh isolate and recycles them freely, so a resource cataloged while settling one payment
 * is very likely *gone* by the next request. `/verify`, `/settle` and `/supported` are stateless and
 * behave correctly; **discovery does not**, and will appear to randomly forget listings.
 *
 * That is a property of this deployment target, not a bug in the catalog: `CatalogStore` is
 * deliberately in-memory because the catalog is derived state, rebuildable from settlement history
 * (`apps/bazaar/src/catalog/store.ts`). Making it durable here means backing it with a Durable
 * Object, D1 or KV — real work, not a config flag, and it belongs behind the `CatalogStore` seam.
 *
 * So:
 *   - **Facilitator-only on Workers** — fine today.
 *   - **Facilitator + Bazaar** — use a normal Node deployment, or a Cloudflare Tunnel in front of
 *     one, until the store has a durable backend.
 *
 * `BAZAAR_EPHEMERAL_ACK` exists to make that a decision rather than a surprise: without it, the
 * discovery routes refuse to pretend they work.
 */

export interface WorkerEnv extends Record<string, unknown> {
  /** Set to "1" to acknowledge that catalog state will not survive between isolates. */
  BAZAAR_EPHEMERAL_ACK?: string;
  /**
   * D1 binding holding the catalog.
   *
   * Present ⇒ discovery is durable and served. Absent ⇒ the catalog would live only in an isolate
   * that Cloudflare may discard at any moment, and `/discovery/*` is refused rather than quietly
   * forgetting sellers.
   */
  CATALOG_DB?: D1Like;
}

/** Config parsing is pure, but re-running it per request would be wasteful — cache per isolate. */
let cached: { config: FacilitatorConfig; app: ReturnType<typeof createApp> } | undefined;

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    try {
      if (!cached) {
        const config = loadConfig(env as unknown as NodeJS.ProcessEnv);
        const app = createApp({
          config,
          startedAt: Date.now(),
          ...(env.CATALOG_DB ? { persistence: new D1CatalogPersistence(env.CATALOG_DB) } : {}),
        });
        cached = { config, app };
      }

      // Hydrate before serving. A D1 read is a network call, so a fresh isolate would otherwise
      // answer /discovery/* from an empty store and report "nothing has ever settled here" — a
      // worse failure than a few milliseconds of latency on the first request an isolate sees.
      await cached.app.catalog.ready();

      // Fail loudly rather than serving a catalog that silently empties itself.
      const path = new URL(request.url).pathname;
      if (path.startsWith("/discovery/") && !env.CATALOG_DB && env.BAZAAR_EPHEMERAL_ACK !== "1") {
        return Response.json(
          {
            code: "config_bazaar_ephemeral_storage",
            reason:
              "Discovery is disabled on this Workers deployment: the catalog is in-memory and a Worker isolate is ephemeral, so listings would disappear unpredictably. Deploy the Bazaar on a stateful host, or set BAZAAR_EPHEMERAL_ACK=1 to accept lossy discovery for a throwaway demo.",
            retryable: false,
          },
          { status: 501 },
        );
      }

      return await cached.app.app.fetch(request, env);
    } catch (error) {
      // A configuration error must not surface as a bare 1101 "Worker threw an exception".
      if (error instanceof X402Error) {
        return Response.json({ code: error.code, reason: error.reason, retryable: false }, { status: 500 });
      }
      return Response.json(
        {
          code: "unexpected_verify_error",
          reason: `The facilitator failed to start: ${error instanceof Error ? error.message : "unknown error"}`,
          retryable: true,
        },
        { status: 500 },
      );
    }
  },
};
