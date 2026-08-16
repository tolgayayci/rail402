import { X402Error } from "@rail402.dev/errors";
import type { PlaygroundConfig } from "./config.js";
import { NETWORK } from "./config.js";
import { decimalToStroops, stroopsToDisplay } from "../shared/amounts.js";

/**
 * The Bazaar publish wizard's backend: turn a developer's endpoint into a discoverable, paid x402
 * resource with minimal boilerplate.
 *
 *  - `snippet` generates runnable seller code (the stock `@x402/hono`/`@x402/express` middleware +
 *    our `describeEndpoint` helper) pointed at the deployed facilitator. Copy, run, and the endpoint
 *    is cataloged the first time it is paid — no registration step.
 *  - `check` does an unpaid probe of a URL the seller published and reports whether it is a
 *    well-formed x402 endpoint (a 402 challenge with the Stellar `exact` contract) — instant
 *    feedback before the "watch it appear in the Bazaar" step, which reuses `/bazaar/*`.
 */

export interface SnippetInput {
  readonly framework: "hono" | "express";
  readonly path: string;
  readonly priceDecimal: string;
  readonly description: string;
}

export interface Snippet {
  readonly framework: string;
  readonly code: string;
  readonly env: string;
  readonly priceStroops: string;
}

export function buildSnippet(config: PlaygroundConfig, input: SnippetInput): Snippet {
  const path = normalizePath(input.path);
  let priceStroops: bigint;
  try {
    priceStroops = decimalToStroops(input.priceDecimal);
  } catch {
    throw new X402Error("playground_invalid_request", {
      reason: `"${input.priceDecimal}" is not a valid USDC price (up to 7 decimal places).`,
    });
  }
  if (priceStroops <= 0n) {
    throw new X402Error("playground_invalid_request", { reason: "The price must be greater than zero." });
  }
  const description = input.description.trim() || "A paid API endpoint.";

  const env = [
    `FACILITATOR_URL=${config.facilitatorUrl}`,
    `SELLER_ADDRESS=G...   # your Stellar account with a USDC trustline (receives payment)`,
    `PAYMENT_ASSET=${config.usdc.sac}   # testnet USDC`,
  ].join("\n");

  const code = input.framework === "express" ? expressSnippet(path, priceStroops, description) : honoSnippet(path, priceStroops, description);
  return { framework: input.framework, code, env, priceStroops: priceStroops.toString() };
}

function honoSnippet(path: string, priceStroops: bigint, description: string): string {
  return `import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { paymentMiddleware } from "@x402/hono";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { describeEndpoint } from "@rail402.dev/seller-helpers";

const FACILITATOR_URL = process.env.FACILITATOR_URL;
const PAY_TO = process.env.SELLER_ADDRESS;   // your account, with a USDC trustline
const ASSET = process.env.PAYMENT_ASSET;

const x402 = new x402ResourceServer([new HTTPFacilitatorClient({ url: FACILITATOR_URL })]);
x402.register("stellar:*", new ExactStellarScheme());
x402.registerExtension(bazaarResourceServerExtension);

const app = new Hono();
app.use(
  "*",
  paymentMiddleware(
    {
      "GET ${path}": {
        accepts: {
          scheme: "exact",
          network: "${NETWORK}",
          price: { amount: "${priceStroops}", asset: ASSET },   // ${stroopsToDisplay(priceStroops)} USDC
          payTo: PAY_TO,
          maxTimeoutSeconds: 60,
        },
        description: ${JSON.stringify(description)},
        mimeType: "application/json",
        // Per-parameter descriptions are what an agent reads to call an endpoint it has never seen,
        // and what Bazaar search ranks on. Describe every parameter.
        extensions: describeEndpoint({
          params: {
            // example: rename to your real query parameters
            q: { description: "What to look up.", example: "hello" },
          },
          outputExample: { result: "…" },
        }),
      },
    },
    x402,
  ),
);

// Your real handler. Runs only after payment settles.
app.get("${path}", c => c.json({ result: c.req.query("q") ?? null }));

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 4030) }, info =>
  console.log(\`listening on http://localhost:\${info.port}${path} — discoverable after its first paid call\`),
);
`;
}

