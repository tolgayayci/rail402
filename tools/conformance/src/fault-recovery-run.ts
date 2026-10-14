/**
 * Crash recovery of a real Rail402 process, killed with SIGKILL at the points of a settlement where a
 * crash could lose track of money, then restarted on the same Postgres records:
 *
 * - K0: the network accepted the transaction, and its answer never reached Rail402;
 * - K1: the envelope was recorded, and the broadcast never left the host;
 * - K3: as K1, and the service stays down until the transaction's time bound has passed (`exact`).
 *
 * Rail402 reaches the network through the RPC fault proxy (`@rail402.dev/testkit` rpc-proxy), which
 * holds the submission or its answer and records every envelope sent. After the restart the new
 * process must finish the settlement from its durable record alone: K0 and K1 end `succeeded` with the
 * original transaction and no other envelope ever sent; K3 ends `expired` with nothing broadcast after
 * the crash and nothing moved. A repeat of the payment answers the recorded outcome. Used by
 * `fault-recovery.ts` (public testnet) and by the integration test against the local network.
 */
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { FeeBumpTransaction, Keypair, TransactionBuilder, rpc, type Transaction } from "@stellar/stellar-sdk";
import { sql, type Kysely } from "kysely";
import { createEd25519Signer } from "@x402/stellar";
import { createDatabase, migrate, type Database } from "@rail402.dev/store-postgres";
import { UptoStellarScheme as UptoStellarClient } from "@rail402.dev/upto/client";
import {
  ServiceProcess,
  requirementsFor,
  startRpcProxy,
  type HeldEvent,
  type LocalNetwork,
  type RpcProxy,
} from "@rail402.dev/testkit";
import type { CheckId, EvidenceCase, EvidenceTransaction } from "./evidence.ts";
import { isRepeat, parseExposition, total } from "./concurrency-run.ts";
import { readTarget, settledTransaction, type Target } from "./harness.ts";

export type KillPoint = "k0" | "k1" | "k3";
export type FaultScheme = "exact" | "upto";

export interface FaultCase {
  readonly point: KillPoint;
  readonly scheme: FaultScheme;
}

/** The cases the testnet run makes: K0 and K1 for both schemes, K3 for `exact`. */
export const DEFAULT_FAULT_CASES: readonly FaultCase[] = [
  { point: "k0", scheme: "exact" },
  { point: "k1", scheme: "exact" },
  { point: "k3", scheme: "exact" },
  { point: "k0", scheme: "upto" },
  { point: "k1", scheme: "upto" },
];

export interface FaultRecoveryOptions {
  /** The network Rail402 settles on, read directly (never through the proxy). */
  readonly net: LocalNetwork;
  /** The service's entry module (`apps/rail402/src/main.ts`). */
  readonly entry: string;
  /** A Postgres database; the run creates, migrates and drops its own schema in it. */
  readonly databaseUrl: string;
  readonly asset: { readonly contract: string; readonly symbol: string; readonly decimals: number };
  /** Service variables besides the store, RPC, sponsor and channels: assets, fee ceilings, upto. */
  readonly env: Readonly<Record<string, string>>;
  /** A funded G… payer holding at least twice `amount` of the asset. */
  payer(): Promise<Keypair>;
  readonly payTo: string;
  /** What each payment moves, in base units; an `upto` payment authorizes twice this. */
  readonly amount: bigint;
  readonly cases?: readonly FaultCase[];
  /** For `upto`: the settlement contract (canonical when omitted) and the client's ledger time. */
  readonly upto?: { readonly contract?: string; readonly ledgerSeconds?: number };
  /** How often the restarted service reconciles; 1000 ms by default. */
  readonly reconcileIntervalMs?: number;
  readonly log?: (message: string) => void;
}

export interface FaultRecoveryRun {
  readonly cases: EvidenceCase[];
  /** The first process as the run found it: `/health` version and `/supported`, verbatim. */
  readonly target: Target | undefined;
  readonly sponsor: string;
  readonly startedAt: string;
  readonly finishedAt: string;
}

const CHANNELS = 2;

