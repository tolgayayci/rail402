/**
 * Configuration preflight, run with the service's own environment before the service is started or
 * replaced:
 *
 *   node dist/check-config.js
 *
 * It loads and validates the full configuration exactly as the service does at startup and checks
 * every file it names. It exits 0 and prints one JSON line when the service would accept the
 * configuration, or exits 78 with `rail402: <code>: <message>` on stderr, the same line the service
 * would stop with. A deploy that runs it first never replaces a running service with one that cannot
 * start. It touches no Stellar network.
 */
import { ConfigError, configFailureLine } from "./config.ts";
import { preflight } from "./preflight.ts";

try {
  const report = await preflight();
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(configFailureLine(error));
    process.exitCode = 78; // EX_CONFIG
  } else {
    process.stderr.write(
      `rail402: fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
