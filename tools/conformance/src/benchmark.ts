/**
 * Facilitator benchmark on the public Stellar testnet: verify latency, settle-to-confirmed latency,
 * ledgers to confirmation, sponsor cost per settlement, and concurrent settlement. Every facilitator
 * named with --facilitator runs the same workload from the same client in the same window, so
 * Rail402 can be compared with any other x402 facilitator that serves stellar:testnet.
 *
 *   node tools/conformance/src/benchmark.ts \
 *     --facilitator https://… [--facilitator https://x402.org/facilitator] \
 *     [--samples 50] [--batches 3] [--batch-size 20] [--write [--allow-branch <branch>]]
 *
 * Latency is measured by the client around each HTTP call, so it includes the network path to the
 * facilitator; the round trip of GET /supported is recorded beside it as that path's baseline.
 * Payloads are built before each timed call, as a buyer's client would, and are never reused.
 * Concurrent batches run against the first facilitator only. Fresh accounts are created for each
 * run, so the script needs no secrets. With --write the run is recorded as schemaVersion 2 evidence
 * (tools/conformance/evidence/benchmark-stellar-testnet.json).
 */
import { parseArgs } from "node:util";
import { FeeBumpTransaction, Keypair, TransactionBuilder, rpc } from "@stellar/stellar-sdk";
import {
  LocalNetwork,
  deploySimpleAccount,
  requirementsFor,
  smartAccountPayment,
  type PaymentRequirementsLike,
} from "@rail402.dev/testkit";
import {
  NETWORK,
  TESTNET_FRIENDBOT_URL,
  TESTNET_RPC_URL,
  Treasury,
  USDC_TESTNET_ADDRESS,
  gitCommit,
  log,
  usdcPayment,
  versions,
} from "./testnet.ts";
import {
  evidenceFileName,
  harnessProvenance,
  recheckProvenance,
  writeEvidence,
  type EvidenceCase,
} from "./evidence.ts";
import { buildEvidence, jsonSafe, readTarget } from "./harness.ts";

const { values: args } = parseArgs({
  options: {
    facilitator: { type: "string", multiple: true, default: ["http://localhost:8080"] },
    samples: { type: "string", default: "50" },
    "smart-account-samples": { type: "string", default: "10" },
    batches: { type: "string", default: "3" },
    "batch-size": { type: "string", default: "20" },
    rpc: { type: "string", default: TESTNET_RPC_URL },
    friendbot: { type: "string", default: TESTNET_FRIENDBOT_URL },
    write: { type: "boolean", default: false },
    "allow-branch": { type: "string" },
  },
});

// Evidence is recorded only from a clean commit on main, checked before any testnet funds are spent.
const provenance = args.write ? harnessProvenance({ allowBranch: args["allow-branch"] }) : undefined;

const SAMPLES = Number(args.samples);
const SMART_ACCOUNT_SAMPLES = Number(args["smart-account-samples"]);
const BATCHES = Number(args.batches);
const BATCH_SIZE = Number(args["batch-size"]);
/** Every benchmark payment moves 100 base units (0.00001 USDC); the fee does not depend on it. */
const AMOUNT = 100n;
const net = new LocalNetwork(args.rpc, args.friendbot);

// ---------------------------------------------------------------------------------------------

interface Stats {
  n: number;
  p50: number;
  p95: number;
  mean: number;
  min: number;
  max: number;
}

/** Nearest-rank percentiles. */
function stats(values: number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p: number) => sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? Number.NaN;
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    n: sorted.length,
    p50: rank(50),
    p95: rank(95),
    mean: sorted.length === 0 ? Number.NaN : Math.round((sum / sorted.length) * 10) / 10,
    min: sorted[0] ?? Number.NaN,
    max: sorted.at(-1) ?? Number.NaN,
  };
}

interface Failure {
  phase: string;
  code: string;
  reason: string;
}

interface Settlement {
  ms: number;
  hash: string;
  /** Ledgers from the latest ledger when the request was sent to the ledger that included it. */
  ledgers: number;
  feeStroops: number;
  feePayer: string;
}

/** The fields of a verify or settle response the benchmark reads. */
interface FacilitatorBody {
  isValid?: boolean;
  invalidReason?: string;
  invalidMessage?: string;
  success?: boolean;
  errorReason?: string;
  errorMessage?: string;
  transaction?: string;
}

class Client {
  readonly url: string;
  readonly failures: Failure[] = [];

  constructor(url: string) {
    this.url = url.replace(/\/+$/, "");
  }

