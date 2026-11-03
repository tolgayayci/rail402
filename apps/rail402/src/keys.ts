/**
 * Operator commands for access keys:
 *
 *   node dist/keys.js new --id <id> --networks stellar:pubnet [--requests-per-minute N]
 *                         [--sponsor-budget-xlm-per-hour X] [--days D]
 *   node dist/keys.js check <file>
 *
 * `new` prints the key once, on the first line (hand it to its holder; it is never stored), and the
 * record to add to `API_KEYS_FILE` as JSON on the second; pubnet keys need a sponsor budget and expire
 * after `--days` (default 90). `check` validates a key file exactly as the service does, with the
 * networks of `NETWORKS`, and exits 0 or 78 with `rail402: <code>: <message>`. Replace the file
 * atomically (write a new file, then rename it over the old one); the service picks it up within 10
 * seconds, or at once on SIGHUP.
 */
import { parseArgs } from "node:util";
import { PUBNET } from "@rail402.dev/stellar";
import { newAccessKey, parseAccessKeys, readAccessKeyFile } from "./access.ts";
import { ConfigError, configFailureLine } from "./config.ts";

function rules() {
  const networks = (process.env["NETWORKS"] ?? "stellar:testnet")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
  return {
    networks,
    futureNetworks: process.env["ACCESS_KEYS_FUTURE_NETWORKS"] === "true",
    maxLifetimeDays: Number(process.env["ACCESS_KEY_MAX_LIFETIME_DAYS"] ?? "400"),
    max: Number(process.env["ACCESS_KEYS_MAX"] ?? "1000"),
  };
}

function main(): void {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      id: { type: "string" },
      networks: { type: "string" },
      "requests-per-minute": { type: "string" },
      "sponsor-budget-xlm-per-hour": { type: "string" },
      days: { type: "string" },
    },
  });
  const [command, file] = positionals;
  if (command === "check" && file !== undefined && positionals.length === 2) {
    const records = parseAccessKeys(readAccessKeyFile(file).text, rules());
    process.stdout.write(`${JSON.stringify({ ok: true, keys: records.length })}\n`);
    return;
  }
  if (
    command !== "new" ||
    positionals.length !== 1 ||
    values.id === undefined ||
    values.networks === undefined
  ) {
    throw new UsageError(
      "usage: keys new --id <id> --networks <caip2,…> [--requests-per-minute N] [--sponsor-budget-xlm-per-hour X] [--days D] | keys check <file>",
    );
  }
  const networks = values.networks.split(",").map((value) => value.trim());
  const days = Number(values.days ?? "90");
  if (!Number.isInteger(days) || days < 1) throw new UsageError("--days must be a positive integer");
  const created = new Date();
  const { key, sha256 } = newAccessKey(values.id);
  const record = {
    id: values.id,
    sha256,
    networks,
    ...(values["requests-per-minute"] === undefined
      ? {}
      : { requestsPerMinute: Number(values["requests-per-minute"]) }),
    ...(values["sponsor-budget-xlm-per-hour"] === undefined
      ? {}
      : { sponsorBudgetXlmPerHour: values["sponsor-budget-xlm-per-hour"] }),
    expiresAt: new Date(created.getTime() + days * 86_400_000).toISOString(),
    revoked: false,
    createdAt: created.toISOString(),
  };
  // The same validation the service applies, so a printed record is always accepted.
  parseAccessKeys(JSON.stringify({ schemaVersion: 1, keys: [record] }), {
    ...rules(),
    networks: [...new Set([...rules().networks, ...networks.filter((network) => network !== "")])],
  });
  if (networks.includes(PUBNET) && record.sponsorBudgetXlmPerHour === undefined) {
    throw new UsageError("a pubnet key needs --sponsor-budget-xlm-per-hour");
  }
  process.stdout.write(`${key}\n${JSON.stringify(record)}\n`);
}

class UsageError extends Error {}

try {
  main();
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(configFailureLine(error));
    process.exitCode = 78;
  } else if (error instanceof UsageError) {
    process.stderr.write(`keys: ${error.message}\n`);
    process.exitCode = 64;
  } else {
    process.stderr.write(`keys: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
