import { pino, stdSerializers, type DestinationStream, type Logger, type LevelWithSilent } from "pino";

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

/**
 * Keys an HTTP client error carries that must not reach a log line: the request's URL (an RPC or
 * Horizon URL may embed a provider's API key), its body (a JSON-RPC request with a signed envelope),
 * headers and the raw response.
 */
const TRANSPORT_FIELDS = new Set(["config", "request", "response", "headers", "data", "url"]);

/** Removes transport fields from a serialized error and its causes. */
function withoutTransport(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== "object" || depth > 4) return value;
  if (Array.isArray(value)) return value.map((item) => withoutTransport(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !TRANSPORT_FIELDS.has(key))
      .map(([key, item]) => [key, withoutTransport(item, depth + 1)]),
  );
}

/**
 * pino's error serializer (type, message, stack, cause and the error's own fields), minus any transport
 * detail an HTTP client attached; what went wrong stays in the message and code.
 */
export function serializeError(error: unknown): unknown {
  return withoutTransport(error instanceof Error ? stdSerializers.err(error) : error);
}

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
      serializers: { err: serializeError, error: serializeError },
    },
    destination,
  );
}
