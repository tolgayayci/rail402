/**
 * The preflight and the migrate command against Postgres (docker compose up -d postgres), run from
 * source as `node dist/check-config.js` and `node dist/migrate.js` run from the build.
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { createServiceSchema, dropServiceSchema, DATABASE_URL } from "./service-harness.ts";
import { COLD_SIGNER, secretFile, sponsorKeyFile } from "./secret-fixtures.ts";

const SOURCE = fileURLToPath(new URL("../src/", import.meta.url));

function run(
  entry: string,
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--conditions=@rail402/source", `${SOURCE}${entry}`],
      { env: { PATH: process.env["PATH"] ?? "", ...env }, timeout: 60_000 },
      (error, stdout, stderr) => {
        resolve({
          code: error === null ? 0 : typeof error.code === "number" ? error.code : 1,
          stdout,
          stderr,
        });
      },
    );
  });
}

const schemas: string[] = [];
afterAll(async () => {
  for (const schema of schemas) await dropServiceSchema(schema);
});

async function schemaUrl(): Promise<string> {
  const schema = await createServiceSchema();
  schemas.push(schema);
  return `${DATABASE_URL}?options=-c%20search_path%3D${schema}`;
}

const testnet = {
  TESTNET_RPC_URL: "http://127.0.0.1:1/rpc",
  TESTNET_SPONSOR_SECRET: Keypair.random().secret(),
};

describe("check-config and migrate against Postgres", () => {
  it("refuses a pending migration with MIGRATE_ON_START=false until migrate ran", async () => {
    const env = { ...testnet, DATABASE_URL: await schemaUrl(), MIGRATE_ON_START: "false" };
    const before = await run("check-config.ts", env);
    expect(before.code).toBe(78);
    expect(before.stderr).toMatch(
      /^rail402: config_schema_outdated: the database schema is behind this release \(0001_settlement\.sql/,
    );

    const migrated = await run("migrate.ts", env);
    expect(migrated.stderr).toBe("");
    expect(migrated.code).toBe(0);
    expect((JSON.parse(migrated.stdout) as { applied: string[] }).applied).toContain("0001_settlement.sql");
    // Running it again applies nothing.
    expect(JSON.parse((await run("migrate.ts", env)).stdout)).toEqual({ applied: [] });

    const after = await run("check-config.ts", env);
    expect(after.stderr).toBe("");
    expect(after.code).toBe(0);
  });

  it("refuses to run as a superuser when pubnet is enabled", async () => {
    const result = await run("check-config.ts", {
      ...testnet,
      NETWORKS: "stellar:testnet,stellar:pubnet",
      DATABASE_URL_FILE: secretFile(await schemaUrl()),
      METRICS_PRIVATE_TOKEN_SHA256: "ab".repeat(32),
      PUBNET_RPC_SINGLE_PROVIDER: "true",
      PUBNET_RPC_URL: "https://127.0.0.1:1/rpc",
      PUBNET_SPONSOR_SECRET_FILE: sponsorKeyFile(Keypair.random().secret()),
      PUBNET_SPONSOR_COLD_SIGNER: COLD_SIGNER,
      PUBNET_REQUIRE_API_KEY: "false",
      PUBNET_RATE_LIMIT_PER_MINUTE: "60",
      PUBNET_KEYLESS_SPONSOR_BUDGET_XLM_PER_HOUR: "1",
      PUBNET_MAX_SPONSOR_SPEND_XLM_PER_HOUR: "10",
      PUBNET_MAX_TX_FEE_STROOPS: "300000",
      PUBNET_INCLUSION_FEE_STROOPS: "200",
      PUBNET_ASSETS: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75:USDC:7:10000",
    });
    expect(result.code).toBe(78);
    expect(result.stderr).toMatch(/^rail402: config_database_superuser: /);
  });

  it("refuses the migrate command's database URL from the environment with pubnet", async () => {
    const result = await run("migrate.ts", { NETWORKS: "stellar:pubnet", DATABASE_URL: DATABASE_URL });
    expect(result.code).toBe(78);
    expect(result.stderr).toMatch(/^rail402: config_secret_in_env: /);
    expect(result.stderr).not.toContain("rail402:rail402@");
  });

  it("reports an unreachable database with a code", async () => {
    const result = await run("check-config.ts", {
      ...testnet,
      DATABASE_URL: "postgres://nobody:x@127.0.0.1:1/none",
    });
    expect(result.code).toBe(78);
    expect(result.stderr).toMatch(/^rail402: config_database_unreachable: /);
  });
});
