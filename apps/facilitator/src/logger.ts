import { pino } from "pino";

/**
 * Structured JSON logging for the Node server ("structured logging with no secrets,
 * sufficient to reconstruct any settlement dispute").
 *
 * Deliberately confined to the server bootstrap (`index.ts`) and NOT imported by `app.ts`: the
 * Cloudflare Workers bundle imports `createApp` from `app.ts`, and pino relies on Node APIs workerd
 * does not provide. The two cataloging-diagnostic lines in `app.ts` therefore stay on `console.*`,
 * which works in both runtimes.
 *
 * The level is one of pino's own names (`trace|debug|info|warn|error|fatal`), which is exactly what
 * `LOG_LEVEL` is validated to in `config/env.ts`. Never pass a secret to the logger — only the
 * redacted `describeConfig` view reaches the startup line.
 */
export function createLogger(level: string) {
  return pino({ level, base: { service: "x402-stellar-facilitator" } });
}
