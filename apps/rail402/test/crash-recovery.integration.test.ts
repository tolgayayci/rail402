/**
 * Crash recovery of the real service process. Rail402 runs as a child process over Postgres, with its
 * RPC behind a fault proxy, and is killed with SIGKILL — which no handler can intercept — at each point
 * of a settlement where a crash could lose track of money:
 *
 * - K0: the network accepted the transaction, and its answer never reached Rail402;
 * - K1: the envelope was recorded, and the broadcast never left the host;
 * - K2: the transaction was included, and Rail402 never saw the confirmation;
 * - K3: as K1, and the service stays down until the transaction's time bound has passed.
 *
 * After a restart the new process must finish the settlement from its durable record alone: it
 * finds or rebroadcasts the original bytes, never submits a replacement, moves funds at most once
 * and releases the channel. K0–K2 run for `exact` and for `upto` (settling part of the cap). A last
 * case proves the reconciler never declares a settlement expired
 * once the RPC's retained history can no longer prove the transaction absent.
 *
 * Needs `docker compose --profile stellar up -d` and Postgres.
 */
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  FeeBumpTransaction,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  type Transaction,
} from "@stellar/stellar-sdk";
import { sql, type Kysely } from "kysely";
import type { SettleResponse } from "@x402/core/types";
import {
  deriveAuthorityKeypair,
  deriveChannelKeypairs,
  provisionAuthority,
  provisionChannels,
} from "@rail402.dev/facilitator";
import {
  PostgresSettlementLedger,
  createDatabase,
  migrate,
  type Database,
} from "@rail402.dev/store-postgres";
import { UptoStellarScheme as UptoClient } from "@rail402.dev/upto/client";
import {
  LocalNetwork,
  ServiceProcess,
  classicTestAsset,
  deployUpto,
  exactDriver,
  startRpcProxy,
  stopServiceProcesses,
  uptoDriver,
  type HeldEvent,
  type IssuedAsset,
  type LocalUptoContract,
  type PaymentDriver,
  type RpcProxy,
} from "@rail402.dev/testkit";
import { DATABASE_URL } from "./service-harness.ts";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const NETWORK = "stellar:testnet";
const RECONCILE_INTERVAL_MS = 1_000;
const CHANNELS = 2;
const net = new LocalNetwork();
const available = await net.available();

type Scheme = "exact" | "upto";

interface Settled {
  readonly status: number;
  readonly body: SettleResponse;
  readonly extensions: string | null;
}

