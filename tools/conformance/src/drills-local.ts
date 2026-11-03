/**
 * The recovery drills on a local, production-like stack: the Rail402 service with its production
 * configuration surface (Postgres, channel accounts, the sponsor guard, the Bazaar) on the private
 * Stellar network behind a fault proxy, and the Explorer indexer for its drill (drills-explorer.ts),
 * scraped by Prometheus with the committed alert rules, probed by the blackbox exporter, with
 * Alertmanager delivering alerts to this process. Each drill injects its fault, waits for the alert,
 * follows the runbook's steps, and measures detection and recovery.
 *
 *   node --conditions=@rail402/source tools/conformance/src/drills-local.ts [--only a,b] [--write]
 *
 * Needs `docker compose --profile stellar up -d` and Docker for the monitoring containers. Rules run
 * with every `for` set to 0 s and a 2-second evaluation, so detection here measures the signal path,
 * not the production hold times. `--write` records tools/conformance/drills/local-stellar-testnet.json
 * from a clean checkout.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  Asset,
  BASE_FEE,
  type FeeBumpTransaction,
  Keypair,
  Operation,
  Transaction,
  TransactionBuilder,
  rpc,
} from "@stellar/stellar-sdk";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { sql } from "kysely";
import { createDatabase } from "@rail402.dev/store-postgres";
import {
  LocalNetwork,
  ServiceProcess,
  onChainSettlement,
  requirementsFor,
  stopServiceProcesses,
  startRpcProxy,
  type HeldEvent,
  type IssuedAsset,
  type RpcProxy,
} from "@rail402.dev/testkit";
import { ALERTS, THRESHOLDS, renderRules, type Alert } from "../../../deploy/monitoring/alerts.ts";
import { buildFreeze, buildSignerSetup, buildSweep, buildTopUp } from "../../../deploy/keys/ceremony.ts";
import { signEnvelope } from "../../../deploy/stellar-keys.ts";
import {
  DRILLS,
  summarize,
  writeDrillRun,
  type DrillCase,
  type DrillCheck,
  type DrillRun,
  type Exercise,
} from "./drills.ts";
import { localRegistry, startLocalExplorer } from "./drills-explorer.ts";
import { REPO_ROOT } from "./evidence.ts";
// The channel keys derive from the sponsor seed; the drill needs one to spend a channel's sequence.
import { deriveChannelKeypairs } from "../../../packages/facilitator/src/keys.ts";

const NETWORK = "stellar:testnet";
const DATABASE_URL =
  process.env["RAIL402_TEST_DATABASE_URL"] ?? "postgres://rail402:rail402@localhost:5432/rail402";
const PROMETHEUS =
  "prom/prometheus:v3.15.0@sha256:efd719c99d83b060d9daefdcf00360461adf279f45ef5391f8d111892118753e";
const ALERTMANAGER =
  "prom/alertmanager:v0.34.1@sha256:e9733bafb1bdef9b00e25a21f8f99dc26a22224bf16641ad754d1649f4c3357a";
const BLACKBOX =
  "prom/blackbox-exporter:v0.29.0@sha256:9613f2884689b6fad9f1939f6a3b0388c93a022cfaededb19545b329b5c83dea";
/** The sponsor balance floor the drill rules use, in stroops (500 XLM). */
const DRILL_SPONSOR_FLOOR = 5_000_000_000;
/**
 * The window in which the Explorer's walked-through ledger must move under the drill rules, instead of
 * the production hour: the drill indexer polls every second, so a stall shows within it.
 */
const DRILL_EXPLORER_STALL = "20s";
/** The prefix of the databases a run creates (the Explorer's); `RAIL402_TEST_DB_PREFIX` sets another. */
const DB_PREFIX = process.env["RAIL402_TEST_DB_PREFIX"] ?? "rail402_drill";
if (!/^[a-z][a-z0-9_]{0,30}$/.test(DB_PREFIX))
  throw new Error("RAIL402_TEST_DB_PREFIX must be a short lowercase name");

const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (line: string) => process.stderr.write(`==> ${line}\n`);

async function until<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let current: T | undefined;
    try {
      current = await read();
      if (done(current)) return current;
    } catch {
      // not yet
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

/** Whether `done` holds within the time given: a recovery check that is recorded, not thrown. */
async function reached<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs: number,
): Promise<boolean> {
  try {
    await until(read, done, timeoutMs, "a recovery check");
    return true;
  } catch {
    return false;
  }
}

const check = (name: string, ok: boolean): DrillCheck => ({ name, ok });

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// --- the service ---------------------------------------------------------------------------------

interface Service {
  readonly url: string;
  readonly port: number;
  readonly sponsor: Keypair;
  readonly schema: string;
  stop(): Promise<void>;
}

async function startService(
  net: LocalNetwork,
  usdc: IssuedAsset,
  rpcUrl: string,
  env: Record<string, string>,
  existing?: { sponsor: Keypair; schema: string; port: number },
): Promise<Service> {
  const sponsor = existing?.sponsor ?? Keypair.random();
  if (existing === undefined) await net.fund(sponsor);
  const schema = existing?.schema ?? `drill_${Math.random().toString(16).slice(2, 10)}`;
  if (existing === undefined) {
    const admin = createDatabase({ connectionString: DATABASE_URL, maxConnections: 1 });
    await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
    await admin.destroy();
  }
  const process = await ServiceProcess.start({
    entry: join(REPO_ROOT, "apps/rail402/src/main.ts"),
    ...(existing === undefined || existing.port === 0 ? {} : { port: existing.port }),
    env: {
      DATABASE_URL: `${DATABASE_URL}?options=-c%20search_path%3D${schema}`,
      NETWORKS: NETWORK,
      // A list of providers replaces the single one.
      ...(env["TESTNET_RPC_URLS"] === undefined ? { TESTNET_RPC_URL: rpcUrl } : {}),
      TESTNET_SPONSOR_SECRET: sponsor.secret(),
      TESTNET_CHANNEL_COUNT: "4",
      TESTNET_ASSETS: `${usdc.sac}:USDC:7`,
      TESTNET_MAX_TX_FEE_STROOPS: "2000000",
      TESTNET_UPTO_ENABLED: "false",
      SEARCH_EMBEDDINGS: "false",
      RATE_LIMIT_PER_MINUTE: "0",
      RAIL402_VERSION: "drill",
      ...env,
    },
  });
  await process.listening(120_000);
  const { port, url } = process;
  await until(
    () => fetch(`${url}/ready`),
    (response) => response.ok,
    120_000,
    "the service to be ready",
  );
  return {
    url,
    port,
    sponsor,
    schema,
    stop: async () => {
      await process.kill("SIGTERM");
    },
  };
}

