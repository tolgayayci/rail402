import { serve } from "@hono/node-server";
import { X402Error } from "@rail402.dev/errors";
import { loadConfig, describeConfig } from "./config.js";
import { createApp } from "./app.js";
import { createLogger } from "./logger.js";

/**
 * Server bootstrap. `loadConfig()` runs before `serve()` so a bad configuration fails at startup
 * with a coded reason rather than serving 500s (same rule as the facilitator).
 */
function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof X402Error) {
      console.error(`[playground] refusing to start: ${err.code}: ${err.reason}`);
    } else {
      console.error("[playground] refusing to start:", err);
    }
    process.exit(1);
  }

  const log = createLogger(config.logLevel);
  const { app } = createApp({ config });

  // Behind Railway (and most managed hosts) TLS is terminated at the edge and the request reaches us
  // as http, so the request URL the stock payment middleware derives for a 402 challenge — and
  // catalogs — would be http:// for an endpoint that is really https. Honour `x-forwarded-proto` and
  // rewrite the request scheme so cataloged resource URLs are correct. Only trust the header when a
  // proxy is asserted, exactly as the rate limiter does; here that is any deployment behind Railway.
  const trustProxy = process.env["TRUST_PROXY"] !== "0";
  const fetchHandler: typeof app.fetch = (request, ...rest) => {
    if (trustProxy) {
      const proto = request.headers.get("x-forwarded-proto");
      if (proto === "https" && request.url.startsWith("http://")) {
        const rewritten = new Request(`https://${request.url.slice("http://".length)}`, request);
        return app.fetch(rewritten, ...(rest as [never, never]));
      }
    }
    return app.fetch(request, ...(rest as [never, never]));
  };

  const server = serve({ fetch: fetchHandler, port: config.port }, info => {
    log.info({ config: describeConfig(config), port: info.port }, "playground listening");
  });

  const shutdown = () => {
    log.info("shutting down");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main();
