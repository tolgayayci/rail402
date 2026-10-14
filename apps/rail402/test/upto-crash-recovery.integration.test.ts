/**
 * Crash recovery of `upto` settlements in the real service process. Rail402 runs as a child process
 * over Postgres with its RPC behind a fault proxy, serves `upto` with the committed settlement
 * contract deployed per run, and is killed with SIGKILL at each point where a crash could lose track
 * of a settlement:
 *
 * - K0: the network accepted the transaction, and its answer never reached Rail402;
 * - K1: the envelope was recorded, and the broadcast never left the host;
 * - K2: the transaction was included, and Rail402 never saw the confirmation.
 *
 * After a restart the new process finishes the settlement from its durable record alone: it finds or
 * rebroadcasts the original bytes, never builds a replacement, settles the amount exactly once, keeps
 * the amount in its answer and releases the channel.
 *
 * Needs `docker compose --profile stellar up -d` and Postgres.
 */
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Keypair, TransactionBuilder, nativeToScVal, rpc } from "@stellar/stellar-sdk";
import { sql, type Kysely } from "kysely";
import type { SettleResponse } from "@x402/core/types";
import {
  deriveAuthorityKeypair,
  deriveChannelKeypairs,
  provisionAuthority,
  provisionChannels,
} from "@rail402.dev/facilitator";
import { createDatabase, migrate, type Database } from "@rail402.dev/store-postgres";
import { resolveLedgerSeconds } from "@rail402.dev/upto";
import {
  LocalNetwork,
  ServiceProcess,
  deployUpto,
  startRpcProxy,
  stopServiceProcesses,
  type HeldEvent,
  type IssuedAsset,
  type LocalUptoContract,
  type RpcProxy,
} from "@rail402.dev/testkit";
import { DATABASE_URL } from "./service-harness.ts";
import { NETWORK, accountPayer, uptoPayment, uptoRequirements, withAmount } from "./upto-harness.ts";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const RECONCILE_INTERVAL_MS = 1_000;
const CHANNELS = 2;
/** The policy maximum, so the authorization outlives a kill and a restart on 1 s ledgers. */
const TIMEOUT_SECONDS = 300;
const FUNDS = 1_000_000_000n;
const net = new LocalNetwork();
const available = await net.available();

interface Settled {
  readonly status: number;
  readonly body: SettleResponse;
  readonly extensions: string | null;
}