async function dropSchema(schema: string): Promise<void> {
  const admin = createDatabase({ connectionString: DATABASE_URL, maxConnections: 1 });
  await sql`DROP SCHEMA IF EXISTS ${sql.id(schema)} CASCADE`.execute(admin);
  await admin.destroy();
}

// --- monitoring ----------------------------------------------------------------------------------

interface Monitoring {
  /** When Alertmanager first delivered `alert` as firing after `since`, as an ISO time. */
  firedSince(alert: string, since: number): string | undefined;
  /** Points Prometheus at another service port. */
  retarget(port: number): void;
  /** Scrapes an Explorer indexer's metrics on `port` (job `rail402-explorer-indexer`), or stops. */
  watchExplorer(port: number | undefined): void;
  /** Whether Prometheus holds `alert` as pending or firing now. */
  active(alert: string): Promise<boolean>;
  stop(): void;
  readonly versions: Record<string, string>;
}

/**
 * The committed rules with every hold time removed, the sponsor floor set for the drill stack and the
 * Explorer's stall window shortened to `DRILL_EXPLORER_STALL`.
 */
export function drillRules(alerts: readonly Alert[] = ALERTS): string {
  const expr = (alert: Alert) => {
    if (alert.name === "Rail402SponsorBalanceLow")
      return `rail402_sponsor_balance_stroops < ${String(DRILL_SPONSOR_FLOOR)}`;
    if (alert.name === "Rail402ExplorerLag")
      return alert.expr.replaceAll(`[${THRESHOLDS.explorerStall}]`, `[${DRILL_EXPLORER_STALL}]`);
    return alert.expr;
  };
  return renderRules(alerts.map((alert) => ({ ...alert, for: "0s", expr: expr(alert) })));
}

async function startMonitoring(servicePort: number): Promise<Monitoring> {
  const run = Math.random().toString(16).slice(2, 10);
  const directory = mkdtempSync(join(tmpdir(), "rail402-drill-"));
  const [promPort, amPort, bbPort] = [await freePort(), await freePort(), await freePort()];
  const fired: { alert: string; at: number }[] = [];
  const hook: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      try {
        const payload = JSON.parse(body) as { alerts?: { status: string; labels: { alertname?: string } }[] };
        for (const alert of payload.alerts ?? []) {
          if (alert.status === "firing" && alert.labels.alertname !== undefined) {
            fired.push({ alert: alert.labels.alertname, at: Date.now() });
          }
        }
      } catch {
        // not an Alertmanager payload
      }
      response.end("ok");
    });
  });
  await new Promise<void>((resolve) => hook.listen(0, "127.0.0.1", resolve));
  const hookPort = (hook.address() as AddressInfo).port;

  const targets: { service: number; explorer: number | undefined } = {
    service: servicePort,
    explorer: undefined,
  };
  const writePrometheus = () => {
    const { service: port, explorer } = targets;
    writeFileSync(
      join(directory, "prometheus.yml"),
      `global: { scrape_interval: 2s, evaluation_interval: 2s }
rule_files: [/etc/prometheus/alerts.yml]
alerting: { alertmanagers: [{ static_configs: [{ targets: ["127.0.0.1:${String(amPort)}"] }] }] }
scrape_configs:
  - job_name: rail402
    metrics_path: /metrics
    static_configs: [{ targets: ["127.0.0.1:${String(port)}"] }]
  - job_name: rail402-ready
    metrics_path: /probe
    params: { module: [rail402_ready] }
    static_configs: [{ targets: ["http://127.0.0.1:${String(port)}/ready"] }]
    relabel_configs:
      - { source_labels: [__address__], target_label: __param_target }
      - { source_labels: [__param_target], target_label: instance }
      - { target_label: __address__, replacement: "127.0.0.1:${String(bbPort)}" }
${
  explorer === undefined
    ? ""
    : `  - job_name: rail402-explorer-indexer
    metrics_path: /metrics
    static_configs: [{ targets: ["127.0.0.1:${String(explorer)}"] }]
`
}`,
    );
  };
  writePrometheus();
  writeFileSync(join(directory, "alerts.yml"), drillRules());
  writeFileSync(
    join(directory, "blackbox.yml"),
    readFileSync(join(REPO_ROOT, "deploy/monitoring/blackbox.yml")),
  );
  // Resolved alerts are delivered too: otherwise an alert that fired and resolved before a fault (a new
  // series) would not be delivered again when the fault raises it within the repeat interval.
  writeFileSync(
    join(directory, "alertmanager.yml"),
    `route: { receiver: drill, group_by: ["..."], group_wait: 0s, group_interval: 1s, repeat_interval: 1h }
receivers: [{ name: drill, webhook_configs: [{ url: "http://127.0.0.1:${String(hookPort)}/", send_resolved: true }] }]
`,
  );
  const docker = (...args: string[]) =>
    execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const names = [`drill-prom-${run}`, `drill-am-${run}`, `drill-bb-${run}`];
  const common = [
    "run",
    "-d",
    "--network",
    "host",
    "--user",
    String(process.getuid?.() ?? 65534),
    "-v",
    `${directory}:/cfg:ro`,
  ];
  docker(
    ...common,
    "--name",
    names[1] ?? "",
    ALERTMANAGER,
    "--config.file=/cfg/alertmanager.yml",
    "--storage.path=/tmp/am",
    `--web.listen-address=127.0.0.1:${String(amPort)}`,
    "--cluster.listen-address=",
  );
  docker(
    ...common,
    "--name",
    names[2] ?? "",
    BLACKBOX,
    "--config.file=/cfg/blackbox.yml",
    `--web.listen-address=127.0.0.1:${String(bbPort)}`,
  );
  docker(
    "run",
    "-d",
    "--network",
    "host",
    "--user",
    String(process.getuid?.() ?? 65534),
    "-v",
    `${directory}:/etc/prometheus:ro`,
    "--name",
    names[0] ?? "",
    PROMETHEUS,
    "--config.file=/etc/prometheus/prometheus.yml",
    "--storage.tsdb.path=/tmp/prom",
    `--web.listen-address=127.0.0.1:${String(promPort)}`,
    "--web.enable-lifecycle",
  );
  await until(
    () => fetch(`http://127.0.0.1:${String(promPort)}/-/ready`),
    (response) => response.ok,
    60_000,
    "Prometheus",
  );
  // The Watchdog proves the whole path before any drill counts on it.
  await until(
    () => Promise.resolve(fired.some((entry) => entry.alert === "Watchdog")),
    Boolean,
    60_000,
    "the Watchdog alert",
  );
  return {
    versions: { prometheus: PROMETHEUS, alertmanager: ALERTMANAGER, blackbox: BLACKBOX },
    firedSince: (alert, since) => {
      const found = fired.find((entry) => entry.alert === alert && entry.at >= since);
      return found === undefined ? undefined : new Date(found.at).toISOString();
    },
    retarget: (port) => {
      targets.service = port;
      writePrometheus();
      void fetch(`http://127.0.0.1:${String(promPort)}/-/reload`, { method: "POST" });
    },
    watchExplorer: (port) => {
      targets.explorer = port;
      writePrometheus();
      void fetch(`http://127.0.0.1:${String(promPort)}/-/reload`, { method: "POST" });
    },
    active: async (alert) => {
      const body = (await (await fetch(`http://127.0.0.1:${String(promPort)}/api/v1/alerts`)).json()) as {
        data?: { alerts?: { labels?: { alertname?: string } }[] };
      };
      return (body.data?.alerts ?? []).some((entry) => entry.labels?.alertname === alert);
    },
    stop: () => {
      for (const name of names) {
        try {
          docker("rm", "-f", name);
        } catch {
          // gone
        }
      }
      hook.close();
    },
  };
}

