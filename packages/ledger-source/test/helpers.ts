import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { xdr } from "@stellar/stellar-sdk";
import { DATA_LAKE_BASE_URL, lakeObjectPath } from "../src/index.ts";

/** The committed testnet ledger slice (data lake objects, byte for byte). */
const LEDGERS = new URL("../../x402-index/test/fixtures/ledgers/testnet/", import.meta.url);
export const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
export const FOLDER = "testnet/2025-12-18";

export const lakeObject = (sequence: number): Buffer =>
  readFileSync(new URL(`${String(sequence)}.xdr.zst`, LEDGERS));

export const ledgerMeta = (sequence: number): xdr.LedgerCloseMeta => {
  const [meta] = xdr.LedgerCloseMetaBatch.fromXDR(zstdDecompressSync(lakeObject(sequence))).ledgerCloseMeta();
  if (meta === undefined) throw new Error("empty batch");
  return meta;
};

export const CONFIG = {
  networkPassphrase: TESTNET_PASSPHRASE,
  version: "1.0",
  compression: "zstd",
  ledgersPerBatch: 1,
  batchesPerPartition: 64000,
};

export interface FakeLake {
  readonly fetch: typeof fetch;
  readonly requests: string[];
}

/**
 * A fetch that serves the committed objects at their data lake URLs. `override` can answer any URL
 * differently (a status, a redirect, a body).
 */
export function fakeLake(
  held: readonly number[],
  override?: (url: string, attempt: number) => Response | undefined,
  config: object = CONFIG,
): FakeLake {
  const requests: string[] = [];
  const counts = new Map<string, number>();
  const base = `${DATA_LAKE_BASE_URL}${FOLDER}/`;
  const objects = new Map(held.map((sequence) => [`${base}${lakeObjectPath(sequence)}`, sequence]));
  const fetchFn = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();
    requests.push(`${init?.method ?? "GET"} ${url}`);
    const attempt = (counts.get(url) ?? 0) + 1;
    counts.set(url, attempt);
    const special = override?.(url, attempt);
    if (special !== undefined) return Promise.resolve(special);
    if (url === `${base}.config.json`) return Promise.resolve(new Response(JSON.stringify(config)));
    const sequence = objects.get(url);
    if (sequence === undefined) return Promise.resolve(new Response("missing", { status: 404 }));
    return Promise.resolve(
      new Response(init?.method === "HEAD" ? null : new Uint8Array(lakeObject(sequence))),
    );
  };
  return { fetch: fetchFn, requests };
}