describe.skipIf(!available)("crash recovery of upto settlements (SIGKILL)", () => {
  let usdc: IssuedAsset;
  let contract: LocalUptoContract;
  let seller: Keypair;
  let sponsor: Keypair;
  let authority: Keypair;
  let proxy: RpcProxy;
  let ledgerSeconds: number;
  const schemas: string[] = [];
  const databases: Kysely<Database>[] = [];

  beforeAll(async () => {
    [usdc, contract] = await Promise.all([net.issueAsset("USDC"), deployUpto(net)]);
    seller = await net.holder(usdc, "0");
    sponsor = Keypair.random();
    await net.fund(sponsor);
    authority = deriveAuthorityKeypair(sponsor, NETWORK);
    // Provisioned up front, so the only transactions through the proxy are settlements.
    await provisionChannels({
      server: net.server,
      passphrase: net.passphrase,
      sponsor,
      channels: deriveChannelKeypairs(sponsor, NETWORK, CHANNELS),
    });
    await provisionAuthority({ server: net.server, passphrase: net.passphrase, sponsor, authority });
    proxy = await startRpcProxy(net.rpcUrl);
    // The child process estimates the ledger time the same way (upstream's Horizon estimate).
    ledgerSeconds = await resolveLedgerSeconds(NETWORK);
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
    const schema = `crash_upto_${randomBytes(6).toString("hex")}`;
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
      TESTNET_ASSETS: `${usdc.sac}:USDC:7`,
      TESTNET_MIN_SPONSOR_BALANCE_XLM: "1",
      TESTNET_UPTO_ENABLED: "true",
      TESTNET_UPTO_CONTRACT: contract.address,
      TESTNET_UPTO_WASM_HASH: contract.wasmHash,
      TESTNET_UPTO_TTL_KEEPER: "false",
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

  /** A fresh payer's authorization for the cap, and the seller's settle requirements for `amount`. */
  const pay = async (amount: bigint) => {
    const keys = await net.holder(usdc, "100");
    const accepted = uptoRequirements({
      asset: usdc.sac,
      payTo: seller.publicKey(),
      authority: authority.publicKey(),
      amount: 10_000_000n,
      maxTimeoutSeconds: TIMEOUT_SECONDS,
    });
    const payload = await uptoPayment(net, {
      contract: contract.address,
      payer: accountPayer(keys),
      accepted,
      ledgerSeconds,
    });
    return { keys, payload, requirements: withAmount(accepted, amount) };
  };

  type Payment = Awaited<ReturnType<typeof pay>>;

  const settle = async (service: ServiceProcess, payment: Payment): Promise<Settled> => {
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
  const settleUntilKilled = (service: ServiceProcess, payment: Payment) =>
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

  /** `upto_settled` events for `payer` from the settlement contract since `startLedger`. */
  const settlementsOf = async (payer: string, startLedger: number) => {
    const { events } = await net.server.getEvents({
      startLedger,
      filters: [
        {
          type: "contract",
          contractIds: [contract.address],
          topics: [
            [
              nativeToScVal("upto_settled", { type: "symbol" }).toXDR("base64"),
              nativeToScVal(payer, { type: "address" }).toXDR("base64"),
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
  const expectRecovered = async (options: {
    service: ServiceProcess;
    db: Kysely<Database>;
    hash: string;
    payment: Payment;
    amount: bigint;
    sellerBefore: bigint;
    startLedger: number;
  }) => {
    const { service, db, hash, payment, amount, sellerBefore, startLedger } = options;
    const payer = payment.keys.publicKey();
    await expect
      .poll(async () => (await row(db))?.state, { timeout: 30_000, interval: 200 })
      .toBe("succeeded");
    expect(await row(db)).toMatchObject({
      scheme: "upto",
      amount: amount.toString(),
      transaction_hash: hash,
      settled_by: "rail402",
    });
    // Only the original bytes were ever sent, by either process: no replacement transaction.
    expect(distinctHashes(proxy.sent)).toEqual([hash]);
    // Settled once: one upto_settled event, the payer debited once and payTo credited once.
    expect(await settlementsOf(payer, startLedger)).toHaveLength(1);
    expect(await net.tokenBalance(usdc.sac, payer)).toBe(FUNDS - amount);
    expect(await net.tokenBalance(usdc.sac, seller.publicKey())).toBe(sellerBefore + amount);
    expect(await net.tokenBalance(usdc.sac, authority.publicKey())).toBe(0n);
    expect(await leasedChannels(db)).toBe(0);
    expect(await metric(service, "rail402_settlements_reconciled_total", { outcome: "succeeded" })).toBe(1);
    // A repeat is answered from the record with the original transaction and the settled amount.
    const repeat = await settle(service, payment);
    expect(repeat.status).toBe(200);
    expect(repeat.body).toMatchObject({
      success: true,
      transaction: hash,
      payer,
      amount: amount.toString(),
    });
    expect(JSON.parse(Buffer.from(repeat.extensions ?? "", "base64").toString("utf8"))).toMatchObject({
      rail402: { settlement: { repeat: true } },
    });
  };

  it("K0: finds the transaction the network accepted before the process died", async () => {
    const { db, env } = await environment();
    const payment = await pay(4_000_000n);
    const sellerBefore = await net.tokenBalance(usdc.sac, seller.publicKey());
    const startLedger = await net.latestLedger();
    const service = await start(env);

    // The network gets the transaction; Rail402 never gets the answer.
    proxy.holdResponses("sendTransaction");
    const held = once(proxy.events, "held") as Promise<[HeldEvent]>;
    const request = settleUntilKilled(service, payment);
    const [event] = await held;
    const hash = hashOf(event.transaction);
    expect(await row(db)).toMatchObject({ state: "submitted", transaction_hash: hash, scheme: "upto" });
    expect(await leasedChannels(db)).toBe(1);

    expect((await service.kill("SIGKILL")).signal).toBe("SIGKILL");
    proxy.discardHeld();
    expect(await request).toBe("cut off");

    const restarted = await service.restart();
    await restarted.listening();
    await expectRecovered({
      service: restarted,
      db,
      hash,
      payment,
      amount: 4_000_000n,
      sellerBefore,
      startLedger,
    });
  });

  it("K1: rebroadcasts the identical recorded bytes when the broadcast never left", async () => {
    const { db, env } = await environment();
    const payment = await pay(3_000_000n);
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
    await expectRecovered({
      service: restarted,
      db,
      hash,
      payment,
      amount: 3_000_000n,
      sellerBefore,
      startLedger,
    });
    // The held submission plus at least one rebroadcast, all of the same envelope.
    expect(proxy.sent.length).toBeGreaterThanOrEqual(2);
  });

  it("K2: finds a transaction that was included before the process saw it confirmed", async () => {
    const { db, env } = await environment();
    const payment = await pay(2_000_000n);
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
    await expectRecovered({
      service: restarted,
      db,
      hash,
      payment,
      amount: 2_000_000n,
      sellerBefore,
      startLedger,
    });
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
    const present = line.slice(name.length + 1, line.indexOf("}")).split(",");
    if (wanted.every((label) => present.includes(label))) return Number(line.slice(line.indexOf("}") + 1));
  }
  return 0;
}

function hashOf(transaction: string | undefined): string {
  if (transaction === undefined) throw new Error("no envelope");
  return TransactionBuilder.fromXDR(transaction, net.passphrase).hash().toString("hex");
}

function distinctHashes(envelopes: readonly string[]): string[] {
  return [...new Set(envelopes.map((envelope) => hashOf(envelope)))];
}