// --- payments ------------------------------------------------------------------------------------

interface Context {
  readonly net: LocalNetwork;
  readonly usdc: IssuedAsset;
  readonly seller: Keypair;
  readonly funder: Keypair;
}

async function payment(context: Context, payer: Keypair, maxTimeoutSeconds = 60) {
  const requirements = requirementsFor(
    context.usdc.sac,
    context.seller.publicKey(),
    100_000n,
    maxTimeoutSeconds,
  );
  const payload = (await context.net.payment(payer, requirements)) as PaymentPayload;
  return { payload, requirements: requirements as PaymentRequirements };
}

async function settleOnce(context: Context, service: Service, maxTimeoutSeconds = 60) {
  const [payer] = (await context.net.holders(context.usdc, 1, "10")) as [Keypair];
  const { payload, requirements } = await payment(context, payer, maxTimeoutSeconds);
  return new HTTPFacilitatorClient({ url: service.url }).settle(payload, requirements);
}

const definition = (exercise: Exercise) => {
  const found = DRILLS.find((entry) => entry.exercise === exercise);
  if (found === undefined) throw new Error(`no drill ${exercise}`);
  return found;
};

function severityOf(alert: string): "page" | "ticket" {
  const found = ALERTS.find((entry) => entry.name === alert);
  return found?.severity === "ticket" ? "ticket" : "page";
}

interface Recorded {
  readonly method: string;
  readonly injectedAt: string;
  readonly clearedAt: string;
  readonly firedAt: string | null;
  readonly source: "alertmanager" | "manual";
  readonly steps: string[];
  readonly completedAt: string;
  /** What recovery was checked by; the drill fails when any of them does not hold. */
  readonly checks: DrillCheck[];
  readonly failedRequests: number;
  readonly refusedCodes: string[];
  readonly transactions?: { hash: string; role: string }[];
  readonly notes?: string[];
}

function drillCase(exercise: Exercise, started: number, recorded: Recorded): DrillCase {
  const spec = definition(exercise);
  const seconds = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 100) / 10;
  const detected = recorded.source === "manual" || recorded.firedAt !== null;
  const passed = detected && recorded.checks.length > 0 && recorded.checks.every((entry) => entry.ok);
  return {
    id: exercise,
    title: spec.title,
    status: passed ? "passed" : "failed",
    elapsedMs: Date.now() - started,
    ...(recorded.transactions === undefined ? {} : { transactions: recorded.transactions }),
    observations: {
      drill: {
        exercise,
        environment: "local",
        threats: [...spec.threats],
        fault: { method: recorded.method, injectedAt: recorded.injectedAt, clearedAt: recorded.clearedAt },
        detection: {
          alert: spec.alert,
          severity: severityOf(spec.alert),
          source: recorded.source,
          firedAt: recorded.firedAt,
        },
        runbook: { section: spec.runbook, steps: recorded.steps },
        recovery: {
          completedAt: recorded.completedAt,
          verifiedBy: recorded.checks.map((entry) => entry.name),
        },
        timings: {
          detectSeconds: recorded.firedAt === null ? null : seconds(recorded.injectedAt, recorded.firedAt),
          recoverSeconds: seconds(recorded.injectedAt, recorded.completedAt),
        },
        impact: {
          failedRequests: recorded.failedRequests,
          refusedCodes: recorded.refusedCodes,
          fundsAtRisk: "none",
        },
      },
      otherNetwork: null,
      checks: recorded.checks,
      notes: [
        "A one-network local stack (testnet only): isolation between two networks served by one process is not exercised by this run.",
        ...(recorded.notes ?? []),
      ],
    },
  };
}

async function awaitAlert(
  monitoring: Monitoring,
  alert: string,
  since: number,
  timeoutMs = 120_000,
): Promise<string | null> {
  try {
    return (
      (await until(
        () => Promise.resolve(monitoring.firedSince(alert, since)),
        (value) => value !== undefined,
        timeoutMs,
        alert,
      )) ?? null
    );
  } catch {
    return null;
  }
}

// --- the drills ----------------------------------------------------------------------------------

async function rpcFailure(
  context: Context,
  proxy: RpcProxy,
  service: Service,
  monitoring: Monitoring,
): Promise<DrillCase> {
  const started = Date.now();
  const injectedAt = now();
  proxy.failRequests(503);
  const firedAt = await awaitAlert(monitoring, "Rail402NotReady", started);
  const ready = await fetch(`${service.url}/ready`);
  const health = (await (await fetch(`${service.url}/health`)).json()) as { warnings?: { code: string }[] };
  // The provider, asked directly rather than through the service, as the runbook's second step does.
  const direct = await fetch(proxy.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
  });
  const clearedAt = now();
  proxy.failRequests(undefined);
  const readyAgain = await reached(
    () => fetch(`${service.url}/ready`),
    (response) => response.ok,
    90_000,
  );
  const settled = await settleOnce(context, service);
  return drillCase("rpc-failure", started, {
    method: "the RPC proxy answers every request with HTTP 503",
    injectedAt,
    clearedAt,
    firedAt,
    source: "alertmanager",
    steps: [
      `read /ready: ${String(ready.status)}; /health warnings: ${(health.warnings ?? []).map((w) => w.code).join(", ") || "none"}`,
      `asked the provider directly: HTTP ${String(direct.status)}`,
      "restored the provider and waited for /ready",
    ],
    completedAt: now(),
    checks: [
      check("/ready answered 503 during the outage", ready.status === 503),
      check("the provider answered 503 when asked directly", direct.status === 503),
      check("/ready answered 200 after the provider returned", readyAgain),
      check("an exact payment settled after recovery", settled.success),
    ],
    failedRequests: 0,
    refusedCodes: [],
    transactions: settled.success ? [{ hash: settled.transaction, role: "settlement after recovery" }] : [],
  });
}

interface RpcStatus {
  readonly active?: string;
  readonly providers?: string[];
  readonly ok?: boolean;
}