  async timed(path: string, body?: unknown) {
    const started = performance.now();
    const response = await fetch(`${this.url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = (await response.json()) as FacilitatorBody;
    return { ms: performance.now() - started, status: response.status, json };
  }

  async verify(phase: string, payload: unknown, requirements: PaymentRequirementsLike) {
    const result = await this.timed("/verify", {
      x402Version: 2,
      paymentPayload: payload,
      paymentRequirements: requirements,
    });
    if (result.json.isValid !== true) {
      this.failures.push({
        phase,
        code: result.json.invalidReason ?? `http_${String(result.status)}`,
        reason: result.json.invalidMessage ?? "",
      });
      return undefined;
    }
    return result.ms;
  }

  async settle(phase: string, payload: unknown, requirements: PaymentRequirementsLike) {
    const startLedger = await net.latestLedger();
    const result = await this.timed("/settle", {
      x402Version: 2,
      paymentPayload: payload,
      paymentRequirements: requirements,
    });
    if (result.json.success !== true) {
      this.failures.push({
        phase,
        code: result.json.errorReason ?? `http_${String(result.status)}`,
        reason: result.json.errorMessage ?? "",
      });
      return undefined;
    }
    const hash = result.json.transaction ?? "";
    const onChain = await net.server.pollTransaction(hash, { attempts: 30 });
    if (onChain.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      this.failures.push({ phase, code: `on_chain_${onChain.status}`, reason: hash });
      return undefined;
    }
    const envelope = TransactionBuilder.fromXDR(onChain.envelopeXdr.toXDR("base64"), net.passphrase);
    const settlement: Settlement = {
      ms: result.ms,
      hash,
      ledgers: onChain.ledger - startLedger,
      feeStroops: Number(onChain.resultXdr.feeCharged().toBigInt()),
      feePayer: envelope instanceof FeeBumpTransaction ? envelope.feeSource : envelope.source,
    };
    return settlement;
  }
}

const round = (value: number) => Math.round(value * 10) / 10;

function summarize(settlements: Settlement[]) {
  return {
    latencyMs: stats(settlements.map((settlement) => round(settlement.ms))),
    ledgersToConfirm: stats(settlements.map((settlement) => settlement.ledgers)),
    sponsorFeeStroops: stats(settlements.map((settlement) => settlement.feeStroops)),
    feePayers: [...new Set(settlements.map((settlement) => settlement.feePayer))],
    transactions: settlements.map((settlement) => settlement.hash),
  };
}

// ---------------------------------------------------------------------------------------------

async function benchmark(client: Client, treasury: Treasury, seller: Keypair, concurrent: boolean) {
  log(`${client.url}: network round trip`);
  const roundTrips: number[] = [];
  for (let i = 0; i < 20; i++) roundTrips.push(round((await client.timed("/supported")).ms));

  // Ten payers share the sequential samples; each payload carries its own nonce.
  const payers = await treasury.accounts(10, "0.1");
  const payerFor = (i: number) => payers[i % payers.length] as Keypair;

  log(`${client.url}: ${String(SAMPLES)} verifications`);
  const verifications: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const { payload, requirements } = await usdcPayment(net, payerFor(i), seller.publicKey(), AMOUNT);
    const ms = await client.verify("verify", payload, requirements);
    if (ms !== undefined) verifications.push(round(ms));
  }

  log(`${client.url}: ${String(SAMPLES)} sequential settlements (G… payers)`);
  const sequential: Settlement[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const { payload, requirements } = await usdcPayment(net, payerFor(i), seller.publicKey(), AMOUNT);
    const settled = await client.settle("settle", payload, requirements);
    if (settled !== undefined) sequential.push(settled);
  }

  log(`${client.url}: ${String(SMART_ACCOUNT_SAMPLES)} sequential settlements (C… payer)`);
  const owner = Keypair.random();
  const account = await deploySimpleAccount(net, treasury.keypair, owner);
  await treasury.transfer(account, AMOUNT * BigInt(SMART_ACCOUNT_SAMPLES));
  const smart: Settlement[] = [];
  for (let i = 0; i < SMART_ACCOUNT_SAMPLES; i++) {
    const requirements = requirementsFor(USDC_TESTNET_ADDRESS, seller.publicKey(), AMOUNT);
    const payload = await smartAccountPayment(net, {
      account,
      owner,
      source: treasury.keypair,
      requirements,
    });
    const settled = await client.settle("settle-smart-account", payload, requirements);
    if (settled !== undefined) smart.push(settled);
  }

  const batches: {
    wallMs: number;
    succeeded: number;
    uniqueTransactions: number;
    settlements: Settlement[];
  }[] = [];
  if (concurrent) {
    for (let batch = 0; batch < BATCHES; batch++) {
      log(
        `${client.url}: concurrent batch ${String(batch + 1)} of ${String(BATCHES)} (${String(BATCH_SIZE)} settlements)`,
      );
      const batchPayers = await treasury.accounts(BATCH_SIZE, "0.001");
      const payments = await Promise.all(
        batchPayers.map((payer) => usdcPayment(net, payer, seller.publicKey(), AMOUNT)),
      );
      const started = performance.now();
      const settled = await Promise.all(
        payments.map(({ payload, requirements }) =>
          client.settle("settle-concurrent", payload, requirements),
        ),
      );
      const wallMs = round(performance.now() - started);
      const succeeded = settled.filter((settlement) => settlement !== undefined);
      // Each payer paid once: its balance must have dropped by exactly one payment.
      const balances = await Promise.all(
        batchPayers.map((payer) => net.tokenBalance(USDC_TESTNET_ADDRESS, payer.publicKey())),
      );
      const doubleDebits = balances.filter((balance) => balance < 10_000n - AMOUNT).length;
      if (doubleDebits > 0)
        client.failures.push({
          phase: "settle-concurrent",
          code: "double_debit",
          reason: String(doubleDebits),
        });
      batches.push({
        wallMs,
        succeeded: succeeded.length,
        uniqueTransactions: new Set(succeeded.map((settlement) => settlement.hash)).size,
        settlements: succeeded,
      });
    }
  }

  return {
    facilitator: client.url,
    networkRoundTripMs: stats(roundTrips),
    verify: { latencyMs: stats(verifications) },
    settle: summarize(sequential),
    settleSmartAccount: summarize(smart),
    ...(concurrent
      ? {
          concurrent: {
            batches: batches.map(({ wallMs, succeeded, uniqueTransactions }) => ({
              size: BATCH_SIZE,
              wallMs,
              succeeded,
              uniqueTransactions,
            })),
            ...summarize(batches.flatMap((batch) => batch.settlements)),
          },
        }
      : {}),
    failures: client.failures,
  };
}

/** A lower-case case id for one facilitator, from its host and path. */
function facilitatorCaseId(url: string, index: number): string {
  const { host, pathname } = new URL(url);
  const slug = `${host}${pathname}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `facilitator-${String(index + 1)}-${slug}`;
}

async function main() {
  const facilitators = args.facilitator.map((url) => new Client(url));
  // The first facilitator is the one under test; the others are measured beside it.
  const target = await readTarget(facilitators[0]?.url ?? "");
  const deployed: Record<string, unknown> = {};
  for (const client of facilitators) {
    const health = await fetch(`${client.url}/health`).catch(() => undefined);
    const body = health?.ok === true ? ((await health.json()) as { version?: unknown }) : undefined;
    deployed[client.url] = typeof body?.version === "string" ? body.version : "not reported";
  }

  log("opening a treasury: Friendbot XLM, then USDC from the testnet XLM/USDC pool");
  const treasury = await new Treasury(net).open(String(5 + facilitators.length * 2));
  const [seller] = (await treasury.accounts(1, "0")) as [Keypair];

  const startedAt = new Date().toISOString();
  const cases: EvidenceCase[] = [];
  for (const [index, client] of facilitators.entries()) {
    const started = performance.now();
    const result = await benchmark(client, treasury, seller, index === 0);
    cases.push({
      id: facilitatorCaseId(client.url, index),
      title:
        index === 0
          ? `the benchmark workload against ${client.url}, the facilitator under test`
          : `the same workload against ${client.url}, in the same window`,
      // Measurements, not assertions: failures are counted in the result and shown on the page.
      checks: ["fees-sponsored"],
      status: "passed",
      elapsedMs: Math.round(performance.now() - started),
      observations: { version: deployed[client.url], result: jsonSafe(result) },
    });
  }

  const evidence = buildEvidence(
    {
      kind: "benchmark",
      // Without --write the document is printed only; its commit may then describe a dirty tree.
      provenance: provenance ?? { commit: gitCommit().replace(/-dirty$/, ""), dirty: false },
      network: NETWORK,
      target,
      packages: versions(["@x402/core", "@x402/stellar", "@stellar/stellar-sdk"]),
      command: `node tools/conformance/src/benchmark.ts ${facilitators.map((client) => `--facilitator ${client.url}`).join(" ")} --samples ${String(SAMPLES)} --smart-account-samples ${String(SMART_ACCOUNT_SAMPLES)} --batches ${String(BATCHES)} --batch-size ${String(BATCH_SIZE)}`,
      config: {
        asset: USDC_TESTNET_ADDRESS,
        amountBaseUnits: AMOUNT.toString(),
        samples: SAMPLES,
        smartAccountSamples: SMART_ACCOUNT_SAMPLES,
        batches: BATCHES,
        batchSize: BATCH_SIZE,
        latency: "client-measured wall time of each HTTP call, including the network path",
      },
      accounts: { seller: seller.publicKey() },
      startedAt,
    },
    cases,
  );
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  if (provenance !== undefined) {
    recheckProvenance(provenance, { allowBranch: args["allow-branch"] });
    const file = evidenceFileName("benchmark", NETWORK);
    log(`evidence written to ${writeEvidence(evidence, { allowBranch: args["allow-branch"], file })}`);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    log(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
