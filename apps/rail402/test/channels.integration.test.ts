/**
 * The channels operator command against a local Stellar network, with the in-memory store and with
 * Postgres. Needs `docker compose --profile stellar up -d`.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { sql } from "kysely";
import { deriveChannelKeypairs } from "@rail402.dev/facilitator";
import { PostgresChannelPool, createDatabase, migrate } from "@rail402.dev/store-postgres";
import { LocalNetwork } from "@rail402.dev/testkit";
import { channels } from "./channels-cli.ts";
import { DATABASE_URL } from "./service-harness.ts";

const net = new LocalNetwork();
const available = await net.available();

describe.skipIf(!available)("channels command on a network", () => {
  it("reports, provisions and retires channel accounts with STORE=memory", async () => {
    const sponsor = Keypair.random();
    await net.fund(sponsor);
    const env = {
      STORE: "memory",
      TESTNET_RPC_URL: net.rpcUrl,
      TESTNET_SPONSOR_SECRET: sponsor.secret(),
      TESTNET_CHANNEL_COUNT: "2",
    };
    const addresses = deriveChannelKeypairs(sponsor, "stellar:testnet", 3).map((keypair) =>
      keypair.publicKey(),
    );

    const before = await channels(["status"], env);
    expect(before.code).toBe(0);
    // One JSON line per configured network; STORE=memory has no durable settlement state to report.
    expect(before.lines).toEqual([
      {
        network: "stellar:testnet",
        sponsor: sponsor.publicKey(),
        channels: 2,
        present: 0,
        missing: addresses.slice(0, 2),
      },
    ]);

    const provisioned = await channels(["provision", "--network", "stellar:testnet"], env);
    expect(provisioned.lines).toEqual([
      expect.objectContaining({
        network: "stellar:testnet",
        created: addresses.slice(0, 2),
        alreadyPresent: 0,
      }),
    ]);
    const extra = await channels(["provision", "--count", "3"], env);
    expect(extra.lines).toEqual([
      expect.objectContaining({ channels: 3, created: [addresses[2]], alreadyPresent: 2 }),
    ]);
    expect((await channels(["status", "--count", "3"], env)).lines).toEqual([
      expect.objectContaining({ channels: 3, present: 3, missing: [] }),
    ]);

    expect((await channels(["retire", "--count", "3"], env)).code).toBe(64);
    const retired = await channels(["retire", "--count", "3", "--force"], env);
    expect(retired.code).toBe(0);
    expect(retired.lines).toEqual([expect.objectContaining({ retired: addresses, alreadyAbsent: 0 })]);
    expect((await channels(["status", "--count", "3"], env)).lines).toEqual([
      expect.objectContaining({ present: 0, missing: addresses }),
    ]);
  });

  describe("with Postgres", () => {
    const schema = `cli_${randomBytes(6).toString("hex")}`;
    const url = `${DATABASE_URL}?options=-c%20search_path%3D${schema}`;
    const admin = createDatabase({ connectionString: DATABASE_URL, maxConnections: 1 });
    const db = createDatabase({ connectionString: url, maxConnections: 2 });

    beforeAll(async () => {
      await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
      await migrate(db);
    });

    afterAll(async () => {
      await db.destroy();
      await sql`DROP SCHEMA IF EXISTS ${sql.id(schema)} CASCADE`.execute(admin);
      await admin.destroy();
    });

    it("reports durable state and refuses to retire while a channel is leased", async () => {
      const sponsor = Keypair.random();
      await net.fund(sponsor);
      const env = {
        DATABASE_URL: url,
        TESTNET_RPC_URL: net.rpcUrl,
        TESTNET_SPONSOR_SECRET: sponsor.secret(),
        TESTNET_CHANNEL_COUNT: "1",
      };
      const [channel] = deriveChannelKeypairs(sponsor, "stellar:testnet", 1).map((keypair) =>
        keypair.publicKey(),
      );

      expect((await channels(["provision"], env)).lines).toEqual([
        expect.objectContaining({ created: [channel], alreadyPresent: 0 }),
      ]);
      expect((await channels(["status"], env)).lines).toEqual([
        {
          network: "stellar:testnet",
          sponsor: sponsor.publicKey(),
          channels: 1,
          present: 1,
          missing: [],
          unfinishedSettlements: 0,
          leasedChannels: 0,
        },
      ]);

      const pool = await PostgresChannelPool.open(db, {
        network: "stellar:testnet",
        addresses: [channel ?? ""],
      });
      const leased = await pool.acquire(1_000);
      expect(leased).toBe(channel);
      expect((await channels(["status"], env)).lines).toEqual([
        expect.objectContaining({ leasedChannels: 1 }),
      ]);
      const refused = await channels(["retire"], env);
      expect(refused.code).toBe(64);
      expect(refused.stderr).toContain("0 unfinished settlement(s) and 1 leased channel(s)");
      expect(refused.stdout).toBe("");

      await pool.release(channel ?? "");
      const retired = await channels(["retire"], env);
      expect(retired.code).toBe(0);
      expect(retired.lines).toEqual([expect.objectContaining({ retired: [channel], alreadyAbsent: 0 })]);
    });
  });
});