/** The network's RPC block of `/health`, and the warning codes. */
async function rpcStatus(service: Service): Promise<{ rpc: RpcStatus; warnings: string[] }> {
  const health = (await (await fetch(`${service.url}/health`)).json()) as {
    networks?: Record<string, { rpc?: RpcStatus }>;
    warnings?: { code: string }[];
  };
  return {
    rpc: health.networks?.[NETWORK]?.rpc ?? {},
    warnings: (health.warnings ?? []).map((warning) => warning.code),
  };
}

async function rpcFailover(context: Context, primary: RpcProxy, monitoring: Monitoring): Promise<DrillCase> {
  // A second provider in front of the same network.
  const secondary = await startRpcProxy(context.net.rpcUrl);
  const service = await startService(context.net, context.usdc, primary.url, {
    TESTNET_RPC_URLS: `primary=${primary.url},secondary=${secondary.url}`,
  });
  monitoring.retarget(service.port);
  try {
    await sleep(4_000);
    const started = Date.now();
    const before = await rpcStatus(service);
    const injectedAt = now();
    primary.failRequests(503);
    // Readiness, sampled while the service moves to the secondary.
    const unready: number[] = [];
    const sampling = { on: true };
    const sampler = (async () => {
      while (sampling.on) {
        const ok = await fetch(`${service.url}/ready`).then(
          (response) => response.ok,
          () => false,
        );
        if (!ok) unready.push(Date.now());
        await sleep(250);
      }
    })();
    const switched = await reached(
      () => rpcStatus(service),
      (status) => status.rpc.active === "secondary",
      90_000,
    );
    const switchedAt = Date.now();
    const firedAt = await awaitAlert(monitoring, "Rail402RpcFailover", started);
    const during = await rpcStatus(service);
    // The runbook's second step: the failed provider, asked directly rather than through the service.
    const direct = await fetch(primary.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
    });
    const readyAfterSwitch = await reached(
      () => fetch(`${service.url}/ready`),
      (response) => response.ok,
      30_000,
    );
    sampling.on = false;
    await sampler;
    const [firstUnready, lastUnready] = [unready[0], unready.at(-1)];
    const unreadySeconds =
      firstUnready === undefined || lastUnready === undefined
        ? 0
        : Math.round((lastUnready - firstUnready) / 100) / 10;
    const [primarySent, secondarySent] = [primary.sent.length, secondary.sent.length];
    const settled = await settleOnce(context, service);
    const viaSecondary = secondary.sent.length > secondarySent && primary.sent.length === primarySent;
    const clearedAt = now();
    primary.failRequests(undefined);
    const restoredAt = Date.now();
    const failedBack = await reached(
      () => rpcStatus(service),
      (status) => status.rpc.active === "primary",
      180_000,
    );
    const failedBackAt = Date.now();
    const [primaryAgain, secondaryAgain] = [primary.sent.length, secondary.sent.length];
    const after = await settleOnce(context, service);
    const viaPrimary = primary.sent.length > primaryAgain && secondary.sent.length === secondaryAgain;
    const seconds = (from: number, to: number) => Math.round((to - from) / 100) / 10;
    return drillCase("rpc-failover", started, {
      method:
        "two providers in TESTNET_RPC_URLS, each a proxy in front of the same network; the primary answers every request with HTTP 503",
      injectedAt,
      clearedAt,
      firedAt,
      source: "alertmanager",
      steps: [
        `read /health before the fault: active ${before.rpc.active ?? "none"} of ${(before.rpc.providers ?? []).join(", ")}`,
        `read /health after ${String(seconds(Date.parse(injectedAt), switchedAt))} s: active ${during.rpc.active ?? "none"}; warnings: ${during.warnings.join(", ") || "none"}`,
        `asked the failed provider directly: HTTP ${String(direct.status)}; /ready had failed for ${String(unreadySeconds)} s before the switch`,
        "settled a payment while the primary was down",
        `restored the primary; the service moved back to it after ${String(seconds(restoredAt, failedBackAt))} s`,
        "settled a payment after the fail-back",
      ],
      completedAt: now(),
      checks: [
        check("/health named the primary active before the fault", before.rpc.active === "primary"),
        check("the primary answered 503 when asked directly", direct.status === 503),
        check("the service switched to the secondary while the primary failed", switched),
        check(
          "/health warned rpc_failover_active during the failover",
          during.warnings.includes("rpc_failover_active"),
        ),
        check("/ready answered 200 after the switch", readyAfterSwitch),
        check(
          "a payment settled during the failover, submitted through the secondary only",
          settled.success && viaSecondary,
        ),
        check("the service switched back to the primary after it returned", failedBack),
        check(
          "a payment settled after the fail-back, submitted through the primary only",
          after.success && viaPrimary,
        ),
      ],
      failedRequests: 0,
      refusedCodes: [],
      transactions: [
        ...(settled.success ? [{ hash: settled.transaction, role: "settlement through the secondary" }] : []),
        ...(after.success ? [{ hash: after.transaction, role: "settlement after the fail-back" }] : []),
      ],
      notes: [
        "The service reads every provider at each 15-second health poll; it moves to the next healthy provider after two unhealthy readings of the active one, and back after five healthy readings of the primary. The poll that first finds the active provider unhealthy marks the network's RPC unhealthy, so /ready fails until the switch.",
      ],
    });
  } finally {
    primary.failRequests(undefined);
    await service.stop();
    await dropSchema(service.schema);
    await secondary.close();
  }
}

