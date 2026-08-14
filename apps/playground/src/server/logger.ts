import { pino } from "pino";

/**
 * Structured JSON logging for the playground server, mirroring the facilitator's convention:
 * pino stays confined to the Node bootstrap (`index.ts`); `app.ts` sticks to `console.*` so the
 * app module has no Node-only dependency. Never pass a secret to the logger — the dispenser
 * wallet's secret in particular must never appear in a log line.
 */
export function createLogger(level: string) {
  return pino({ level, base: { service: "rail402-playground" } });
}
