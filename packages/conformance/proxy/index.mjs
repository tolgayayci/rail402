/**
 * Thin forwarding proxy that lets the upstream x402 e2e suite exercise a DEPLOYED
 * x402-stellar facilitator.
 *
 * Why this exists: acceptance is tested at the wire level by pointing stock SDK code at the
 * deliverable, and the upstream suite reaches remote facilitators through
 * `e2e/facilitators/external-proxies/` — a directory that is **gitignored upstream**. So the proxy
 * has to ship from us, or a reviewer simply cannot run the suite against our deployment.
 *
 * Deliberately dependency-free (Node built-ins only) so `install.sh` and `build.sh` are no-ops and
 * this drops into a fresh clone of the suite with nothing to resolve.
 *
 * It forwards verbatim and rewrites nothing. A proxy that "helpfully" normalised a response would
 * invalidate the very thing being measured — if our wire format is wrong, the suite must see it.
 */

import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 4022);
const TARGET = (process.env.X402_STELLAR_FACILITATOR_URL ?? "http://localhost:4022").replace(/\/$/, "");
const API_KEY = process.env.X402_STELLAR_API_KEY;

if (!process.env.X402_STELLAR_FACILITATOR_URL) {
  console.error(
    `[x402-stellar-proxy] X402_STELLAR_FACILITATOR_URL not set; defaulting to ${TARGET}`,
  );
}

/** Paths the suite exercises. Anything else 404s, so a typo surfaces instead of silently passing. */
const FORWARDED = new Set([
  "/verify",
  "/settle",
  "/supported",
  "/discovery/resources",
  "/discovery/search",
  "/health",
]);

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://placeholder");
  const path = url.pathname;

  if (!FORWARDED.has(path)) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: `x402-stellar e2e proxy does not forward ${req.method} ${path}`,
        forwards: [...FORWARDED],
      }),
    );
    return;
  }

  const chunks = [];
  req.on("data", c => chunks.push(c));
  req.on("end", async () => {
    const body = Buffer.concat(chunks);
    const target = `${TARGET}${path}${url.search}`;

    const headers = { "Content-Type": req.headers["content-type"] ?? "application/json" };
    if (API_KEY) headers["Authorization"] = `Bearer ${API_KEY}`;

    try {
      const upstream = await fetch(target, {
        method: req.method,
        headers,
        ...(req.method === "GET" || req.method === "HEAD" ? {} : { body }),
      });

      const text = await upstream.text();

      // Forward the response headers the protocol actually depends on. EXTENSION-RESPONSES carries
      // the Bazaar cataloging verdict; dropping it would make discovery look broken to the suite.
      const out = { "Content-Type": upstream.headers.get("content-type") ?? "application/json" };
      for (const h of ["extension-responses", "payment-response", "retry-after"]) {
        const v = upstream.headers.get(h);
        if (v) out[h.toUpperCase()] = v;
      }

      res.writeHead(upstream.status, out);
      res.end(text);
    } catch (error) {
      // Surface transport failure as a coded body rather than a bare socket error, so a suite
      // failure names the cause.
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "proxy_upstream_unreachable",
          reason: `Could not reach the x402-stellar facilitator at ${TARGET}: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
          target,
        }),
      );
    }
  });
});

server.listen(PORT, () => {
  // The suite's readiness gate is a literal stdout match, not a health check: `BaseProxy.startProcess`
  // resolves when stdout contains "Facilitator listening" (the string `GenericFacilitator` passes to
  // `super(directory, 'Facilitator listening')`). A proxy that prints anything else never signals
  // ready, and the run fails with a bare "Failed to start facilitator" that names no cause.
  //
  // This is undocumented, and it is the second such trap in this integration — the first being that
  // `external-proxies/` is never discovered at all. Print the exact string first, then our own
  // banner for humans.
  console.log("Facilitator listening");
  console.log(`[x402-stellar-proxy] :${PORT} -> ${TARGET}`);
  console.log(`[x402-stellar-proxy] auth: ${API_KEY ? "bearer key configured" : "none (open)"}`);
});
