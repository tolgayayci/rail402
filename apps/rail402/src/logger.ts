import { pino, type DestinationStream, type Logger, type LevelWithSilent } from "pino";

/**
 * Fields that must never reach a log line, at the top level of a log call or one level down (e.g. a
 * logged config or request object). A top-level `transaction` stays visible: there it is the public
 * transaction hash, while a nested one is a payment's signed envelope.
 */
const SECRET_FIELDS = ["sponsorSecret", "secret", "envelopeXdr", "authorization"];
export const REDACTED_PATHS = [
  ...SECRET_FIELDS,
  ...SECRET_FIELDS.map((field) => `*.${field}`),
  "*.transaction",
  "req.headers.authorization",
];

export function createLogger(
  options: { level: LevelWithSilent; version: string },
  destination?: DestinationStream,
): Logger {
  return pino(
    {
      level: options.level,
      base: { service: "rail402", version: options.version },
      // Defence in depth: nothing in the service logs these, and nothing ever should.
      redact: { paths: REDACTED_PATHS, censor: "[redacted]" },
    },
    destination,
  );
}
