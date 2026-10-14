import { createHash, randomBytes } from "node:crypto";
import { pino, stdSerializers, type DestinationStream, type LevelWithSilent, type Logger } from "pino";

/**
 * Paths that must never reach a log line. Nothing in the server logs headers, bodies or targets; this
 * is defence in depth should a request or response object ever be logged whole.
 */
export const REDACTED_PATHS = [
  "req.headers",
  "res.headers",
  "headers",
  "*.headers",
  "body",
  "*.body",
  "url",
  "*.url",
  "target",
  "*.target",
  '["payment-signature"]',
  '*["payment-signature"]',
  "authorization",
  "*.authorization",
  "cookie",
  "*.cookie",
];

/** Keys an error may carry that can hold a URL, headers or a body; dropped from serialized errors. */
const TRANSPORT_FIELDS = new Set([
  "config",
  "request",
  "response",
  "headers",
  "data",
  "url",
  "body",
  "input",
]);

function withoutTransport(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== "object" || depth > 4) return value;
  if (Array.isArray(value)) return value.map((item) => withoutTransport(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !TRANSPORT_FIELDS.has(key))
      .map(([key, item]) => [key, withoutTransport(item, depth + 1)]),
  );
}

/** pino's error serializer without transport details. */
export function serializeError(error: unknown): unknown {
  return withoutTransport(error instanceof Error ? stdSerializers.err(error) : error);
}

export function createLogger(
  options: { readonly level: LevelWithSilent; readonly version: string },
  destination?: DestinationStream,
): Logger {
  return pino(
    {
      level: options.level,
      base: { service: "rail402-playground", version: options.version },
      redact: { paths: REDACTED_PATHS, censor: "[redacted]" },
      serializers: { err: serializeError, error: serializeError },
    },
    destination,
  );
}

const DAY_MS = 86_400_000;

/**
 * Hashes client addresses for logs: SHA-256 under a random in-memory salt that is replaced every UTC
 * day, so one day's lines can be correlated and nothing links an address across days or restarts.
 */
export class IpHasher {
  private salt = randomBytes(32);
  private day: number;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
    this.day = Math.floor(now() / DAY_MS);
  }

  hash(address: string): string {
    const day = Math.floor(this.now() / DAY_MS);
    if (day !== this.day) {
      this.day = day;
      this.salt = randomBytes(32);
    }
    return createHash("sha256").update(this.salt).update(address).digest("hex").slice(0, 16);
  }
}
