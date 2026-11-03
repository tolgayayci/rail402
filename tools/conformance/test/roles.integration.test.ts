/**
 * deploy/postgres/roles.sql, grants.sql and restore-dump.sh against a throwaway Postgres container: the
 * roles are created through psql in the container with the input the bootstrap script sends, the owner
 * role migrates, the runtime role reads and writes rows and can do nothing else, and a dump restore keeps
 * that split. Needs Docker; the container and everything in it are removed afterwards.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MIGRATIONS_DIRECTORY,
  PostgresSettlementLedger,
  createDatabase,
  migrate,
  type Database,
} from "@rail402.dev/store-postgres";
import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/evidence.ts";

/** The Postgres image of deploy/postgres/Dockerfile. */
const IMAGE = "postgres:18.6-alpine@sha256:898c60cb390d1085bc97bdd6a1ae968757421df394b071848b52b1c09c89d6a5";
const container = `rail402-roles-${randomBytes(4).toString("hex")}`;
const names = { owner: "rail402_owner", app: "rail402_app", database: "rail402" };
const passwords = { owner: randomBytes(12).toString("hex"), app: randomBytes(12).toString("hex") };
const superuserPassword = randomBytes(12).toString("hex");

const docker = (args: readonly string[], input?: string): string =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    ...(input === undefined ? {} : { input }),
  }).trim();
/** psql in the container, as the superuser, with `input` on its standard input. */
const psql = (database: string, input: string): string =>
  docker(
    ["exec", "-i", container, "psql", "-X", "-q", "-U", "postgres", "-d", database, "-v", "ON_ERROR_STOP=1"],
    input,
  );
const read = (path: string) => readFileSync(join(REPO_ROOT, path), "utf8");
const variables = (values: Record<string, string>) =>
  Object.entries(values)
    .map(([name, value]) => `\\set ${name} ${value}\n`)
    .join("");

let port = 0;
const urlFor = (user: string, password: string, database: string) =>
  `postgres://${user}:${password}@127.0.0.1:${String(port)}/${database}`;
const connect = (user: string, password: string, database = names.database) =>
  createDatabase({
    connectionString: urlFor(user, password, database),
    maxConnections: 1,
  }) as unknown as Kysely<unknown>;

async function errorOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "no error";
}

