import { serve } from "@hono/node-server";
import { CatalogStore } from "./catalog/store.js";
import { createBazaarApp } from "./app.js";

/**
 * Standalone Bazaar service.
 *
 * The Bazaar can run beside the facilitator (sharing a catalog store in-process) or on its own
 * behind a shared store. The module boundary is kept clean either way, so an operator can scale
 * discovery independently of settlement — discovery queries are fast lookups, settlement is not.
 */
const PORT = Number(process.env.PORT ?? 4024);
const store = new CatalogStore();
const app = createBazaarApp({ store, startedAt: Date.now() });

serve({ fetch: app.fetch, port: PORT }, info => {
  console.log(`bazaar listening on http://0.0.0.0:${info.port}`);
  console.log(`  GET /discovery/resources   list with 7 filters + offset pagination`);
  console.log(`  GET /discovery/search      natural-language query + cursor pagination`);
});