async function sequenceConflict(
  context: Context,
  proxy: RpcProxy,
  service: Service,
  monitoring: Monitoring,
): Promise<DrillCase> {
  const started = Date.now();
  const [payer] = (await context.net.holders(context.usdc, 1, "10")) as [Keypair];
  const { payload, requirements } = await payment(context, payer, 30);
  let first = true;
  proxy.onSendTransaction = () => {
    if (!first) return "forward";
    first = false;
    return "hold";
  };
  const held = new Promise<HeldEvent>((resolve) => proxy.events.once("held", resolve));
  const settling = new HTTPFacilitatorClient({ url: service.url }).settle(payload, requirements);
  const { transaction } = await held;
  const envelope = TransactionBuilder.fromXDR(
    transaction ?? "",
    context.net.passphrase,
  ) as FeeBumpTransaction;
  const channelAddress = envelope.innerTransaction.source;
  const channel = deriveChannelKeypairs(service.sponsor, NETWORK, 8).find(
    (key) => key.publicKey() === channelAddress,
  );
  if (channel === undefined) throw new Error("the leased channel is not one of the sponsor's");
  const injectedAt = now();
  const inner = new TransactionBuilder(await context.net.server.getAccount(channelAddress), {
    fee: BASE_FEE,
    networkPassphrase: context.net.passphrase,
  })
    .addOperation(Operation.bumpSequence({ bumpTo: "0" }))
    .setTimeout(30)
    .build();
  inner.sign(channel);
  const bump = TransactionBuilder.buildFeeBumpTransaction(
    context.funder,
    "200",
    inner,
    context.net.passphrase,
  );
  bump.sign(context.funder);
  await context.net.submit(bump);
  await proxy.releaseHeld();
  const result = await settling;
  proxy.reset();
  const clearedAt = now();
  const firedAt = await awaitAlert(monitoring, "Rail402SequenceConflict", started);
  // The runbook's first step: find the transaction the service did not send, from the channel account.
  const conflicting = await context.net.server.getTransaction(bump.hash().toString("hex"));
  const retried = await settleOnce(context, service);
  return drillCase("sequence-conflict", started, {
    method:
      "a transaction from the leased channel account, signed with its derived key, submitted outside the service",
    injectedAt,
    clearedAt,
    firedAt,
    source: "alertmanager",
    steps: [
      `looked the transaction the service did not send up by its hash: ${conflicting.status}`,
      "settled a new payment through the service",
    ],
    completedAt: now(),
    checks: [
      check(
        "the conflicting transaction is on the ledger",
        conflicting.status === rpc.Api.GetTransactionStatus.SUCCESS,
      ),
      check(
        `the affected settlement was not reported as settled (answered ${result.success ? "success" : (result.errorReason ?? "failure")})`,
        !result.success,
      ),
      check("the next settlement succeeded", retried.success),
    ],
    failedRequests: result.success ? 0 : 1,
    refusedCodes: result.success || result.errorReason === undefined ? [] : [result.errorReason],
    transactions: [
      { hash: bump.hash().toString("hex"), role: "the conflicting transaction" },
      ...(retried.success ? [{ hash: retried.transaction, role: "settlement after recovery" }] : []),
    ],
  });
}

async function expiredAuthorization(context: Context, service: Service): Promise<DrillCase> {
  const started = Date.now();
  const [payer] = (await context.net.holders(context.usdc, 1, "10")) as [Keypair];
  const { payload, requirements } = await payment(context, payer, 10);
  const injectedAt = now();
  // Hold the signed payment past its expiration ledger, as a seller that settles late would.
  const signedAt = (await context.net.server.getLatestLedger()).sequence;
  await until(
    () => context.net.server.getLatestLedger(),
    (ledger) => ledger.sequence > signedAt + 6,
    120_000,
    "the expiration to pass",
  );
  const result = await new HTTPFacilitatorClient({ url: service.url }).settle(payload, requirements);
  const clearedAt = now();
  const fresh = await settleOnce(context, service);
  const reason = result.errorReason ?? "";
  return drillCase("expired-authorization", started, {
    method: "a payment held past its expiration ledger before /settle",
    injectedAt,
    clearedAt,
    firedAt: null,
    source: "manual",
    steps: [
      `read the refusal code the seller received: ${reason || "none"}`,
      "paid again with a fresh payment",
    ],
    completedAt: now(),
    checks: [
      check(
        `the late settle was refused as expired (${result.success ? "it settled" : reason})`,
        !result.success && /expired|expiration/.test(reason),
      ),
      check("a fresh payment settled", fresh.success),
    ],
    failedRequests: result.success ? 0 : 1,
    refusedCodes: result.success || result.errorReason === undefined ? [] : [result.errorReason],
    transactions: fresh.success ? [{ hash: fresh.transaction, role: "fresh payment" }] : [],
  });
}

async function channelExhaustion(
  context: Context,
  proxy: RpcProxy,
  monitoring: Monitoring,
): Promise<DrillCase> {
  const service = await startService(context.net, context.usdc, proxy.url, {
    TESTNET_CHANNEL_COUNT: "2",
    SETTLE_CHANNEL_WAIT_MS: "300",
  });
  monitoring.retarget(service.port);
  try {
    await sleep(4_000);
    const started = Date.now();
    const payers = await context.net.holders(context.usdc, 10, "10");
    const payments = await Promise.all(payers.map((payer) => payment(context, payer)));
    const client = new HTTPFacilitatorClient({ url: service.url });
    // Confirmation is held back, so every channel stays leased while the burst arrives.
    proxy.holdResponses("getTransaction");
    const injectedAt = now();
    const settling = Promise.all(
      payments.map(async ({ payload, requirements }, index) => {
        await sleep(index * 30);
        return client.settle(payload, requirements);
      }),
    );
    await sleep(3_000);
    await proxy.releaseHeld();
    proxy.reset();
    const results = await settling;
    const clearedAt = now();
    const firedAt = await awaitAlert(monitoring, "Rail402ChannelLeaseTimeouts", started);
    const refused = results.filter((result) => !result.success);
    const codes = [...new Set(refused.map((result) => result.errorReason ?? "unknown"))];
    const metrics = await (await fetch(`${service.url}/metrics`)).text();
    const inUse = /^rail402_channels_in_use\{network="stellar:testnet"\} (\d+)/m.exec(metrics)?.[1];
    const after = await settleOnce(context, service);
    return drillCase("channel-exhaustion", started, {
      method: "10 settlements at once against 2 channel accounts, with confirmation held back",
      injectedAt,
      clearedAt,
      firedAt,
      source: "alertmanager",
      steps: [
        `read the refusals: ${String(refused.length)} of ${String(results.length)} (${codes.join(", ") || "none"})`,
        `let the burst drain; rail402_channels_in_use is ${inUse ?? "unknown"} afterwards`,
      ],
      completedAt: now(),
      checks: [
        check(
          "every refusal during the burst was the retryable channel_unavailable",
          refused.length > 0 && codes.every((code) => code.endsWith("_channel_unavailable")),
        ),
        check("no channel stayed leased after the burst", inUse === "0"),
        check("the next settlement succeeded", after.success),
      ],
      failedRequests: refused.length,
      refusedCodes: codes,
      transactions: after.success ? [{ hash: after.transaction, role: "settlement after recovery" }] : [],
    });
  } finally {
    await service.stop();
    await dropSchema(service.schema);
  }
}

async function sponsorBalanceXlm(service: Service): Promise<number> {
  const health = (await (await fetch(`${service.url}/health`)).json()) as {
    networks?: Record<string, { sponsor?: { balanceStroops?: string } }>;
  };
  return Number(health.networks?.[NETWORK]?.sponsor?.balanceStroops ?? "0") / 1e7;
}

