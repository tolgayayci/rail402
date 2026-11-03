import { zstdCompressSync } from "node:zlib";
import { xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  DataLakeSource,
  LedgerSourceError,
  decodeLakeObject,
  gallop,
  lakeObjectPath,
  partitionStart,
  type LedgerSourceCode,
} from "../src/index.ts";
import { CONFIG, FOLDER, TESTNET_PASSPHRASE, fakeLake, lakeObject } from "./helpers.ts";

const SLICE = [5_330_305, 5_330_306, 5_330_307, 5_330_308, 5_330_309, 5_330_310, 5_330_311];
const noSleep = () => Promise.resolve();

const lake = (
  fake: ReturnType<typeof fakeLake>,
  extra: Partial<ConstructorParameters<typeof DataLakeSource>[0]> = {},
) =>
  new DataLakeSource({
    folder: FOLDER,
    passphrase: TESTNET_PASSPHRASE,
    fetch: fake.fetch,
    sleep: noSleep,
    ...extra,
  });

async function code(promise: Promise<unknown>): Promise<LedgerSourceCode | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    if (error instanceof LedgerSourceError) return error.code;
    throw error;
  }
}

describe("data lake paths", () => {
  it("computes the published object keys", () => {
    expect(lakeObjectPath(5_330_311)).toBe("FFAEF1FF--5312000-5375999/FFAEAA78--5330311.xdr.zst");
    expect(lakeObjectPath(63_999)).toBe("FFFFFFFF--0-63999/FFFF0600--63999.xdr.zst");
    expect(lakeObjectPath(61_440_000)).toBe("FC567FFF--61440000-61503999/FC567FFF--61440000.xdr.zst");
    expect(partitionStart(61_503_999)).toBe(61_440_000);
    expect(() => lakeObjectPath(0)).toThrow(LedgerSourceError);
    expect(() => lakeObjectPath(1.5)).toThrow(LedgerSourceError);
  });
});

describe("DataLakeSource", () => {
  it("reads a ledger, checking the folder's layout once", async () => {
    const fake = fakeLake(SLICE);
    const source = lake(fake);
    const first = await source.getLedger(5_330_311);
    await source.getLedger(5_330_310);
    expect(first?.sequence).toBe(5_330_311);
    expect(first?.meta.v2().ledgerHeader().header().ledgerSeq()).toBe(5_330_311);
    expect(first?.uri).toContain("FFAEAA78--5330311.xdr.zst");
    expect(fake.requests.filter((request) => request.endsWith(".config.json"))).toHaveLength(1);
  });

  it("treats a missing object as not written yet", async () => {
    await expect(lake(fakeLake(SLICE)).getLedger(5_330_312)).resolves.toBeUndefined();
  });

  it("refuses a folder whose layout or network differs", async () => {
    for (const config of [
      { ...CONFIG, networkPassphrase: "Public Global Stellar Network ; September 2015" },
      { ...CONFIG, ledgersPerBatch: 64 },
      { ...CONFIG, compression: "gzip" },
    ]) {
      expect(await code(lake(fakeLake(SLICE, undefined, config)).getLedger(5_330_311))).toBe(
        "lake_config_mismatch",
      );
    }
  });

  it("pins the host and refuses other folders", () => {
    expect(
      () =>
        new DataLakeSource({
          folder: FOLDER,
          passphrase: TESTNET_PASSPHRASE,
          baseUrl: "https://evil.example/",
        }),
    ).toThrow(LedgerSourceError);
    expect(
      () =>
        new DataLakeSource({
          folder: FOLDER,
          passphrase: TESTNET_PASSPHRASE,
          baseUrl: "http://aws-public-blockchain.s3.us-east-2.amazonaws.com/",
        }),
    ).toThrow(LedgerSourceError);
    expect(() => new DataLakeSource({ folder: "../secrets", passphrase: TESTNET_PASSPHRASE })).toThrow(
      LedgerSourceError,
    );
  });

  it("refuses redirects", async () => {
    const fake = fakeLake(SLICE, (url) =>
      url.endsWith(".xdr.zst")
        ? new Response(null, { status: 302, headers: { location: "https://evil.example/" } })
        : undefined,
    );
    expect(await code(lake(fake).getLedger(5_330_311))).toBe("http_redirect_refused");
  });

  it("caps the object size, declared or streamed", async () => {
    const big = new Uint8Array(2048);
    const declared = fakeLake(SLICE, (url) =>
      url.endsWith(".xdr.zst") ? new Response(big, { headers: { "content-length": "2048" } }) : undefined,
    );
    expect(await code(lake(declared, { maxObjectBytes: 1024 }).getLedger(5_330_311))).toBe(
      "object_too_large",
    );
    const streamed = fakeLake(SLICE, (url) =>
      url.endsWith(".xdr.zst")
        ? new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(big);
                controller.close();
              },
            }),
          )
        : undefined,
    );
    expect(await code(lake(streamed, { maxObjectBytes: 1024 }).getLedger(5_330_311))).toBe(
      "object_too_large",
    );
    expect(() => decodeLakeObject(lakeObject(5_330_311), 5_330_311, 1024)).toThrow(/decompresses beyond/);
  });

  it("retries transient failures and gives up on lasting ones", async () => {
    const flaky = fakeLake(SLICE, (url, attempt) =>
      url.endsWith(".xdr.zst") && attempt < 3 ? new Response("busy", { status: 503 }) : undefined,
    );
    await expect(lake(flaky).getLedger(5_330_311)).resolves.toMatchObject({ sequence: 5_330_311 });
    const down = fakeLake(SLICE, (url) =>
      url.endsWith(".xdr.zst") ? new Response("busy", { status: 503 }) : undefined,
    );
    const error = await lake(down, { attempts: 2 })
      .getLedger(5_330_311)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "http_status", retryable: true });
    const forbidden = fakeLake(SLICE, (url) =>
      url.endsWith(".xdr.zst") ? new Response("no", { status: 403 }) : undefined,
    );
    expect(
      await lake(forbidden)
        .getLedger(5_330_311)
        .catch((caught: unknown) => caught),
    ).toMatchObject({
      code: "http_status",
      retryable: false,
    });
  });

  it("refuses an object that holds another ledger or is not a ledger", async () => {
    const swapped = fakeLake(SLICE, (url) =>
      url.endsWith("--5330311.xdr.zst") ? new Response(new Uint8Array(lakeObject(5_330_310))) : undefined,
    );
    expect(await code(lake(swapped).getLedger(5_330_311))).toBe("ledger_mismatch");
    expect(() => decodeLakeObject(Buffer.from("not zstd"), 1)).toThrow(LedgerSourceError);
    const garbage = zstdCompressSync(Buffer.from([0, 0, 0, 9, 1, 2, 3]));
    expect(() => decodeLakeObject(garbage, 1)).toThrow(/not a LedgerCloseMetaBatch/);
    expect(xdr.LedgerCloseMetaBatch).toBeDefined();
  });

  it("finds the head of the lake by galloping and bisecting", async () => {
    const fake = fakeLake(SLICE);
    await expect(lake(fake).latestLedger(5_330_305)).resolves.toBe(5_330_311);
    expect(fake.requests.filter((request) => request.startsWith("HEAD")).length).toBeLessThanOrEqual(8);
    let calls = 0;
    await expect(
      gallop(100, (sequence) => {
        calls++;
        return Promise.resolve(sequence <= 1_000_000);
      }),
    ).resolves.toBe(1_000_000);
    expect(calls).toBeLessThan(60);
  });
});
