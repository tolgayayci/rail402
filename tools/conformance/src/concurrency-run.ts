/**
 * Concurrent settlement batches against one or two running Rail402 replicas, over HTTP. Each batch
 * signs `size` payments from fresh payers and settles them at once; `duplicates` of them are sent a
 * second time in the same instant, to the other replica when there are two. Every outcome is proved
 * on chain and from the replicas' own `/metrics`.
 *
 * A batch passes when every payment settled once, in its own transaction, moving the amount from its
 * payer to `payTo`; each duplicate got the original's response and moved nothing; every payer was
 * debited exactly once; and the replicas counted no sequence conflict (txBadSeq). Across the run, no two
 * transactions share a (channel, sequence) pair. Used by `concurrency.ts` (public testnet) and by the
 * integration test against the local network.
 *
 * Payments are `exact`, `upto` (authorizing twice the amount and settling the amount) or a mix of
 * the two in every batch, so both schemes share the channel pool at once.
 */
import type { Keypair } from "@stellar/stellar-sdk";
import { createEd25519Signer } from "@x402/stellar";
import { UptoStellarScheme as UptoStellarClient } from "@rail402.dev/upto/client";
import { onChainSettlement, requirementsFor, type LocalNetwork } from "@rail402.dev/testkit";
import type { Evidence, EvidenceCase, EvidenceTransaction, Provenance } from "./evidence.ts";
import { buildEvidence, modeOf } from "./harness.ts";

export interface ConcurrencyAsset {
  readonly contract: string;
  readonly symbol: string;
  readonly decimals: number;
}

export type ConcurrencyScheme = "exact" | "upto" | "mixed";

/** What an `upto` payer needs: the settlement authority `/supported` advertises, and the contract. */
export interface UptoTerms {
  readonly authority: string;
  /** The settlement contract; the network's canonical deployment when omitted. */
  readonly contract?: string;
  /** Seconds per ledger the client assumes; estimated from Horizon when omitted. */
  readonly ledgerSeconds?: number;
}

export interface ConcurrencyOptions {
  /** `exact` (default), `upto`, or both alternating within every batch. */
  readonly scheme?: ConcurrencyScheme;
  /** Needed for `upto` and `mixed`. */
  readonly upto?: UptoTerms;
  /** One replica, or two: with two, every duplicate goes to the replica its original did not. */
  readonly facilitators: readonly string[];
  readonly net: LocalNetwork;
  readonly asset: ConcurrencyAsset;
  readonly payTo: string;
  /** Per payment, in base units. */
  readonly amount: bigint;
  readonly batches: number;
  readonly size: number;
  readonly duplicates: number;
  /** `count` fresh accounts, each holding exactly `startingBalance` base units of the asset. */
  payers(count: number): Promise<Keypair[]>;
  readonly startingBalance: bigint;
  /** Explorer URL of a transaction. */
  explorer(hash: string): string;
  readonly log?: (message: string) => void;
  /** How often `/metrics` is scraped during a batch for the peak channel use; 250 ms by default. */
  readonly scrapeIntervalMs?: number;
}

export interface ConcurrencyRun {
  readonly cases: EvidenceCase[];
  readonly startedAt: string;
  readonly finishedAt: string;
}

interface SettleAnswer {
  readonly status: number;
  readonly body: Record<string, unknown> & { success?: boolean; transaction?: string };
  readonly repeat: boolean;
}