async function sponsorDepletion(
  context: Context,
  proxy: RpcProxy,
  monitoring: Monitoring,
): Promise<DrillCase> {
  const service = await startService(context.net, context.usdc, proxy.url, {
    TESTNET_CHANNEL_COUNT: "2",
    TESTNET_MIN_SPONSOR_BALANCE_XLM: "300",
    TESTNET_SPONSOR_RESERVE_XLM: "250",
  });
  monitoring.retarget(service.port);
  try {
    await sleep(4_000);
    const started = Date.now();
    const sink = Keypair.random();
    const balance = await sponsorBalanceXlm(service);
    // Spend the sponsor down to about 200 XLM, below the reserve and the readiness floor.
    const drain = new TransactionBuilder(await context.net.server.getAccount(service.sponsor.publicKey()), {
      fee: BASE_FEE,
      networkPassphrase: context.net.passphrase,
    })
      .addOperation(
        Operation.createAccount({
          destination: sink.publicKey(),
          startingBalance: (balance - 210).toFixed(7),
        }),
      )
      .setTimeout(60)
      .build();
    drain.sign(service.sponsor);
    const injectedAt = now();
    await context.net.submit(drain);
    const firedAt = await awaitAlert(monitoring, "Rail402SponsorBalanceLow", started);
    const notReady = await reached(
      () => fetch(`${service.url}/ready`),
      (response) => !response.ok,
      60_000,
    );
    const refused = await settleOnce(context, service);
    // The runbook's top-up: a reviewed payment from the treasury to the recorded sponsor address.
    const treasury = Keypair.random();
    await context.net.fund(treasury);
    const account = await context.net.server.getAccount(treasury.publicKey());
    const topUp = buildTopUp(
      { id: treasury.publicKey(), sequence: account.sequenceNumber() },
      service.sponsor.publicKey(),
      service.sponsor.publicKey(),
      "5000",
      "testnet",
    );
    topUp.sign(treasury);
    await context.net.submit(topUp);
    const clearedAt = now();
    const readyAgain = await reached(
      () => fetch(`${service.url}/ready`),
      (response) => response.ok,
      90_000,
    );
    const after = await settleOnce(context, service);
    return drillCase("sponsor-depletion", started, {
      method:
        "the sponsor's balance spent down to about 200 XLM, below its 250 XLM reserve and 300 XLM readiness floor",
      injectedAt,
      clearedAt,
      firedAt,
      source: "alertmanager",
      steps: [
        "checked the spend: one payment out of the sponsor account, not settlement fees",
        "topped up 5000 XLM from the treasury to the recorded sponsor address (buildTopUp refuses any other destination)",
        "waited for /ready",
      ],
      completedAt: now(),
      checks: [
        check("/ready failed while the sponsor was below its floor", notReady),
        check(
          `a settlement was refused while the sponsor was below its reserve (${refused.success ? "it settled" : (refused.errorReason ?? "refused")})`,
          !refused.success,
        ),
        check("/ready answered 200 after the top-up", readyAgain),
        check("an exact payment settled after the top-up", after.success),
      ],
      failedRequests: refused.success ? 0 : 1,
      refusedCodes: refused.success || refused.errorReason === undefined ? [] : [refused.errorReason],
      transactions: [
        { hash: drain.hash().toString("hex"), role: "the drain" },
        { hash: topUp.hash().toString("hex"), role: "the treasury top-up" },
        ...(after.success ? [{ hash: after.transaction, role: "settlement after recovery" }] : []),
      ],
    });
  } finally {
    await service.stop();
    await dropSchema(service.schema);
  }
}

