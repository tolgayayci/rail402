/**
 * Operator export of metered usage, for billing off-chain:
 *
 *   node dist/usage.js export --from YYYY-MM-DD --to YYYY-MM-DD [--key <id>] [--format csv|json]
 *
 * One row per caller (`key:<id>` or `public`) × network × day: successful settlements, the volume per
 * asset, the fees the sponsor was charged and the service fees accrued at the price recorded with
 * each settlement. It reads the database the service uses (`DATABASE_URL` or `DATABASE_URL_FILE`;
 * with pubnet enabled only the file) and changes nothing.
 */
import { parseArgs } from "node:util";
import { PUBNET } from "@rail402.dev/stellar";
import { createDatabase } from "@rail402.dev/store-postgres";
import { ConfigError, configFailureLine } from "./config.ts";
import { resolveSecret } from "./secrets.ts";
import { exportUsage, usageCsv } from "./usage-export.ts";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

class UsageError extends Error {}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      from: { type: "string" },
      to: { type: "string" },
      key: { type: "string" },
      format: { type: "string", default: "csv" },
    },
  });
  if (
    positionals.join(" ") !== "export" ||
    values.from === undefined ||
    values.to === undefined ||
    !DAY.test(values.from) ||
    !DAY.test(values.to) ||
    (values.format !== "csv" && values.format !== "json")
  ) {
    throw new UsageError(
      "usage: usage export --from YYYY-MM-DD --to YYYY-MM-DD [--key <id>] [--format csv|json]",
    );
  }
  const pubnet = (process.env["NETWORKS"] ?? "").split(",").some((value) => value.trim() === PUBNET);
  const url = resolveSecret(process.env, { name: "DATABASE_URL", fileOnly: pubnet });
  if (url === undefined) throw new ConfigError("set DATABASE_URL or DATABASE_URL_FILE");
  const db = createDatabase({ connectionString: url, maxConnections: 2 });
  try {
    const rows = await exportUsage(db, {
      from: values.from,
      to: values.to,
      ...(values.key === undefined ? {} : { caller: `key:${values.key}` }),
    });
    process.stdout.write(values.format === "json" ? `${JSON.stringify(rows)}\n` : usageCsv(rows));
  } finally {
    await db.destroy();
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(configFailureLine(error));
    process.exitCode = 78;
  } else if (error instanceof UsageError) {
    process.stderr.write(`usage: ${error.message}\n`);
    process.exitCode = 64;
  } else {
    process.stderr.write(`usage: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