/** Runs the batches and returns one evidence case per batch plus the run-wide sequence check. */
export async function runConcurrency(options: ConcurrencyOptions): Promise<ConcurrencyRun> {
  const { facilitators, net, asset, payTo, amount, size, duplicates } = options;
  const mix = options.scheme ?? "exact";
  if (facilitators.length < 1 || facilitators.length > 2) throw new Error("give one or two facilitator URLs");
  if (mix !== "exact" && options.upto === undefined) throw new Error(`${mix} needs the upto terms`);
  const schemeOf = (index: number): "exact" | "upto" =>
    mix === "mixed" ? (index % 2 === 0 ? "exact" : "upto") : mix;
  if (duplicates > size) throw new Error("duplicates must not exceed the batch size");
  const log = options.log ?? (() => undefined);
  const startedAt = new Date().toISOString();
  const cases: EvidenceCase[] = [];
  const pairs = new Map<string, string>();
  const collisions: string[] = [];

  for (let batch = 1; batch <= options.batches; batch++) {
    const id = `batch-${String(batch)}`;
    const started = performance.now();
    const problems: string[] = [];
    const transactions: EvidenceTransaction[] = [];
    let observations: Record<string, unknown> = {};
    try {
      const payers = await options.payers(size);
      const payments = await Promise.all(
        payers.map(async (payer, index) => {
          const scheme = schemeOf(index);
          if (scheme === "exact") {
            const requirements = requirementsFor(asset.contract, payTo, amount);
            return { scheme, payer, requirements, payload: await net.payment(payer, requirements) };
          }
          return {
            scheme,
            payer,
            ...(await uptoPayment(net, options.upto, payer, asset.contract, payTo, amount)),
          };
        }),
      );
      const before = await Promise.all(facilitators.map(scrape));
      const peak = watchChannels(facilitators, options.scrapeIntervalMs ?? 250);

      const wallStarted = performance.now();
      const [first = "", second = first] = facilitators;
      const requests = [
        ...payments.map((payment) => ({ payment, url: first })),
        ...payments.slice(0, duplicates).map((payment) => ({ payment, url: second })),
      ];
      const answers = await Promise.all(
        requests.map(({ payment, url }) => settle(url, payment.payload, payment.requirements)),
      );
      const wallMs = Math.round(performance.now() - wallStarted);
      const maxChannelsInUse = await peak.stop();
      const after = await Promise.all(facilitators.map(scrape));

      // Every payment settled; each duplicate answered the original's body, one of the two a repeat.
      const originals = answers.slice(0, size);
      for (const [index, answer] of originals.entries()) {
        if (answer.status !== 200 || answer.body.success !== true) {
          problems.push(`payment ${String(index)} did not settle: ${JSON.stringify(answer.body)}`);
        }
      }
      for (let index = 0; index < duplicates; index++) {
        const original = answers[index] as SettleAnswer;
        const duplicate = answers[size + index] as SettleAnswer;
        if (JSON.stringify(duplicate.body) !== JSON.stringify(original.body)) {
          problems.push(`duplicate ${String(index)} answered a different body`);
        }
        if (Number(original.repeat) + Number(duplicate.repeat) !== 1) {
          problems.push(`duplicate ${String(index)}: expected exactly one of the pair marked as a repeat`);
        }
      }
      const hashes = new Set(originals.map((answer) => answer.body.transaction ?? ""));
      if (hashes.size !== size)
        problems.push(`${String(hashes.size)} distinct transactions for ${String(size)}`);

      // On chain: one transfer of the amount per payment, each from its own (channel, sequence).
      for (const [index, answer] of originals.entries()) {
        const hash = answer.body.transaction ?? "";
        if (!/^[0-9a-f]{64}$/.test(hash)) continue;
        const payer = payments[index]?.payer.publicKey() ?? "";
        const onChain = await onChainSettlement(net.server, net.passphrase, hash);
        const pair = `${onChain.innerSource}:${onChain.innerSequence}`;
        const holder = pairs.get(pair);
        if (holder !== undefined && holder !== hash) collisions.push(`${pair}: ${holder} and ${hash}`);
        pairs.set(pair, hash);
        const transfers = onChain.transfers.map((transfer) => ({
          from: transfer.from,
          to: transfer.to,
          amount: transfer.amount.toString(),
        }));
        const expected = [{ from: payer, to: payTo, amount: amount.toString() }];
        if (JSON.stringify(transfers) !== JSON.stringify(expected)) {
          problems.push(`payment ${String(index)} moved ${JSON.stringify(transfers)}`);
        }
        if (onChain.transfers.some((transfer) => transfer.contract !== asset.contract)) {
          problems.push(`payment ${String(index)} moved another asset`);
        }
        transactions.push({
          hash,
          ledger: onChain.ledger,
          scheme: payments[index]?.scheme ?? "exact",
          asset: asset.contract,
          decimals: asset.decimals,
          amount: amount.toString(),
          payerType: "G",
          feeChargedStroops: onChain.feeChargedStroops.toString(),
          feeSource: onChain.feeSource,
          innerSource: onChain.innerSource,
          innerSequence: onChain.innerSequence,
          transfers,
          explorer: options.explorer(hash),
        });
      }

      // Each payer debited exactly once, duplicates included.
      const balances = await Promise.all(
        payers.map((payer) => net.tokenBalance(asset.contract, payer.publicKey())),
      );
      const debitedOnce = balances.filter((balance) => balance === options.startingBalance - amount).length;
      if (debitedOnce !== size)
        problems.push(`${String(size - debitedOnce)} payers not debited exactly once`);

      const delta = (name: string, labels: Record<string, string> = {}) =>
        after.reduce((sum, sample) => sum + total(sample, name, labels), 0) -
        before.reduce((sum, sample) => sum + total(sample, name, labels), 0);
      // A txBadSeq answer is a conflict on any number of replicas: no reconciler rebroadcasts a
      // settlement a request on any replica is still confirming. A full queue (TRY_AGAIN_LATER) only
      // delays a submission, so it is observed, not failed.
      const sequenceConflicts = delta("rail402_sequence_conflicts_total", { kind: "bad_seq" });
      const queueFull = delta("rail402_sequence_conflicts_total", { kind: "try_again_later" });
      if (sequenceConflicts !== 0)
        problems.push(`${String(sequenceConflicts)} sequence conflicts (txBadSeq)`);
      const settled = delta("rail402_settlements_total", { outcome: "success" });
      const repeats = delta("rail402_settlement_repeats_total");
      if (settled !== size)
        problems.push(`the replicas counted ${String(settled)} settlements for ${String(size)}`);
      if (repeats !== duplicates) problems.push(`the replicas counted ${String(repeats)} repeats`);

      observations = {
        scheme: mix,
        replicas: facilitators.length,
        size,
        duplicates,
        wallMs,
        settlementsCounted: settled,
        repeatsCounted: repeats,
        sequenceConflicts,
        queueFull,
        leaseWaitP95Seconds: histogramQuantile(before, after, "rail402_channel_lease_wait_seconds", 0.95),
        leaseTimeouts: delta("rail402_channel_lease_timeouts_total"),
        maxChannelsInUse,
      };
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
    const status = problems.length === 0 ? "passed" : "failed";
    log(
      `${status === "passed" ? "PASS" : "FAIL"} ${id}${problems.length > 0 ? `: ${problems.join("; ")}` : ""}`,
    );
    cases.push({
      id,
      title: `${String(size)} concurrent ${mix === "mixed" ? "exact and upto" : mix} settlements, ${String(duplicates)} sent twice${facilitators.length > 1 ? " across replicas" : ""}`,
      checks: ["concurrency", "idempotency", ...(mix === "exact" ? [] : ["scheme-upto" as const])],
      ...(mix === "mixed" ? {} : { scheme: mix }),
      asset: asset.symbol,
      payer: "G",
      payTo: "G",
      status,
      elapsedMs: Math.round(performance.now() - started),
      transactions,
      observations: { ...observations, ...(problems.length > 0 ? { problems } : {}) },
    });
  }

  cases.push({
    id: "distinct-sequences",
    title: "no two settlement transactions share a channel account and sequence number",
    checks: ["concurrency"],
    ...(mix === "mixed" ? {} : { scheme: mix }),
    status: collisions.length === 0 && pairs.size > 0 ? "passed" : "failed",
    elapsedMs: 0,
    observations: { transactions: pairs.size, collisions },
  });
  return { cases, startedAt, finishedAt: new Date().toISOString() };
}

/**
 * An `upto` payment of `amount`: the scheme's client authorizes twice the amount, and the settle
 * requirements charge `amount`.
 */
async function uptoPayment(
  net: LocalNetwork,
  terms: UptoTerms | undefined,
  payer: Keypair,
  asset: string,
  payTo: string,
  amount: bigint,
) {
  if (terms === undefined) throw new Error("no upto terms");
  const client = new UptoStellarClient(createEd25519Signer(payer.secret(), "stellar:testnet"), {
    latestLedger: () => net.latestLedger(),
    ...(terms.contract === undefined ? {} : { contracts: terms.contract }),
    ...(terms.ledgerSeconds === undefined ? {} : { ledgerSeconds: terms.ledgerSeconds }),
  });
  const published = {
    scheme: "upto",
    network: "stellar:testnet" as const,
    asset,
    payTo,
    amount: (amount * 2n).toString(),
    maxTimeoutSeconds: 60,
    extra: { areFeesSponsored: true, facilitatorAddress: terms.authority },
  };
  const created = await client.createPaymentPayload(2, published);
  return {
    requirements: { ...published, amount: amount.toString() },
    payload: {
      x402Version: 2,
      resource: { url: "https://seller.example/metered" },
      accepted: published,
      payload: created.payload,
    },
  };
}

export interface EvidenceContext {
  readonly provenance: Provenance;
  readonly network: "stellar:testnet" | "stellar:pubnet";
  readonly facilitators: readonly string[];
  readonly healthVersion: string;
  readonly supported: unknown;
  readonly packages: Record<string, string>;
  readonly command: string;
  readonly config: Record<string, string | number | boolean>;
  readonly accounts: Record<string, string>;
}

/** The run as a schemaVersion 2 `concurrency` evidence document. */
export function concurrencyEvidence(run: ConcurrencyRun, context: EvidenceContext): Evidence {
  const url = context.facilitators[0] ?? "";
  return buildEvidence(
    {
      kind: "concurrency",
      provenance: context.provenance,
      network: context.network,
      target: {
        mode: modeOf(url),
        facilitatorUrl: url,
        healthVersion: context.healthVersion,
        supported: context.supported,
      },
      packages: context.packages,
      command: context.command,
      config: { replicas: context.facilitators.length, ...context.config },
      accounts: context.accounts,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    },
    run.cases,
  );
}

// --- HTTP and metrics ---------------------------------------------------------------------------

async function settle(
  url: string,
  paymentPayload: unknown,
  paymentRequirements: unknown,
): Promise<SettleAnswer> {
  const response = await fetch(`${url}/settle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements }),
  });
  const body = (await response.json()) as SettleAnswer["body"];
  return { status: response.status, body, repeat: isRepeat(response.headers.get("extension-responses")) };
}

/** Whether an `EXTENSION-RESPONSES` header (base64 JSON) marks the settlement as a repeat. */
export function isRepeat(header: string | null): boolean {
  if (header === null || header === "") return false;
  try {
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
      rail402?: { settlement?: { repeat?: unknown } };
    };
    return decoded.rail402?.settlement?.repeat === true;
  } catch {
    return false;
  }
}

/** One Prometheus sample: metric name, labels and value. */
export interface Sample {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
}

async function scrape(url: string): Promise<Sample[]> {
  const response = await fetch(`${url}/metrics`);
  if (!response.ok) throw new Error(`${url}/metrics answered ${String(response.status)}`);
  return parseExposition(await response.text());
}

/** Parses the Prometheus text exposition format (samples only; comments and blank lines skipped). */
export function parseExposition(text: string): Sample[] {
  const samples: Sample[] = [];
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)/.exec(line);
    if (match === null) continue;
    const labels: Record<string, string> = {};
    for (const pair of (match[2] ?? "").matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) {
      labels[pair[1] ?? ""] = (pair[2] ?? "").replace(/\\(.)/g, "$1");
    }
    samples.push({ name: match[1] ?? "", labels, value: Number(match[3]) });
  }
  return samples;
}

/** Sum of the samples named `name` whose labels include `labels`. */
export function total(samples: readonly Sample[], name: string, labels: Record<string, string> = {}): number {
  return samples
    .filter(
      (sample) =>
        sample.name === name && Object.entries(labels).every(([key, value]) => sample.labels[key] === value),
    )
    .reduce((sum, sample) => sum + sample.value, 0);
}

/**
 * The `quantile` of a histogram's observations between two scrapes of every replica, as the upper
 * bound of the bucket it falls in; 0 when nothing was observed.
 */
export function histogramQuantile(
  before: readonly (readonly Sample[])[],
  after: readonly (readonly Sample[])[],
  name: string,
  quantile: number,
): number | "+Inf" {
  const buckets = new Map<string, number>();
  const add = (scrapes: readonly (readonly Sample[])[], sign: number) => {
    for (const sample of scrapes.flat()) {
      if (sample.name !== `${name}_bucket`) continue;
      const le = sample.labels["le"] ?? "";
      buckets.set(le, (buckets.get(le) ?? 0) + sign * sample.value);
    }
  };
  add(after, 1);
  add(before, -1);
  const sorted = [...buckets].sort(([a], [b]) => Number(a) - Number(b));
  const count = sorted.at(-1)?.[1] ?? 0;
  if (count <= 0) return 0;
  const bound = Number(sorted.find(([, cumulative]) => cumulative >= quantile * count)?.[0] ?? "+Inf");
  return Number.isFinite(bound) ? bound : "+Inf";
}

/** Polls every replica's `rail402_channels_in_use` until stopped; resolves the highest value seen. */
function watchChannels(urls: readonly string[], intervalMs: number) {
  let max = 0;
  const state = { running: true };
  const loop = (async () => {
    while (state.running) {
      const samples = await Promise.all(urls.map((url) => scrape(url).catch(() => [])));
      for (const scraped of samples) max = Math.max(max, total(scraped, "rail402_channels_in_use"));
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  })();
  return {
    async stop(): Promise<number> {
      state.running = false;
      await loop;
      return max;
    },
  };
}
