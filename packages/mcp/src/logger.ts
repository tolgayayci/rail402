import { redact, redactDeep, type LogLevel } from "@rail402.dev/sdk";
import type { Logger } from "./logger-types.ts";

export type { Logger } from "./logger-types.ts";

const SEVERITY: Readonly<Record<LogLevel, number>> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Infinity,
};

/**
 * A small structured logger writing one JSON line per entry to stderr: stdout belongs to the MCP
 * stdio transport. Messages and string fields are redacted, so a seed or signed XDR that reached a
 * log call is never written, even inside nested fields.
 */
export function createLogger(
  level: LogLevel,
  write: (line: string) => void = (line) => process.stderr.write(line),
): Logger {
  const threshold = SEVERITY[level];
  const log =
    (name: "error" | "warn" | "info" | "debug") =>
    (message: string, fields: Readonly<Record<string, unknown>> = {}) => {
      if (SEVERITY[name] < threshold) return;
      const entry: Record<string, unknown> = { time: new Date().toISOString(), level: name };
      for (const [key, value] of Object.entries(fields)) {
        entry[key] = redactDeep(value);
      }
      entry["msg"] = redact(message);
      write(
        `${JSON.stringify(entry, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value))}\n`,
      );
    };
  return { error: log("error"), warn: log("warn"), info: log("info"), debug: log("debug") };
}

export const silentLogger: Logger = createLogger("silent");