/** Runs every case on one Rail402 deployment (one sponsor, one Postgres schema) and returns its evidence cases. */
export async function runFaultRecovery(options: FaultRecoveryOptions): Promise<FaultRecoveryRun> {
  const log = options.log ?? (() => undefined);
  const { net } = options;
  const startedAt = new Date().toISOString();
  const schema = `fault_${randomBytes(6).toString("hex")}`;
  const admin = createDatabase({ connectionString: options.databaseUrl, maxConnections: 1 });
  await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
  const db = createDatabase({ connectionString: options.databaseUrl, schema, maxConnections: 2 });
  const proxy = await startRpcProxy(net.rpcUrl);
  const cases: EvidenceCase[] = [];
  const sponsor = Keypair.random();
  const found: { target?: Target } = {};
  try {
    await migrate(db);
    await net.fund(sponsor);
    const separator = options.databaseUrl.includes("?") ? "&" : "?";
    const env = {
      STORE: "postgres",
      DATABASE_URL: `${options.databaseUrl}${separator}options=-c%20search_path%3D${schema}`,
      TESTNET_RPC_URL: proxy.url,
      TESTNET_SPONSOR_SECRET: sponsor.secret(),
      TESTNET_CHANNEL_COUNT: String(CHANNELS),
      TESTNET_MIN_SPONSOR_BALANCE_XLM: "1",
      RECONCILE_INTERVAL_MS: String(options.reconcileIntervalMs ?? 1_000),
      // One replica: nothing else can be confirming what the killed process recorded.
      SETTLE_RECONCILE_IDLE_MS: "0",
      BAZAAR_ENABLED: "false",
      RATE_LIMIT_PER_MINUTE: "0",
      ...options.env,
    };
    for (const entry of options.cases ?? DEFAULT_FAULT_CASES) {
      const id = `${entry.point}-${entry.scheme}`;
      const started = performance.now();
      const observations: Record<string, unknown> = {};
      const transactions: EvidenceTransaction[] = [];
      let problem: string | undefined;
      try {
        await runCase(entry, { options, env, db, proxy, observations, transactions, found });
      } catch (error) {
        problem = error instanceof Error ? error.message : String(error);
        observations["error"] = problem;
      } finally {
        await stopAll();
        proxy.reset();
      }
      log(`${problem === undefined ? "PASS" : "FAIL"} ${id}${problem === undefined ? "" : `: ${problem}`}`);
      cases.push({
        id,
        title: TITLES[entry.point](entry.scheme),
        checks: ["crash-recovery", ...(entry.scheme === "upto" ? (["scheme-upto"] as CheckId[]) : [])],
        scheme: entry.scheme,
        asset: options.asset.symbol,
        payer: "G",
        payTo: "G",
        status: problem === undefined ? "passed" : "failed",
        elapsedMs: Math.round(performance.now() - started),
        ...(transactions.length === 0 ? {} : { transactions }),
        observations,
      });
    }
  } finally {
    await stopAll();
    await proxy.close();
    await db.destroy();
    await sql`DROP SCHEMA IF EXISTS ${sql.id(schema)} CASCADE`.execute(admin);
    await admin.destroy();
  }
  return {
    cases,
    target: found.target,
    sponsor: sponsor.publicKey(),
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

const TITLES: Record<KillPoint, (scheme: FaultScheme) => string> = {
  k0: (scheme) =>
    `K0 (${scheme}): killed after the network accepted the transaction; the restarted process finds it`,
  k1: (scheme) =>
    `K1 (${scheme}): killed before the broadcast left; the restarted process rebroadcasts the identical bytes`,
  k3: (scheme) =>
    `K3 (${scheme}): killed before the broadcast and down past the time bound; expired, nothing moved`,
};

interface CaseContext {
  readonly options: FaultRecoveryOptions;
  readonly env: Record<string, string>;
  readonly db: Kysely<Database>;
  readonly proxy: RpcProxy;
  readonly observations: Record<string, unknown>;
  readonly transactions: EvidenceTransaction[];
  readonly found: { target?: Target };
}

const services = new Set<ServiceProcess>();

async function stopAll() {
  await Promise.all([...services].map((service) => service.kill("SIGKILL")));
  services.clear();
}

async function runCase(entry: FaultCase, context: CaseContext): Promise<void> {
  const { options, env, db, proxy, observations } = context;
  const { net, asset, payTo, amount } = options;
  const clock = () => new Date().toISOString();

  const service = await start(options.entry, env);
  context.found.target ??= await readTarget(service.url, "local");
  proxy.reset();
  const payer = await options.payer();
  // K3 needs a short time bound to outlive; K0 and K1 an authorization that outlives the restart.
  const payment = await pay(entry.scheme, entry.point === "k3" ? 30 : 120, payer, options);
  const before = {
    payer: await net.tokenBalance(asset.contract, payer.publicKey()),
    payTo: await net.tokenBalance(asset.contract, payTo),
  };

  if (entry.point === "k0") proxy.holdResponses("sendTransaction");
  else proxy.onSendTransaction = () => "hold";
  const held = once(proxy.events, "held") as Promise<[HeldEvent]>;
  const request = settle(service.url, payment).then(
    () => "answered",
    () => "cut off",
  );
  const [event] = await held;
  const envelope = event.transaction ?? "";
  const hash = hashOf(envelope, net.passphrase);
  const recorded = await row(db, hash);
  if (recorded?.state !== "submitted")
    throw new Error(`the record is ${recorded?.state ?? "missing"}, not submitted`);
  observations["transaction"] = hash;
  observations["recordedBeforeKill"] = "submitted";

  observations["killedAt"] = clock();
  const killed = await service.kill("SIGKILL");
  services.delete(service);
  observations["killSignal"] = killed.signal;
  const sentBeforeKill = [...proxy.sent];
  proxy.discardHeld();
  proxy.reset();
  observations["request"] = await request;

  if (entry.point === "k3") {
    // Down until a ledger closes after the transaction's upper time bound.
    const validUntil = Number(innerOf(envelope, net.passphrase).timeBounds?.maxTime ?? 0);
    observations["validUntil"] = validUntil;
    await until(
      async () => closeTime((await net.server.getTransaction(hash)).latestLedgerCloseTime) > validUntil,
      180_000,
    );
  }

  const restarted = await start(options.entry, env);
  observations["restartedAt"] = clock();
  const expected = entry.point === "k3" ? "expired" : "succeeded";
  await until(async () => (await row(db, hash))?.state === expected, 90_000);
  observations["recoveredAt"] = clock();
  observations["state"] = expected;

  // Only the recorded bytes were ever sent, by either process: no replacement transaction.
  const envelopes = [
    ...new Set([...sentBeforeKill, ...proxy.sent].map((sent) => hashOf(sent, net.passphrase))),
  ];
  observations["distinctEnvelopes"] = envelopes;
  observations["sendsAfterRestart"] = proxy.sent.length;
  if (envelopes.length !== 1 || envelopes[0] !== hash) {
    throw new Error(`envelopes sent: ${envelopes.join(", ")}; expected only ${hash}`);
  }
  const reconciled = total(
    parseExposition(await (await fetch(`${restarted.url}/metrics`)).text()),
    "rail402_settlements_reconciled_total",
    { outcome: expected },
  );
  observations["reconciled"] = reconciled;
  if (reconciled < 1) throw new Error(`the restarted process reconciled nothing as ${expected}`);
  const leased = await db
    .selectFrom("channels")
    .select((eb) => eb.fn.countAll<string>().as("count"))
    .where("leased_at", "is not", null)
    .executeTakeFirstOrThrow();
  if (Number(leased.count) !== 0) throw new Error(`${leased.count} channels still leased`);

  const after = {
    payer: await net.tokenBalance(asset.contract, payer.publicKey()),
    payTo: await net.tokenBalance(asset.contract, payTo),
  };
  const repeat = await settle(restarted.url, payment);
  observations["repeat"] = { status: repeat.status, body: repeat.body, marked: repeat.repeat };
  if (expected === "succeeded") {
    context.transactions.push(
      await settledTransaction(net, hash, {
        scheme: entry.scheme,
        asset: asset.contract,
        decimals: asset.decimals,
        amount,
        payerType: "G",
        withXdr: true,
      }),
    );
    const transfers = context.transactions.at(-1)?.transfers ?? [];
    const wanted = [{ from: payer.publicKey(), to: payTo, amount: amount.toString() }];
    if (JSON.stringify(transfers) !== JSON.stringify(wanted))
      throw new Error(`moved ${JSON.stringify(transfers)}`);
    if (after.payer !== before.payer - amount || after.payTo !== before.payTo + amount) {
      throw new Error("the payer was not debited exactly once");
    }
    if (repeat.body["success"] !== true || repeat.body["transaction"] !== hash || !repeat.repeat) {
      throw new Error(`the repeat answered ${JSON.stringify(repeat.body)}`);
    }
  } else {
    const status = (await net.server.getTransaction(hash)).status;
    observations["onChain"] = status;
    if (status !== rpc.Api.GetTransactionStatus.NOT_FOUND)
      throw new Error(`the expired transaction is ${status}`);
    if (after.payer !== before.payer || after.payTo !== before.payTo) throw new Error("funds moved");
    if (repeat.body["errorReason"] !== `settle_${entry.scheme}_stellar_transaction_expired`) {
      throw new Error(`the repeat answered ${JSON.stringify(repeat.body)}`);
    }
  }
}

async function start(entry: string, env: Record<string, string>): Promise<ServiceProcess> {
  const service = await ServiceProcess.start({ entry, env });
  services.add(service);
  await service.listening(120_000);
  await until(async () => (await fetch(`${service.url}/ready`)).status === 200, 120_000);
  return service;
}

interface Payment {
  readonly paymentPayload: unknown;
  readonly paymentRequirements: unknown;
}

/** A payment of `amount`: `exact` for that price, `upto` capped at twice it and settling it. */
async function pay(
  scheme: FaultScheme,
  maxTimeoutSeconds: number,
  payer: Keypair,
  options: FaultRecoveryOptions,
): Promise<Payment> {
  const { net, asset, payTo, amount } = options;
  if (scheme === "exact") {
    const requirements = requirementsFor(asset.contract, payTo, amount, maxTimeoutSeconds);
    return { paymentPayload: await net.payment(payer, requirements), paymentRequirements: requirements };
  }
  const supported = await readUptoAuthority(options);
  const client = new UptoStellarClient(createEd25519Signer(payer.secret(), "stellar:testnet"), {
    latestLedger: () => net.latestLedger(),
    ...(options.upto?.contract === undefined ? {} : { contracts: options.upto.contract }),
    ...(options.upto?.ledgerSeconds === undefined ? {} : { ledgerSeconds: options.upto.ledgerSeconds }),
  });
  const published = {
    scheme: "upto",
    network: "stellar:testnet" as const,
    asset: asset.contract,
    payTo,
    amount: (amount * 2n).toString(),
    maxTimeoutSeconds,
    extra: { areFeesSponsored: true, facilitatorAddress: supported },
  };
  const created = await client.createPaymentPayload(2, published);
  return {
    paymentPayload: {
      x402Version: 2,
      resource: { url: "https://seller.example/metered" },
      accepted: published,
      payload: created.payload,
    },
    paymentRequirements: { ...published, amount: amount.toString() },
  };
}

/** The settlement authority the running deployment advertises. */
async function readUptoAuthority(options: FaultRecoveryOptions): Promise<string> {
  const service = [...services][0];
  if (service === undefined) throw new Error("no running service");
  const supported = (await (await fetch(`${service.url}/supported`)).json()) as {
    kinds?: { scheme?: string; extra?: { facilitatorAddress?: unknown } }[];
  };
  const authority = supported.kinds?.find((kind) => kind.scheme === "upto")?.extra?.facilitatorAddress;
  if (typeof authority !== "string")
    throw new Error(`the service does not serve upto in ${options.asset.symbol}`);
  return authority;
}

async function settle(url: string, payment: Payment) {
  const response = await fetch(`${url}/settle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ x402Version: 2, ...payment }),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
    repeat: isRepeat(response.headers.get("extension-responses")),
  };
}

async function row(db: Kysely<Database>, hash: string) {
  return db
    .selectFrom("settlements")
    .select(["state", "transaction_hash"])
    .where("transaction_hash", "=", hash)
    .executeTakeFirst();
}

async function until(done: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await done().catch(() => false))) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${String(timeoutMs)} ms`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function hashOf(envelope: string, passphrase: string): string {
  return TransactionBuilder.fromXDR(envelope, passphrase).hash().toString("hex");
}

function innerOf(envelope: string, passphrase: string): Transaction {
  const parsed = TransactionBuilder.fromXDR(envelope, passphrase);
  return parsed instanceof FeeBumpTransaction ? parsed.innerTransaction : parsed;
}

/** RPC close times arrive as decimal strings despite the SDK's `number` type. */
function closeTime(value: number | string): number {
  return Number(value);
}