async function degradedIndexing(
  context: Context,
  proxy: RpcProxy,
  monitoring: Monitoring,
): Promise<DrillCase> {
  const service = await startService(context.net, context.usdc, proxy.url, {});
  monitoring.retarget(service.port);
  await sleep(4_000);
  const started = Date.now();
  // A restart whose embedding model files are missing, as after a bad image or a lost volume.
  await service.stop();
  const injectedAt = now();
  let refusedStart = "";
  try {
    const unexpected = await startService(
      context.net,
      context.usdc,
      proxy.url,
      {
        SEARCH_EMBEDDINGS: "true",
        SEARCH_MODEL_DIR: join(tmpdir(), "rail402-drill-no-model"),
        SEARCH_MODEL_DOWNLOAD: "false",
      },
      { sponsor: service.sponsor, schema: service.schema, port: service.port },
    );
    await unexpected.stop();
  } catch (error) {
    refusedStart = ((error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "")
      .replace(/^service exited before logging "rail402 listening": /, "")
      .replaceAll(join(tmpdir(), "rail402-drill-no-model"), "<model directory>");
  }
  const firedAt = await awaitAlert(monitoring, "Rail402Down", started);
  const clearedAt = now();
  const restored = await startService(
    context.net,
    context.usdc,
    proxy.url,
    { SEARCH_EMBEDDINGS: "false" },
    {
      sponsor: service.sponsor,
      schema: service.schema,
      port: service.port,
    },
  );
  const search = await fetch(`${restored.url}/discovery/search?query=weather`);
  const body = (await search.json()) as { partialResults?: boolean };
  const after = await settleOnce(context, restored);
  await restored.stop();
  await dropSchema(service.schema);
  return drillCase("degraded-indexing-bazaar", started, {
    method: "a restart with the embedding model files missing",
    injectedAt,
    clearedAt,
    firedAt,
    source: "alertmanager",
    steps: [
      `the replica refused to start: ${refusedStart.slice(0, 160) || "it started"}`,
      "restarted with lexical search (SEARCH_EMBEDDINGS=false) until the model files are restored",
    ],
    completedAt: now(),
    checks: [
      check("the replica refused to start without its model files", refusedStart !== ""),
      check(
        `search answers HTTP 200 with lexical search (partialResults ${String(body.partialResults)})`,
        search.status === 200,
      ),
      check("an exact payment settled after the restart", after.success),
    ],
    failedRequests: 0,
    refusedCodes: [],
    notes: [
      "With two replicas restarted one at a time, the other replica keeps serving while this one refuses to start.",
    ],
  });
}

async function degradedExplorer(
  context: Context,
  proxy: RpcProxy,
  monitoring: Monitoring,
): Promise<DrillCase> {
  const from = (await context.net.server.getLatestLedger()).sequence;
  const service = await startService(context.net, context.usdc, proxy.url, {});
  monitoring.retarget(service.port);
  // The discovery source, behind its own fault proxy.
  const discovery = await startRpcProxy(context.net.rpcUrl);
  const registry = localRegistry(context.net.passphrase, from, {
    sponsor: service.sponsor.publicKey(),
    channels: deriveChannelKeypairs(service.sponsor, NETWORK, 4).map((key) => key.publicKey()),
  });
  const explorer = await startLocalExplorer({
    adminUrl: DATABASE_URL,
    databasePrefix: DB_PREFIX,
    registry,
    discoveryUrl: discovery.url,
    ledgerUrl: context.net.rpcUrl,
    log,
  });
  try {
    await until(
      () => Promise.resolve(explorer.lastLedger()),
      (ledger) => ledger !== null,
      60_000,
      "a discovery pass",
    );
    monitoring.watchExplorer(explorer.port);
    const first = await settleOnce(context, service);
    if (!first.success)
      throw new Error(`the first payment did not settle: ${first.errorReason ?? "unknown"}`);
    const indexedFirst = await reached(() => explorer.indexed(first.transaction), Boolean, 60_000);
    // A new series has no history yet: wait until Prometheus holds no Explorer lag before the fault.
    await sleep(6_000);
    await until(
      () => monitoring.active("Rail402ExplorerLag"),
      (active) => !active,
      60_000,
      "no Explorer lag alert",
    );
    const started = Date.now();
    const injectedAt = now();
    discovery.failRequests(503);
    const frozenAt = explorer.lastLedger();
    const during = await settleOnce(context, service);
    const firedAt = await awaitAlert(monitoring, "Rail402ExplorerLag", started);
    // The runbook's first step: the indexer's failures, and the discovery source asked directly.
    const metrics = await explorer.metrics.registry.getSingleMetricAsString(
      "rail402_explorer_failures_total",
    );
    const failures = /code="lumeus_unavailable"\} (\d+)/.exec(metrics)?.[1] ?? "0";
    const direct = await fetch(discovery.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
    });
    const health = await explorer.health();
    const stalled = explorer.lastLedger() === frozenAt;
    const missing = during.success && !(await explorer.indexed(during.transaction));
    const clearedAt = now();
    discovery.failRequests(undefined);
    // Nothing to restart: the indexer resumes every route from its checkpoint by itself.
    const caughtUp =
      during.success && (await reached(() => explorer.indexed(during.transaction), Boolean, 90_000));
    const moved = await reached(
      () => Promise.resolve(explorer.lastLedger()),
      (ledger) => ledger !== null && frozenAt !== null && ledger > frozenAt,
      30_000,
    );
    const counts = await explorer.ledgerCounts();
    const stopped = explorer.stopped();
    return drillCase("degraded-indexing-explorer", started, {
      method: "the Explorer indexer's discovery source answers every request with HTTP 503",
      injectedAt,
      clearedAt,
      firedAt,
      source: "alertmanager",
      steps: [
        `read the indexer's failures: rail402_explorer_failures_total{code="lumeus_unavailable"} ${failures}; /health ${String(health.status)} (${health.body.status ?? "unknown"})`,
        `asked the discovery source directly: HTTP ${String(direct.status)}`,
        "restored the discovery source; the indexer resumed from every route's checkpoint without a restart",
      ],
      completedAt: now(),
      checks: [
        check("a payment settled before the fault was indexed", indexedFirst),
        check("the walked-through ledger did not move while discovery failed", stalled),
        check("a payment settled during the fault was not indexed while discovery failed", missing),
        check("the indexer kept running through the fault", stopped === undefined),
        check("the walked-through ledger moved again after discovery returned", moved),
        check("the payment settled during the fault was indexed after recovery", caughtUp),
        check("no candidate ledger failed", (counts["failed"] ?? 0) === 0),
      ],
      failedRequests: 0,
      refusedCodes: [],
      transactions: [
        { hash: first.transaction, role: "settlement indexed before the fault" },
        ...(during.success ? [{ hash: during.transaction, role: "settlement indexed after recovery" }] : []),
      ],
      notes: [
        `The indexer runs in the drill process with the Explorer's own ingester, store, metrics and health server, polling every second; discovery, which Lumeus Activity answers on public networks, reads the private network's RPC (getTransactions), and the rules' stall window is ${DRILL_EXPLORER_STALL} instead of ${THRESHOLDS.explorerStall}.`,
        "Settlements stay unaffected: the Explorer reads the ledger, never the service.",
      ],
    });
  } finally {
    monitoring.watchExplorer(undefined);
    await explorer.stop();
    await discovery.close();
    await service.stop();
    await dropSchema(service.schema);
  }
}