function expressSnippet(path: string, priceStroops: bigint, description: string): string {
  return `import express from "express";
import { paymentMiddleware } from "@x402/express";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { describeEndpoint } from "@rail402.dev/seller-helpers";

const FACILITATOR_URL = process.env.FACILITATOR_URL;
const PAY_TO = process.env.SELLER_ADDRESS;   // your account, with a USDC trustline
const ASSET = process.env.PAYMENT_ASSET;

const x402 = new x402ResourceServer([new HTTPFacilitatorClient({ url: FACILITATOR_URL })]);
x402.register("stellar:*", new ExactStellarScheme());
x402.registerExtension(bazaarResourceServerExtension);

const app = express();
app.use(
  paymentMiddleware(
    {
      "GET ${path}": {
        accepts: {
          scheme: "exact",
          network: "${NETWORK}",
          price: { amount: "${priceStroops}", asset: ASSET },   // ${stroopsToDisplay(priceStroops)} USDC
          payTo: PAY_TO,
          maxTimeoutSeconds: 60,
        },
        description: ${JSON.stringify(description)},
        mimeType: "application/json",
        extensions: describeEndpoint({
          params: {
            q: { description: "What to look up.", example: "hello" },
          },
          outputExample: { result: "…" },
        }),
      },
    },
    x402,
  ),
);

app.get("${path}", (req, res) => res.json({ result: req.query.q ?? null }));

app.listen(Number(process.env.PORT ?? 4030), () =>
  console.log("listening on ${path} — discoverable after its first paid call"),
);
`;
}

export interface EndpointCheck {
  readonly ok: boolean;
  readonly is402: boolean;
  readonly hasStellarExact: boolean;
  readonly hasDiscovery: boolean;
  readonly priceDecimal: string | undefined;
  readonly reason: string;
}

/** Probe a published URL unpaid and report whether it is a well-formed Stellar x402 endpoint. */
export async function checkEndpoint(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<EndpointCheck> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new X402Error("playground_invalid_request", { reason: `"${url}" is not a valid URL.` });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new X402Error("playground_invalid_request", { reason: "Only http(s) endpoints can be checked." });
  }

  let res: Response;
  try {
    res = await fetchImpl(url, { method: "GET", redirect: "manual" });
  } catch (err) {
    return {
      ok: false,
      is402: false,
      hasStellarExact: false,
      hasDiscovery: false,
      priceDecimal: undefined,
      reason: `Could not reach ${url}: ${err instanceof Error ? err.message : String(err)}.`,
    };
  }

  if (res.status !== 402) {
    return {
      ok: false,
      is402: false,
      hasStellarExact: false,
      hasDiscovery: false,
      priceDecimal: undefined,
      reason: `Expected HTTP 402 Payment Required, got ${res.status}. An x402 endpoint answers an unpaid request with 402.`,
    };
  }

  const body = (await res.json().catch(() => null)) as {
    accepts?: Array<{ scheme?: string; network?: string; amount?: string }>;
    extensions?: Record<string, unknown>;
  } | null;
  const accepts = body?.accepts ?? [];
  const stellarExact = accepts.find(a => a.scheme === "exact" && a.network?.startsWith("stellar:"));
  const hasDiscovery = !!body?.extensions && "bazaar" in (body.extensions ?? {});

  let priceDecimal: string | undefined;
  if (stellarExact?.amount) {
    try {
      priceDecimal = stroopsToDisplay(BigInt(stellarExact.amount));
    } catch {
      priceDecimal = undefined;
    }
  }

  const ok = !!stellarExact;
  return {
    ok,
    is402: true,
    hasStellarExact: !!stellarExact,
    hasDiscovery,
    priceDecimal,
    reason: ok
      ? hasDiscovery
        ? `Valid x402 endpoint: 402 challenge for ${priceDecimal ?? "?"} USDC on Stellar, with Bazaar discovery metadata. Pay it once and it appears in the catalog.`
        : `Valid x402 payment endpoint (${priceDecimal ?? "?"} USDC on Stellar), but it declares no Bazaar discovery metadata — add describeEndpoint so agents can find and understand it.`
      : "The 402 challenge does not offer a Stellar exact payment option, so this facilitator cannot settle it.",
  };
}

function normalizePath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "/premium";
  const path = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (!/^\/[A-Za-z0-9/_-]*$/.test(path)) {
    throw new X402Error("playground_invalid_request", {
      reason: `"${raw}" is not a valid path. Use letters, numbers, / _ - only.`,
    });
  }
  return path;
}
