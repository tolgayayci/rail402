/**
 * Test doubles for registry-scope indexing: discovery answered from the recorded Lumeus testnet pages
 * (packages/ledger-source/test/fixtures/lumeus), and an RPC that serves the committed fixture ledgers.
 */
import type {
  ActivityRecord,
  ActivityRoute,
  FetchedLedger,
  RpcRetention,
  WalkStep,
} from "@rail402.dev/ledger-source";
import { RECORDING } from "../../../packages/ledger-source/test/lumeus-fixture.ts";
import type { ActivitySource } from "../src/indexer/ingester.ts";
import type { RecentLedgers } from "../src/indexer/bytes.ts";
import { FixtureSource, fetched } from "./sources.ts";

/** Every record of the recording, by route address. */
export function recordedLedgers(): Map<string, ActivityRecord[]> {
  const byAddress = new Map<string, ActivityRecord[]>();
  for (const [key, body] of Object.entries(RECORDING.pages)) {
    const address = /^\/(?:accounts|contracts)\/([A-Z0-9]{56})\//.exec(key)?.[1];
    if (address === undefined) continue;
    const records = (body as { _embedded: { records: Record<string, unknown>[] } })._embedded.records;
    const list = byAddress.get(address) ?? [];
    for (const record of records) {
      list.push({
        id: String(record["id"]),
        kind: String(record["kind"]),
        type: String(record["type"]),
        ledger: Number(record["ledger"]),
        txHash: String(record["tx_hash"]),
      });
    }
    byAddress.set(address, list);
  }
  return byAddress;
}

/**
 * Discovery from a fixed set of records, in Lumeus' terms: a window ends at the published head, its
 * checkpoint is the last ledger it covered, and records outside it are never returned. `head` can move
 * to simulate new ledgers; `generation` can change to simulate a rebuilt index or a reset; `pageSize`
 * splits a window's records into pages handed over one by one; `failNext` makes the next walk throw,
 * and `failAfterPages` throws once after that many pages of one address.
 */
export class RecordedActivity implements ActivitySource {
  readonly calls: { readonly address: string; readonly from: number; readonly until: number | undefined }[] =
    [];
  head: number;
  generation = "testnet-2025-12-18-v3";
  decoderVersion = "activity-test";
  pageSize = Infinity;
  failNext: Error | undefined;
  failAfterPages: { address: string; pages: number; error: Error } | undefined;
  readonly #served = new Map<string, number>();
  readonly #records: Map<string, ActivityRecord[]>;

  constructor(records: Map<string, ActivityRecord[]> = recordedLedgers(), head = RECORDING.until - 1) {
    this.#records = records;
    this.head = head;
  }

  add(address: string, ledger: number, txHash = "ab".repeat(32)): void {
    const list = this.#records.get(address) ?? [];
    list.push({ id: `testnet:${String(ledger)}:x`, kind: "token_transfer", type: "fee", ledger, txHash });
    list.sort((a, b) => a.ledger - b.ledger);
    this.#records.set(address, list);
  }

  #page(address: string): void {
    const served = this.#served.get(address) ?? 0;
    const failure = this.failAfterPages;
    if (failure?.address === address && served >= failure.pages) {
      this.failAfterPages = undefined;
      throw failure.error;
    }
    this.#served.set(address, served + 1);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async *walkRange(
    route: ActivityRoute,
    from: number,
    until: number | undefined,
    options: { readonly windowLedgers: number },
  ): AsyncGenerator<WalkStep> {
    this.calls.push({ address: route.address, from, until });
    const failure = this.failNext;
    if (failure !== undefined) {
      this.failNext = undefined;
      throw failure;
    }
    const readView = {
      network: "testnet",
      generation: this.generation,
      decoderVersion: this.decoderVersion,
      snapshotLedger: this.head,
      publishedThrough: this.head,
    };
    let since = from;
    const last = until === undefined ? this.head + 1 : Math.min(until, this.head + 1);
    if (since >= last) {
      // Past the published tip: an empty, complete window that covers nothing new.
      this.#page(route.address);
      yield {
        route,
        since,
        until: since + options.windowLedgers,
        readView,
        records: [],
        scannedThrough: since - 1,
        complete: true,
      };
      return;
    }
    while (since < last) {
      const end = Math.min(last, since + options.windowLedgers);
      const records = (this.#records.get(route.address) ?? []).filter(
        (record) => record.ledger >= since && record.ledger < end,
      );
      let covered = since - 1;
      for (let offset = 0; offset < records.length || offset === 0; offset += this.pageSize) {
        const page = records.slice(offset, offset + this.pageSize);
        const complete = offset + this.pageSize >= records.length;
        const lastLedger = page.at(-1)?.ledger;
        const checkpoint = complete
          ? end - 1
          : lastLedger !== undefined && lastLedger - 1 > covered
            ? lastLedger - 1
            : null;
        this.#page(route.address);
        yield { route, since, until: end, readView, records: page, scannedThrough: checkpoint, complete };
        if (checkpoint !== null) covered = checkpoint;
        if (complete) break;
      }
      since = end;
    }
  }
}

/** RPC `getLedgers` over fixture ledgers, holding those from `oldest` on. */
export class FixtureRpc implements RecentLedgers {
  readonly asked: number[] = [];
  oldest: number;
  readonly #lake: FixtureSource;

  constructor(held: Iterable<number>, oldest: number) {
    this.#lake = new FixtureSource(held);
    this.oldest = oldest;
  }

  retention(): Promise<RpcRetention> {
    return Promise.resolve({ oldestLedger: this.oldest, latestLedger: Math.max(...this.#lake.held) });
  }

  async fetchLedgers(start: number, limit: number): Promise<FetchedLedger[]> {
    const out: FetchedLedger[] = [];
    for (let sequence = start; sequence < start + limit; sequence++) {
      this.asked.push(sequence);
      const ledger = await this.#lake.getLedger(sequence);
      if (ledger === undefined) break;
      const page = fetched({ ...ledger, source: "rpc", uri: "fixture-rpc#getLedgers" });
      if (page !== undefined) out.push(page);
    }
    return out;
  }
}
