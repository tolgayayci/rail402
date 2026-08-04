import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { paymentMiddleware } from "@x402/hono";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { declareDiscoveryExtension, bazaarResourceServerExtension } from "@x402/extensions/bazaar";

/**
 * The synthetic seller.
 *
 * Deliberately built from **stock parts only** — `@x402/hono`'s `paymentMiddleware`, the stock
 * `x402ResourceServer`, the stock `@x402/stellar` server scheme, and `declareDiscoveryExtension`
 * exactly as published. Nothing in this file is ours. If the canary used our own seller helpers it
 * would prove that our code agrees with our code, which is not a property anybody needs.
 *
 * The declaration below is also the entire seller-side effort required to become discoverable:
 * one `extensions:` key. There is no registration step and no dashboard, which is the claim the
 * canary re-proves every night.
 */

/** Natural-language query the canary searches for. Shares no token with the URL, on purpose. */
export const KNOWN_QUERY = "tide times and sea conditions at a coastal port";

/**
 * Per-parameter description the canary asserts survived cataloging.
 *
 * This text lives in `bazaar.schema.properties.input.properties.queryParams.properties.harbour`
 * once the SDK expands the declaration — *not* in `info.input`, which carries only the example
 * value. A retrieval layer reading `info.input` alone gets the parameter name and silently drops
 * the sentence that explains it, so this string is the tripwire for that whole class of bug.
 */
export const PARAMETER_DESCRIPTION =
  "Name of the harbour or coastal station to forecast, such as Dover or Halifax.";

export const RESOURCE_DESCRIPTION =
  "Tide predictions and sea state for a named harbour, updated hourly.";

export interface SyntheticSeller {
  /** Full resource URL including the query string a buyer would request. */
  readonly resourceUrl: string;
  /** Catalog key form: origin + pathname, no query. Matches the SDK's key derivation. */
  readonly catalogKey: string;
  close(): Promise<void>;
}

export interface SellerOptions {
  readonly facilitatorUrl: string;
  readonly network: string;
  readonly payTo: string;
  readonly asset: string;
  /** Atomic units at the asset's own precision. A string, never a float — amounts are integers. */
  readonly amount: string;
  /** Unique per run so concurrent or repeated runs never contend for one catalog key. */
  readonly runId: string;
}

/**
 * Start a paid endpoint on an ephemeral port and return its URLs.
 *
 * The path carries `runId` because a listing is owned by the `payTo` that settled it: two runs with
 * different seller keypairs hitting one path would collide on ownership and the second would be
 * rejected — correctly, but it would look like a canary failure rather than the anti-spoofing
 * control working as designed.
 */
export async function startSyntheticSeller(options: SellerOptions): Promise<SyntheticSeller> {
  const routePath = `/canary/${options.runId}/tides`;

  const resourceServer = new x402ResourceServer([
    new HTTPFacilitatorClient({ url: options.facilitatorUrl }),
  ]);
  resourceServer.register("stellar:*", new ExactStellarScheme());
  // Adds the concrete HTTP method and any route template to the declaration.
  resourceServer.registerExtension(bazaarResourceServerExtension);

  const app = new Hono();

  app.use(
    "*",
    paymentMiddleware(
      {
        [`GET ${routePath}`]: {
          accepts: {
            scheme: "exact",
            network: options.network as `${string}:${string}`,
            price: { amount: options.amount, asset: options.asset },
            payTo: options.payTo,
            maxTimeoutSeconds: 60,
          },
          description: RESOURCE_DESCRIPTION,
          mimeType: "application/json",
          extensions: declareDiscoveryExtension({
            input: { harbour: "Dover" },
            inputSchema: {
              type: "object",
              properties: {
                harbour: { type: "string", description: PARAMETER_DESCRIPTION },
              },
              required: ["harbour"],
            },
            output: {
              example: { harbour: "Dover", highWater: "13:42Z", heightMetres: 6.1 },
            },
          }),
        },
      },
      resourceServer,
    ),
  );

  app.get(routePath, c => c.json({ harbour: c.req.query("harbour") ?? "Dover" }));

  const server = await new Promise<ReturnType<typeof serve>>(resolve => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("the synthetic seller did not bind a TCP port");
  }
  const base = `http://127.0.0.1:${address.port}`;

  return {
    resourceUrl: `${base}${routePath}?harbour=Dover`,
    catalogKey: `${base}${routePath}`,
    close: () =>
      new Promise<void>(resolve => {
        server.close(() => resolve());
      }),
  };
}