describe.skipIf(!available)("crash recovery of the service process (SIGKILL)", () => {
  let usdc: IssuedAsset;
  let seller: Keypair;
  let sponsor: Keypair;
  let proxy: RpcProxy;
  let contract: LocalUptoContract;
  let drivers: Record<Scheme, PaymentDriver>;
  const schemas: string[] = [];
  const databases: Kysely<Database>[] = [];

  beforeAll(async () => {
    [usdc, contract] = await Promise.all([net.issueAsset("USDC"), deployUpto(net)]);
    [seller] = (await net.holders(usdc, 1, "0")) as [Keypair];
    sponsor = Keypair.random();
    await net.fund(sponsor);
    // Provisioned up front, so the only transactions through the proxy are settlements.
    await provisionChannels({
      server: net.server,
      passphrase: net.passphrase,
      sponsor,
      channels: deriveChannelKeypairs(sponsor, NETWORK, CHANNELS),
    });
    const authority = deriveAuthorityKeypair(sponsor, NETWORK);
    await provisionAuthority({ server: net.server, passphrase: net.passphrase, sponsor, authority });
    const asset = classicTestAsset(net, usdc);
    drivers = {
      exact: exactDriver(net, asset),
      // The service estimates ledger time from Horizon (5–6 s on testnet); a client assuming 6 s
      // signs a window inside what either estimate accepts.
      upto: uptoDriver(net, asset, {
        contract: contract.address,
        authority: authority.publicKey(),
        client: (...args: ConstructorParameters<typeof UptoClient>) => new UptoClient(...args),
        ledgerSeconds: 6,
      }),
    };
    proxy = await startRpcProxy(net.rpcUrl);
  }, 180_000);

  afterEach(async () => {
    await stopServiceProcesses();
    proxy.discardHeld();
    proxy.reset();
  });

  afterAll(async () => {
    // Unset when beforeAll failed before starting it.
    await (proxy as RpcProxy | undefined)?.close();
    await Promise.all(databases.map((db) => db.destroy()));
    const admin = createDatabase({ connectionString: DATABASE_URL, maxConnections: 1 });
    for (const schema of schemas) await sql`DROP SCHEMA IF EXISTS ${sql.id(schema)} CASCADE`.execute(admin);
    await admin.destroy();
  });

  /** A fresh Postgres schema, migrated, and the service's environment over it. */
  const environment = async () => {
    const schema = `crash_${randomBytes(6).toString("hex")}`;
    schemas.push(schema);
    const admin = createDatabase({ connectionString: DATABASE_URL, maxConnections: 1 });
    await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
    await admin.destroy();
    const db = createDatabase({ connectionString: DATABASE_URL, schema, maxConnections: 2 });
    await migrate(db);
    databases.push(db);
    const env = {
      STORE: "postgres",
      DATABASE_URL: `${DATABASE_URL}?options=-c%20search_path%3D${schema}`,
      TESTNET_RPC_URL: proxy.url,
      TESTNET_SPONSOR_SECRET: sponsor.secret(),
      TESTNET_CHANNEL_COUNT: String(CHANNELS),
      TESTNET_AUTO_PROVISION_CHANNELS: "false",
      TESTNET_UPTO_ENABLED: "true",
      TESTNET_UPTO_CONTRACT: contract.address,
      TESTNET_UPTO_WASM_HASH: contract.wasmHash,
      TESTNET_UPTO_TTL_KEEPER: "false",
      TESTNET_ASSETS: `${usdc.sac}:USDC:7`,
      TESTNET_MAX_TX_FEE_STROOPS: "2000000",
      TESTNET_MIN_SPONSOR_BALANCE_XLM: "1",
      RECONCILE_INTERVAL_MS: String(RECONCILE_INTERVAL_MS),
      // One replica: no request elsewhere can be confirming its settlements, so the restarted process
      // drives what the killed one recorded at once.
      SETTLE_RECONCILE_IDLE_MS: "0",
      BAZAAR_ENABLED: "false",
      RATE_LIMIT_PER_MINUTE: "0",
    };
    return { db, env };
  };

  const start = async (env: Record<string, string>) => {
    const service = await ServiceProcess.start({ entry: MAIN, env });
    await service.listening();
    return service;
  };

  /** A payment moving `amount`: `exact` for that price, `upto` capped at twice it and settling it. */
  const pay = async (payer: Keypair, amount: bigint, maxTimeoutSeconds: number, scheme: Scheme = "exact") => {
    const driver = drivers[scheme];
    const published = driver.requirements(seller.publicKey(), scheme === "exact" ? amount : amount * 2n, {
      maxTimeoutSeconds,
    });
    const payload = await driver.pay({ kind: "G", address: payer.publicKey(), keypair: payer }, published);
    return { requirements: driver.settleRequirements(published, amount), payload };
  };

  const settle = async (
    service: ServiceProcess,
    payment: Awaited<ReturnType<typeof pay>>,
  ): Promise<Settled> => {
    const response = await fetch(`${service.url}/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload: payment.payload,
        paymentRequirements: payment.requirements,
      }),
    });
    return {
      status: response.status,
      body: (await response.json()) as SettleResponse,
      extensions: response.headers.get("extension-responses"),
    };
  };

  /** Starts a settle request that the kill will cut off; its failure is expected. */
  const settleUntilKilled = (service: ServiceProcess, payment: Awaited<ReturnType<typeof pay>>) =>
    settle(service, payment).then(
      () => "answered" as const,
      () => "cut off" as const,
    );

  const row = async (db: Kysely<Database>) => db.selectFrom("settlements").selectAll().executeTakeFirst();

  const leasedChannels = async (db: Kysely<Database>) => {
    const leased = await db
      .selectFrom("channels")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("leased_at", "is not", null)
      .executeTakeFirstOrThrow();
    return Number(leased.count);
  };

  /** Transfer events from `payer` on the asset contract since `startLedger`. */
  const transfersFrom = async (payer: string, startLedger: number) => {
    const { events } = await net.server.getEvents({
      startLedger,
      filters: [
        {
          type: "contract",
          contractIds: [usdc.sac],
          topics: [
            [
              nativeToScVal("transfer", { type: "symbol" }).toXDR("base64"),
              nativeToScVal(payer, { type: "address" }).toXDR("base64"),
              "*",
              "*",
            ],
          ],
        },
      ],
      limit: 100,
    });
    return events;
  };

  /** Everything each kill point must leave true once the restarted process reconciled. */
  const expectRecovered = async (
    options: {
      service: ServiceProcess;
      db: Kysely<Database>;
      hash: string;
      payer: Keypair;
      amount: bigint;
      sellerBefore: bigint;
      startLedger: number;
    },
    payment: Awaited<ReturnType<typeof pay>>,
  ) => {
    const { service, db, hash, payer, amount, sellerBefore, startLedger } = options;
    await expect
      .poll(async () => (await row(db))?.state, { timeout: 30_000, interval: 200 })
      .toBe("succeeded");
    expect(await row(db)).toMatchObject({ transaction_hash: hash, settled_by: "rail402" });
    // Only the original bytes were ever sent, by either process: no replacement transaction.
    expect(distinctHashes(proxy.sent)).toEqual([hash]);
    // Funds moved once: one transfer event, the payer debited once and payTo credited once.
    expect(await transfersFrom(payer.publicKey(), startLedger)).toHaveLength(1);
    expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(1_000_000_000n - amount);
    expect(await net.tokenBalance(usdc.sac, seller.publicKey())).toBe(sellerBefore + amount);
    expect(await leasedChannels(db)).toBe(0);
    expect(await metric(service, "rail402_settlements_reconciled_total", { outcome: "succeeded" })).toBe(1);
    // A repeat is answered from the record with the original transaction.
    const repeat = await settle(service, payment);
    expect(repeat.status).toBe(200);
    expect(repeat.body).toMatchObject({ success: true, transaction: hash, payer: payer.publicKey() });
    expect(JSON.parse(Buffer.from(repeat.extensions ?? "", "base64").toString("utf8"))).toMatchObject({
      rail402: { settlement: { repeat: true } },
    });
  };

  describe.each<Scheme>(["exact", "upto"])("%s", (scheme) => {
    it("K0: finds the transaction the network accepted before the process died", async () => {
      const { db, env } = await environment();
      const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
      const payment = await pay(payer, 4_000_000n, 120, scheme);
      const sellerBefore = await net.tokenBalance(usdc.sac, seller.publicKey());
      const startLedger = await net.latestLedger();
      const service = await start(env);

      // The network gets the transaction; Rail402 never gets the answer.
      proxy.holdResponses("sendTransaction");
      const held = once(proxy.events, "held") as Promise<[HeldEvent]>;
      const request = settleUntilKilled(service, payment);
      const [event] = await held;
      const hash = hashOf(event.transaction);
      expect(await row(db)).toMatchObject({ state: "submitted", transaction_hash: hash });
      expect(await leasedChannels(db)).toBe(1);

      expect((await service.kill("SIGKILL")).signal).toBe("SIGKILL");
      proxy.discardHeld();
      expect(await request).toBe("cut off");

      const restarted = await service.restart();
      await restarted.listening();
      const listening = Date.now();
      await expect
        .poll(async () => (await row(db))?.state, { timeout: 30_000, interval: 100 })
        .toBe("succeeded");
      // Recovered by the reconciler's first passes after startup.
      expect(Date.now() - listening).toBeLessThanOrEqual(3 * RECONCILE_INTERVAL_MS);
      await expectRecovered(
        { service: restarted, db, hash, payer, amount: 4_000_000n, sellerBefore, startLedger },
        payment,
      );
    });

    it("K1: rebroadcasts the identical recorded bytes when the broadcast never left", async () => {
      const { db, env } = await environment();
      const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
      const payment = await pay(payer, 3_000_000n, 120, scheme);
      const sellerBefore = await net.tokenBalance(usdc.sac, seller.publicKey());
      const startLedger = await net.latestLedger();
      const service = await start(env);

      proxy.onSendTransaction = () => "hold";
      const held = once(proxy.events, "held") as Promise<[HeldEvent]>;
      const request = settleUntilKilled(service, payment);
      const [event] = await held;
      const hash = hashOf(event.transaction);
      expect(await row(db)).toMatchObject({ state: "submitted", transaction_hash: hash });

      await service.kill("SIGKILL");
      proxy.discardHeld();
      proxy.onSendTransaction = undefined;
      expect(await request).toBe("cut off");
      expect((await net.server.getTransaction(hash)).status).toBe(rpc.Api.GetTransactionStatus.NOT_FOUND);

      const restarted = await service.restart();
      await restarted.listening();
      await expectRecovered(
        { service: restarted, db, hash, payer, amount: 3_000_000n, sellerBefore, startLedger },
        payment,
      );
      // The held submission plus at least one rebroadcast, all of the same envelope.
      expect(proxy.sent.length).toBeGreaterThanOrEqual(2);
      expect(
        await metric(restarted, "rail402_submissions_total", { status: "PENDING" }),
      ).toBeGreaterThanOrEqual(1);
    });

    it("K2: finds a transaction that was included before the process saw it confirmed", async () => {
      const { db, env } = await environment();
      const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
      const payment = await pay(payer, 2_000_000n, 120, scheme);
      const sellerBefore = await net.tokenBalance(usdc.sac, seller.publicKey());
      const startLedger = await net.latestLedger();
      const service = await start(env);

      proxy.hideTransactions = true;
      const request = settleUntilKilled(service, payment);
      await expect.poll(() => proxy.sent.length, { timeout: 30_000, interval: 50 }).toBe(1);
      const hash = hashOf(proxy.sent[0]);
      // Included on the network while Rail402 still sees NOT_FOUND.
      await expect
        .poll(async () => (await net.server.getTransaction(hash)).status, { timeout: 30_000, interval: 200 })
        .toBe(rpc.Api.GetTransactionStatus.SUCCESS);
      expect(await row(db)).toMatchObject({ state: "submitted", transaction_hash: hash });

      await service.kill("SIGKILL");
      proxy.hideTransactions = false;
      expect(await request).toBe("cut off");

      const restarted = await service.restart();
      await restarted.listening();
      await expectRecovered(
        { service: restarted, db, hash, payer, amount: 2_000_000n, sellerBefore, startLedger },
        payment,
      );
    });
  });

  it("K3: expires a transaction whose time bound passed while the service was down, and nothing moves", async () => {
    const { db, env } = await environment();
    const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
    const payment = await pay(payer, 5_000_000n, 30);
    const sellerBefore = await net.tokenBalance(usdc.sac, seller.publicKey());
    const service = await start(env);

    proxy.onSendTransaction = () => "hold";
    const held = once(proxy.events, "held") as Promise<[HeldEvent]>;
    const request = settleUntilKilled(service, payment);
    const [event] = await held;
    const hash = hashOf(event.transaction);
    const inner = innerOf(event.transaction);
    const validUntil = Number(inner.timeBounds?.maxTime ?? 0);
    const channelSequence = (await net.server.getAccount(inner.source)).sequenceNumber();
    expect(BigInt(channelSequence) + 1n).toBe(BigInt(inner.sequence));

    await service.kill("SIGKILL");
    proxy.discardHeld();
    proxy.onSendTransaction = undefined;
    expect(await request).toBe("cut off");

    // Down until a ledger closes after the transaction's upper time bound.
    await expect
      .poll(async () => closeTime((await net.server.getTransaction(hash)).latestLedgerCloseTime), {
        timeout: 90_000,
        interval: 1_000,
      })
      .toBeGreaterThan(validUntil);

    const restarted = await service.restart();
    await restarted.listening();
    await expect.poll(async () => (await row(db))?.state, { timeout: 30_000, interval: 200 }).toBe("expired");
    expect((await row(db))?.response).toMatchObject({
      success: false,
      errorReason: "settle_exact_stellar_transaction_expired",
      transaction: hash,
    });
    // Nothing was broadcast after the crash, nothing moved, and the channel's sequence is untouched.
    expect(distinctHashes(proxy.sent)).toEqual([hash]);
    expect(proxy.sent).toHaveLength(1);
    expect((await net.server.getTransaction(hash)).status).toBe(rpc.Api.GetTransactionStatus.NOT_FOUND);
    expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(1_000_000_000n);
    expect(await net.tokenBalance(usdc.sac, seller.publicKey())).toBe(sellerBefore);
    expect((await net.server.getAccount(inner.source)).sequenceNumber()).toBe(channelSequence);
    expect(await leasedChannels(db)).toBe(0);
    expect(await metric(restarted, "rail402_settlements_reconciled_total", { outcome: "expired" })).toBe(1);

    // A repeat returns the stored outcome.
    const repeat = await settle(restarted, payment);
    expect(repeat.body).toMatchObject({
      success: false,
      errorReason: "settle_exact_stellar_transaction_expired",
      transaction: hash,
    });

    // The payer can pay again with a new authorization, and that payment settles.
    const again = await pay(payer, 5_000_000n, 120);
    const settled = await settle(restarted, again);
    expect(settled.body).toMatchObject({ success: true, payer: payer.publicKey() });
    expect(settled.body.transaction).not.toBe(hash);
    expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(1_000_000_000n - 5_000_000n);
  }, 240_000);

  it("keeps a settlement the RPC can no longer prove absent unresolved, and reports it", async () => {
    const { db, env } = await environment();
    // A settlement recorded three days ago whose time bound passed long ago. The RPC's history is
    // shorter than that, so NOT_FOUND cannot tell "never included" from "included and forgotten".
    const ledger = new PostgresSettlementLedger(db);
    const { record } = await ledger.claim(
      { network: NETWORK, payer: Keypair.random().publicKey(), nonce: "1" },
      { payloadHash: "0".repeat(64), requestHash: "0".repeat(64) },
      "crashed",
      60_000,
    );
    const hash = randomBytes(32).toString("hex");
    await ledger.recordEnvelope(record.id, "crashed", {
      channel: Keypair.random().publicKey(),
      transactionHash: hash,
      innerTransactionHash: hash,
      envelopeXdr: "AAAA",
      validUntil: Math.floor(Date.now() / 1_000) - 3 * 86_400 + 60,
      maxFeeStroops: "100",
    });
    await sql`UPDATE settlements SET created_at = now() - interval '3 days' WHERE id = ${record.id}`.execute(
      db,
    );

    const service = await start(env);
    await expect
      .poll(() => metric(service, "rail402_settlements_reconciled_total", { outcome: "unresolvable" }), {
        timeout: 30_000,
        interval: 250,
      })
      .toBeGreaterThanOrEqual(2);
    expect(await metric(service, "rail402_settlements_unresolvable", {})).toBe(1);
    expect(await row(db)).toMatchObject({ state: "submitted", response: null });
    expect(await metric(service, "rail402_settlements_reconciled_total", { outcome: "expired" })).toBe(0);
    expect(proxy.sent).toEqual([]);
    expect(service.logs).toContainEqual(
      expect.objectContaining({
        level: 40,
        transaction: hash,
        msg: expect.stringMatching(/^settlement unresolvable/) as unknown,
      }),
    );
  });
});

/** The value of one Prometheus sample whose labels include `labels` (network is always testnet). */
async function metric(
  service: ServiceProcess,
  name: string,
  labels: Record<string, string>,
): Promise<number> {
  const text = await (await fetch(`${service.url}/metrics`)).text();
  const wanted = Object.entries({ network: NETWORK, ...labels }).map(([key, value]) => `${key}="${value}"`);
  for (const line of text.split("\n")) {
    if (!line.startsWith(`${name}{`)) continue;
    const labelText = line.slice(name.length + 1, line.indexOf("}"));
    const present = labelText.split(",");
    if (wanted.every((label) => present.includes(label))) return Number(line.slice(line.indexOf("}") + 1));
  }
  return 0;
}

/** RPC close times arrive as decimal strings despite the SDK's `number` type. */
function closeTime(value: number | string): number {
  return Number(value);
}

function envelopeOf(transaction: string | undefined): Transaction | FeeBumpTransaction {
  if (transaction === undefined) throw new Error("no envelope");
  return TransactionBuilder.fromXDR(transaction, net.passphrase);
}

function hashOf(transaction: string | undefined): string {
  return envelopeOf(transaction).hash().toString("hex");
}

function innerOf(transaction: string | undefined): Transaction {
  const envelope = envelopeOf(transaction);
  return envelope instanceof FeeBumpTransaction ? envelope.innerTransaction : envelope;
}

function distinctHashes(envelopes: readonly string[]): string[] {
  return [...new Set(envelopes.map((envelope) => hashOf(envelope)))];
}
