import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql, type Kysely } from "kysely";
import pg from "pg";
import { migrate } from "@rail402.dev/store-postgres";
import { EXPLORER_MIGRATIONS, createExplorerDatabase, type ExplorerDatabase } from "../src/db.ts";

/** A superuser connection to the local test cluster (see docker-compose.yml). */
export const ADMIN_URL =
  process.env["RAIL402_TEST_DATABASE_URL"] ?? "postgres://rail402:rail402@localhost:5432/rail402";

export function urlFor(database: string, user?: { name: string; password: string }): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${database}`;
  if (user !== undefined) {
    url.username = user.name;
    url.password = user.password;
  }
  return url.toString();
}

export async function admin<T>(run: (client: pg.Client) => Promise<T>, database?: string): Promise<T> {
  const client = new pg.Client({ connectionString: database === undefined ? ADMIN_URL : urlFor(database) });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

/**
 * Databases and roles are cluster-wide, so every name a test run creates carries a prefix
 * (`RAIL402_TEST_DB_PREFIX`, default `rail402_explorer_test`) and a random run id: parallel runs on one
 * cluster never touch each other's objects.
 */
const PREFIX = process.env["RAIL402_TEST_DB_PREFIX"] ?? "rail402_explorer_test";
if (!/^[a-z][a-z0-9_]{0,30}$/.test(PREFIX))
  throw new Error("RAIL402_TEST_DB_PREFIX must be a short lowercase name");
const RUN = randomBytes(4).toString("hex");

/** A cluster-wide name unique to this run: `<prefix>_<part>_<run id>`. */
export function testName(part: string): string {
  if (!/^[a-z0-9_]{1,16}$/.test(part)) throw new Error(`unexpected test name part ${part}`);
  return `${PREFIX}_${part}_${RUN}`;
}

/** Database, facilitator database and role names for one test file's cluster setup. */
export function testNames(part: string) {
  const base = testName(part);
  return {
    database: base,
    facilitator_database: `${base}_fac`,
    owner: `${base}_owner`,
    writer: `${base}_writer`,
    reader: `${base}_reader`,
  };
}

/** Drops this run's database `name` (only names made by `testName`). */
export async function dropDatabase(name: string): Promise<void> {
  if (!name.startsWith(`${PREFIX}_`) || !name.includes(`_${RUN}`)) throw new Error(`not this run's ${name}`);
  await admin(async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  });
}

/** A fresh, migrated Explorer database for `part`, unique to this run, owned by the test superuser. */
export async function freshDatabase(part: string): Promise<Kysely<ExplorerDatabase>> {
  const name = testName(part);
  await dropDatabase(name);
  await admin(async (client) => {
    await client.query(`CREATE DATABASE ${name}`);
  });
  const db = createExplorerDatabase({ connectionString: urlFor(name) });
  await migrate(db, EXPLORER_MIGRATIONS);
  return db;
}

/** One of the committed SQL templates with its `{{names}}` filled in. */
export function template(file: "roles.sql" | "grants.sql", names: Record<string, string>): string {
  const text = readFileSync(new URL(`../sql/${file}`, import.meta.url), "utf8");
  return text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = names[key];
    if (value === undefined || !/^[a-z0-9_]+$/.test(value)) throw new Error(`missing or unsafe name ${key}`);
    return value;
  });
}

export async function count(db: Kysely<ExplorerDatabase>, table: keyof ExplorerDatabase): Promise<number> {
  const { rows } = await sql<{ n: string }>`SELECT count(*) AS n FROM ${sql.table(table)}`.execute(db);
  return Number(rows[0]?.n ?? 0);
}

/** The statements of a SQL file, without comments, one per `;` at a line end. */
export function statements(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(/;\s*\n/)
    .map((statement) => statement.trim().replace(/;$/, ""))
    .filter((statement) => statement !== "");
}