async function signerRotation(
  context: Context,
  proxy: RpcProxy,
  service: Service,
  monitoring: Monitoring,
): Promise<DrillCase> {
  const started = Date.now();
  const before = await settleOnce(context, service);
  const injectedAt = now();
  await service.stop();
  // The leak response on the old sponsor, in the documented order: lock out, sweep, rotate. The
  // sponsor first gets its cold signer the offline way (unsigned setup, signed by the key tool).
  const leaked = service.sponsor;
  const cold = Keypair.random();
  await context.net.fund(cold);
  const sequence = async (id: string) => ({
    id,
    sequence: (await context.net.server.getAccount(id)).sequenceNumber(),
  });
  const setup = buildSignerSetup(await sequence(leaked.publicKey()), cold.publicKey(), "testnet");
  const offline = signEnvelope(setup.toXDR(), "stellar:testnet", leaked.secret());
  const setupResult = await context.net.submit(new Transaction(offline.signed, context.net.passphrase));
  // The freeze is prepared first; then whoever holds the leaked seed bumps the sponsor's sequence. The
  // freeze still applies: its source and fee payer is the cold account, not the sponsor.
  const freeze = buildFreeze(await sequence(cold.publicKey()), leaked.publicKey(), "testnet");
  freeze.sign(cold);
  const leakedAccount = await context.net.server.getAccount(leaked.publicKey());
  const bumpTo = (BigInt(leakedAccount.sequenceNumber()) + 1_000_000n).toString();
  const bump = new TransactionBuilder(leakedAccount, {
    fee: BASE_FEE,
    networkPassphrase: context.net.passphrase,
  })
    .addOperation(Operation.bumpSequence({ bumpTo }))
    .setTimeout(60)
    .build();
  bump.sign(leaked);
  const bumpResult = await context.net.submit(bump);
  const bumped = (await context.net.server.getAccount(leaked.publicKey())).sequenceNumber() === bumpTo;
  const freezeResult = await context.net.submit(freeze);
  const frozen = await context.net.server.getAccountEntry(leaked.publicKey());
  const sweep = buildSweep(await sequence(cold.publicKey()), leaked.publicKey(), "100", "testnet");
  sweep.sign(cold);
  const sweepResult = await context.net.submit(sweep);
  const leakedPayment = new TransactionBuilder(await context.net.server.getAccount(leaked.publicKey()), {
    fee: BASE_FEE,
    networkPassphrase: context.net.passphrase,
  })
    .addOperation(Operation.payment({ destination: cold.publicKey(), asset: Asset.native(), amount: "1" }))
    .setTimeout(60)
    .build();
  leakedPayment.sign(leaked);
  const leakedRefusal = await context.net.submit(leakedPayment).then(
    () => "it applied",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  const fresh = Keypair.random();
  await context.net.fund(fresh);
  const rotated = await startService(
    context.net,
    context.usdc,
    proxy.url,
    {},
    { sponsor: fresh, schema: service.schema, port: service.port },
  );
  monitoring.retarget(rotated.port);
  const clearedAt = now();
  // /health is refreshed by the service's poll, so the new sponsor appears there shortly after /ready.
  const named = await reached(
    async () =>
      (await (await fetch(`${rotated.url}/health`)).json()) as {
        networks?: Record<string, { sponsor?: { address?: string } }>;
      },
    (health) => health.networks?.[NETWORK]?.sponsor?.address === fresh.publicKey(),
    30_000,
  );
  const after = await settleOnce(context, rotated);
  // The settlement itself, read back from the network: the new sponsor paid its fee.
  const feeSource = after.success
    ? (await onChainSettlement(context.net.server, context.net.passphrase, after.transaction)).feeSource
    : undefined;
  const oldFeeSource = before.success
    ? (await onChainSettlement(context.net.server, context.net.passphrase, before.transaction)).feeSource
    : undefined;
  await rotated.stop();
  return drillCase("signer-rotation", started, {
    method:
      "a leaked sponsor seed: the cold key locked the old key out and swept, then the service restarted with a new, funded sponsor seed on the same database",
    injectedAt,
    clearedAt,
    firedAt: null,
    source: "manual",
    steps: [
      "added the cold signer to the old sponsor (unsigned setup signed offline by deploy/stellar-keys.ts)",
      "prepared the cold key's freeze, then bumped the old sponsor's sequence with the leaked key (as an attacker would)",
      "locked the old key out with the cold key (deploy/keys/cli.ts freeze: master weight 0, from the cold account)",
      "swept 100 XLM to the treasury in a second cold-signed transaction (deploy/keys/cli.ts sweep)",
      "funded the new sponsor",
      "replaced the sponsor secret and restarted",
      "read /health and settled one payment",
    ],
    completedAt: now(),
    checks: [
      check(
        "the payment before the rotation was fee-bumped by the old sponsor",
        oldFeeSource === service.sponsor.publicKey(),
      ),
      check("the leaked key bumped the old sponsor's sequence before the freeze", bumped),
      check("the cold key's freeze applied: the old key's weight is 0", frozen.thresholds()[0] === 0),
      check(
        `the leaked key alone can no longer pay (${leakedRefusal})`,
        /txBadAuth|tx_bad_auth/i.test(leakedRefusal),
      ),
      check("/health names the new sponsor", named),
      check("the payment after the rotation settled", after.success),
      check(
        "the payment after the rotation was fee-bumped by the new sponsor",
        feeSource === fresh.publicKey(),
      ),
    ],
    failedRequests: 0,
    refusedCodes: [],
    transactions: [
      ...(before.success ? [{ hash: before.transaction, role: "settlement with the old sponsor" }] : []),
      { hash: setupResult.txHash, role: "cold signer added to the old sponsor, signed offline" },
      { hash: bumpResult.txHash, role: "sequence bump by the leaked key" },
      { hash: freezeResult.txHash, role: "freeze by the cold key" },
      { hash: sweepResult.txHash, role: "sweep by the cold key" },
      ...(after.success ? [{ hash: after.transaction, role: "settlement with the new sponsor" }] : []),
    ],
    notes: [
      "The old channel accounts were not retired in this drill; the upto authority switch is not part of a local run (upto off).",
    ],
  });
}

// --- main ----------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { only: { type: "string" }, write: { type: "boolean", default: false } },
  });
  const selected = new Set(values.only?.split(",") ?? DRILLS.map((entry) => entry.exercise));
  const runStarted = now();
  const net = new LocalNetwork();
  if (!(await net.available()))
    throw new Error("the local Stellar network is not running: docker compose --profile stellar up -d");
  const usdc = await net.issueAsset("USDC");
  const funder = Keypair.random();
  await net.fund(funder);
  const [seller] = (await net.holders(usdc, 1, "0")) as [Keypair];
  const context: Context = { net, usdc, seller, funder };
  const proxy = await startRpcProxy(net.rpcUrl);
  const service = await startService(net, usdc, proxy.url, {});
  const monitoring = await startMonitoring(service.port);
  const cases: DrillCase[] = [];
  const run = async (exercise: Exercise, drill: () => Promise<DrillCase>) => {
    if (!selected.has(exercise)) return;
    log(`drill ${exercise}`);
    try {
      cases.push(await drill());
    } catch (error) {
      cases.push({
        id: exercise,
        title: definition(exercise).title,
        status: "failed",
        elapsedMs: 0,
        error: error instanceof Error ? error.message : String(error),
      });
      log(`${exercise} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    }
    log(`${exercise}: ${cases.at(-1)?.status ?? "?"}`);
  };
  try {
    await run("rpc-failure", () => rpcFailure(context, proxy, service, monitoring));
    await run("sequence-conflict", () => sequenceConflict(context, proxy, service, monitoring));
    await run("expired-authorization", () => expiredAuthorization(context, service));
    await run("signer-rotation", () => signerRotation(context, proxy, service, monitoring));
    await run("channel-exhaustion", () => channelExhaustion(context, proxy, monitoring));
    await run("sponsor-depletion", () => sponsorDepletion(context, proxy, monitoring));
    await run("degraded-indexing-bazaar", () => degradedIndexing(context, proxy, monitoring));
    await run("degraded-indexing-explorer", () => degradedExplorer(context, proxy, monitoring));
    await run("rpc-failover", () => rpcFailover(context, proxy, monitoring));
  } finally {
    monitoring.stop();
    await service.stop().catch(() => undefined);
    await proxy.close().catch(() => undefined);
    await dropSchema(service.schema).catch(() => undefined);
  }
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();
  const result: DrillRun = {
    schemaVersion: 1,
    kind: "drill",
    environment: "local",
    network: NETWORK,
    startedAt: runStarted,
    finishedAt: now(),
    // The commit alone: a run written from another branch (with that branch allowed) names no branch.
    harness: { commit },
    command: "node --conditions=@rail402/source tools/conformance/src/drills-local.ts --write",
    stack: {
      ...monitoring.versions,
      service: "Rail402 service in process, Postgres, the private Stellar network behind a fault proxy",
      explorer:
        "the Explorer indexer in the drill process, on its own database, with discovery read from the network's RPC",
      rules: `deploy/monitoring/alerts.ts with every for: 0s and the Explorer stall window ${DRILL_EXPLORER_STALL}, evaluated every 2 s`,
      sponsorFloorStroops: DRILL_SPONSOR_FLOOR,
    },
    summary: summarize(cases),
    cases,
  };
  await stopServiceProcesses();
  if (values.write) {
    process.stdout.write(`${writeDrillRun(result, branch === "main" ? {} : { allowBranch: branch })}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  });
}