const ident = (value: string) => `"${value.replaceAll('"', '""')}"`;
const restoreDump = (args: readonly string[], database = "rail402") =>
  execFileSync("bash", [join(REPO_ROOT, "deploy/postgres/restore-dump.sh"), ...args], {
    env: {
      ...process.env,
      PG_EXEC: `docker exec -i ${container}`,
      PGUSER: "postgres",
      PGDATABASE: database,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

describe("the database roles", () => {
  let admin: Kysely<unknown>;
  let owner: Kysely<unknown>;
  let app: Kysely<unknown>;
  const scratch = mkdtempSync(join(tmpdir(), "rail402-roles-"));

  beforeAll(async () => {
    docker([
      "run",
      "-d",
      "--name",
      container,
      "-e",
      `POSTGRES_PASSWORD=${superuserPassword}`,
      "-e",
      "POSTGRES_DB=rail402",
      "-p",
      "127.0.0.1::5432",
      IMAGE,
    ]);
    port = Number(docker(["port", container, "5432/tcp"]).split("\n")[0]?.split(":").at(-1));
    for (let attempt = 0; ; attempt++) {
      try {
        docker(["exec", container, "pg_isready", "-q", "-U", "postgres", "-d", "rail402", "-h", "127.0.0.1"]);
        break;
      } catch (error) {
        if (attempt > 120) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    // A table created before the roles existed, as an earlier superuser setup would have.
    psql("rail402", "CREATE TABLE legacy (id serial PRIMARY KEY, note text);");
    // What bootstrap-db-roles.sh sends: the variables, then roles.sql and grants.sql.
    psql(
      "postgres",
      variables({
        owner: names.owner,
        app: names.app,
        database: names.database,
        app_connection_limit: "5",
        owner_password: `'${passwords.owner}'`,
        app_password: `'${passwords.app}'`,
      }) +
        read("deploy/postgres/roles.sql") +
        read("deploy/postgres/grants.sql"),
    );
    admin = connect("postgres", superuserPassword);
    owner = connect(names.owner, passwords.owner);
    app = connect(names.app, passwords.app);
  }, 120_000);

  afterAll(async () => {
    await Promise.all([owner.destroy(), app.destroy(), admin.destroy()]);
    try {
      docker(["rm", "-f", "-v", container]);
    } catch {
      // already gone
    }
    rmSync(scratch, { recursive: true, force: true });
  });

  it("migrates the schema as the owner role, which is not a superuser", async () => {
    const applied = await migrate(owner);
    expect(applied.length).toBeGreaterThan(0);
    // After every migration, as a deploy does: the runtime role's privileges on the new tables.
    psql("rail402", variables({ owner: names.owner, app: names.app }) + read("deploy/postgres/grants.sql"));
    const roles = await sql<{
      rolname: string;
      rolsuper: boolean;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
    }>`
      SELECT rolname, rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname IN (${names.owner}, ${names.app})
    `.execute(admin);
    expect(roles.rows).toHaveLength(2);
    for (const role of roles.rows)
      expect(role).toMatchObject({ rolsuper: false, rolcreaterole: false, rolcreatedb: false });
    const legacy = await sql<{ owner: string }>`
      SELECT tableowner AS owner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'legacy'
    `.execute(owner);
    expect(legacy.rows[0]?.owner).toBe(names.owner);
  });

  it("lets the runtime role read and write rows of every migrated table", async () => {
    await sql`INSERT INTO legacy (note) VALUES ('kept')`.execute(app);
    const tables = await sql<{ tablename: string }>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
    `.execute(app);
    expect(tables.rows.map((row) => row.tablename)).toContain("settlements");
    for (const { tablename } of tables.rows) {
      await sql.raw(`SELECT count(*) FROM ${ident(tablename)}`).execute(app);
    }
    await sql.raw("UPDATE settlements SET state = state WHERE false").execute(app);
    await sql.raw("DELETE FROM rate_limit_windows WHERE false").execute(app);
    const lock = await sql<{ locked: boolean }>`SELECT pg_try_advisory_lock(42) AS locked`.execute(app);
    expect(lock.rows[0]?.locked).toBe(true);
  });

  it("the runtime role cannot create tables, run server programs or rewrite history", async () => {
    expect(await errorOf(sql.raw("CREATE TABLE intruder (id int)").execute(app))).toMatch(
      /permission denied/,
    );
    expect(await errorOf(sql.raw("DROP TABLE settlements").execute(app))).toMatch(/must be owner/);
    expect(await errorOf(sql.raw("ALTER TABLE settlements ADD COLUMN x int").execute(app))).toMatch(
      /must be owner/,
    );
    expect(await errorOf(sql.raw("COPY legacy TO PROGRAM 'id'").execute(app))).toMatch(
      /permission denied|must be superuser|pg_execute_server_program/,
    );
    expect(await errorOf(sql.raw("CREATE ROLE intruder").execute(app))).toMatch(/permission denied/);
    expect(await errorOf(sql.raw("TRUNCATE settlements").execute(app))).toMatch(/permission denied/);
    // The migration bookkeeping is read-only, and the listing history is append-only.
    await sql.raw("SELECT count(*) FROM schema_migrations").execute(app);
    expect(await errorOf(sql.raw("DELETE FROM schema_migrations").execute(app))).toMatch(/permission denied/);
    expect(
      await errorOf(sql.raw("INSERT INTO schema_migrations (name) VALUES ('9999_forged.sql')").execute(app)),
    ).toMatch(/permission denied/);
    expect(await errorOf(sql.raw("UPDATE listing_versions SET version = version").execute(app))).toMatch(
      /permission denied/,
    );
    expect(await errorOf(sql.raw("DELETE FROM listing_observations").execute(app))).toMatch(
      /permission denied/,
    );
    // The record of restores is the operator's: the runtime role reads it and cannot add to or erase it.
    await sql.raw("SELECT count(*) FROM settlement_rewinds").execute(app);
    expect(await errorOf(sql.raw("DELETE FROM settlement_rewinds").execute(app))).toMatch(
      /permission denied/,
    );
    expect(
      await errorOf(sql.raw("INSERT INTO settlement_rewinds (reason) VALUES ('forged')").execute(app)),
    ).toMatch(/permission denied/);
    // The ledger each network is held from after a restore is added, and its ledger moved after a
    // network reset; nothing else in it changes, and nothing is removed.
    await sql.raw("SELECT count(*) FROM settlement_rewind_ledgers").execute(app);
    await sql.raw("UPDATE settlement_rewind_ledgers SET ledger = ledger WHERE false").execute(app);
    for (const column of ["network", "rewind_id"]) {
      expect(
        await errorOf(
          sql.raw(`UPDATE settlement_rewind_ledgers SET ${column} = ${column} WHERE false`).execute(app),
        ),
      ).toMatch(/permission denied/);
    }
    expect(await errorOf(sql.raw("DELETE FROM settlement_rewind_ledgers").execute(app))).toMatch(
      /permission denied/,
    );
  });

  it("keeps other roles out of the database, and the service's roles out of the maintenance databases", async () => {
    const access = await sql<{ database: string; allowed: boolean }>`
      SELECT d AS database, has_database_privilege('public', d, 'CONNECT') AS allowed
      FROM unnest(ARRAY[${names.database}, 'postgres', 'template1']) AS d
    `.execute(admin);
    expect(access.rows.map((row) => row.allowed)).toEqual([false, false, false]);
    const maintenance = connect(names.app, passwords.app, "postgres");
    expect(await errorOf(sql`SELECT 1`.execute(maintenance))).toMatch(/permission denied/);
    await maintenance.destroy();
  });

  it("restores a dump with the owner keeping every table and the runtime role its privileges", async () => {
    const dump = join(scratch, "rail402.dump");
    writeFileSync(
      dump,
      execFileSync("docker", [
        "exec",
        container,
        "pg_dump",
        "-U",
        "postgres",
        "-d",
        "rail402",
        "--format",
        "custom",
      ]),
    );
    await sql`INSERT INTO legacy (note) VALUES ('written after the dump')`.execute(app);
    restoreDump(["--owner", names.owner, "--app", names.app, dump]);
    const notes = await sql<{ note: string }>`SELECT note FROM legacy ORDER BY id`.execute(app);
    expect(notes.rows.map((row) => row.note)).toEqual(["kept"]);
    // The restore is recorded, so the facilitator holds what the records written after the dump protected.
    const rewinds = await sql<{ reason: string; recent: boolean }>`
      SELECT reason, rewound_at > now() - interval '1 minute' AS recent FROM settlement_rewinds
    `.execute(app);
    expect(rewinds.rows).toEqual([{ reason: "restore", recent: true }]);
    expect(await errorOf(sql.raw("DELETE FROM settlement_rewinds").execute(app))).toMatch(
      /permission denied/,
    );
    const owners = await sql<{ owner: string }>`
      SELECT DISTINCT tableowner AS owner FROM pg_tables WHERE schemaname = 'public'
    `.execute(admin);
    expect(owners.rows.map((row) => row.owner)).toEqual([names.owner]);
    const schema = await sql<{ owner: string }>`
      SELECT nspowner::regrole::text AS owner FROM pg_namespace WHERE nspname = 'public'
    `.execute(admin);
    expect(schema.rows[0]?.owner).toBe(names.owner);
    // The runtime role works on the restored tables, and on a table a later migration creates.
    await sql`INSERT INTO legacy (note) VALUES ('after the restore')`.execute(app);
    await sql.raw("SELECT count(*) FROM settlements").execute(app);
    await sql.raw("CREATE TABLE later_migration (id int)").execute(owner);
    await sql.raw("INSERT INTO later_migration VALUES (1)").execute(app);
    expect(await errorOf(sql.raw("CREATE TABLE intruder (id int)").execute(app))).toMatch(
      /permission denied/,
    );
    expect(await errorOf(sql.raw("DELETE FROM schema_migrations").execute(app))).toMatch(/permission denied/);
  });

  it("refuses a file that is not a dump and changes nothing", async () => {
    const broken = join(scratch, "broken.dump");
    writeFileSync(broken, "not a dump");
    expect(() => restoreDump(["--owner", names.owner, "--app", names.app, broken])).toThrow();
    const notes = await sql<{ count: string }>`SELECT count(*)::text AS count FROM legacy`.execute(app);
    expect(notes.rows[0]?.count).toBe("2");
  });

  it("records the restore of a dump taken before restores were recorded, even without settlements", async () => {
    // A one-role database at the schema of an earlier release, with no settlement yet.
    const database = "rail402_earlier";
    psql("postgres", `CREATE DATABASE ${database};`);
    const earlier = connect("postgres", superuserPassword, database) as unknown as Kysely<Database>;
    try {
      const previous = mkdtempSync(join(tmpdir(), "rail402-migrations-"));
      for (const name of readdirSync(MIGRATIONS_DIRECTORY)) {
        if (name.endsWith(".sql") && name < "0032")
          copyFileSync(join(MIGRATIONS_DIRECTORY, name), join(previous, name));
      }
      await migrate(earlier, `${previous}/`);
      rmSync(previous, { recursive: true, force: true });
      const dump = join(scratch, "earlier.dump");
      writeFileSync(
        dump,
        execFileSync("docker", [
          "exec",
          container,
          "pg_dump",
          "-U",
          "postgres",
          "-d",
          database,
          "--format",
          "custom",
        ]),
      );
      // Settled after the dump, so the restore loses it.
      await new PostgresSettlementLedger(earlier).claim(
        { network: "stellar:pubnet", payer: "GPAYER", nonce: "1" },
        { payloadHash: "p", requestHash: "r" },
        "o",
        60_000,
        { scheme: "upto", amount: "0" },
      );
      restoreDump([dump], database);
      const rewinds = await sql<{ reason: string }>`SELECT reason FROM settlement_rewinds`.execute(earlier);
      expect(rewinds.rows).toEqual([{ reason: "restore" }]);
      // The release's migrations then find the record in place and keep it.
      await migrate(earlier);
      expect(await new PostgresSettlementLedger(earlier).rewindLedger("stellar:pubnet", 700)).toBe(700);
    } finally {
      await earlier.destroy();
    }
  });
});
