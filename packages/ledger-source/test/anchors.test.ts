import { describe, expect, it } from "vitest";
import { HorizonAnchors, LedgerSourceError } from "../src/index.ts";

const HASH = "ab".repeat(32);

const horizon = (answer: (path: string) => Response) => {
  const paths: string[] = [];
  const fetch: typeof globalThis.fetch = (url: string | URL | Request) => {
    const path = new URL(url instanceof Request ? url.url : url).pathname;
    paths.push(path);
    return Promise.resolve(answer(path));
  };
  return { fetch, paths };
};

describe("HorizonAnchors", () => {
  it("reads a ledger's hash and checks the answer names that ledger", async () => {
    const { fetch, paths } = horizon(() => Response.json({ sequence: 5_330_304, hash: HASH }));
    const anchors = new HorizonAnchors({ url: "https://horizon-testnet.stellar.org", fetch });
    await expect(anchors.ledgerHash(5_330_304)).resolves.toBe(HASH);
    expect(paths).toEqual(["/ledgers/5330304"]);
    await expect(anchors.ledgerHash(5_330_305)).rejects.toMatchObject({ code: "anchor_unavailable" });
  });

  it("reads many hashes in one /ledgers page per run of up to 200 ledgers", async () => {
    const urls: URL[] = [];
    const fetch: typeof globalThis.fetch = (url: string | URL | Request) => {
      const parsed = new URL(url instanceof Request ? url.url : url);
      urls.push(parsed);
      const start = Number(BigInt(parsed.searchParams.get("cursor") ?? "0") >> 32n) + 1;
      const limit = Number(parsed.searchParams.get("limit"));
      const records = Array.from({ length: limit }, (_, offset) => ({
        sequence: start + offset,
        hash: (start + offset).toString(16).padStart(64, "0"),
      }));
      return Promise.resolve(Response.json({ _embedded: { records } }));
    };
    const anchors = new HorizonAnchors({ url: "https://horizon-testnet.stellar.org", fetch });
    const hashes = await anchors.ledgerHashes([5_330_316, 5_330_305, 5_330_311, 5_400_000]);
    expect([...hashes.keys()].sort()).toEqual([5_330_305, 5_330_311, 5_330_316, 5_400_000]);
    expect(hashes.get(5_330_311)).toBe((5_330_311).toString(16).padStart(64, "0"));
    expect(urls.map((url) => [url.pathname, url.searchParams.get("limit")])).toEqual([
      ["/ledgers", "12"],
      ["/ledgers", "1"],
    ]);
    expect(urls[0]?.searchParams.get("cursor")).toBe(String(5_330_304n << 32n));

    const lying = new HorizonAnchors({
      url: "https://horizon.example",
      fetch: () => Promise.resolve(Response.json({ _embedded: { records: [{ sequence: 9, hash: HASH }] } })),
    });
    await expect(lying.ledgerHashes([5])).rejects.toMatchObject({ code: "anchor_unavailable" });
  });

  it("refuses a missing ledger, a malformed hash and an unsafe URL", async () => {
    const missing = new HorizonAnchors({
      url: "https://horizon.example",
      fetch: horizon(() => new Response("", { status: 404 })).fetch,
    });
    await expect(missing.ledgerHash(1)).rejects.toMatchObject({ code: "anchor_unavailable" });
    const malformed = new HorizonAnchors({
      url: "https://horizon.example",
      fetch: horizon(() => Response.json({ sequence: 1, hash: "XYZ" })).fetch,
    });
    await expect(malformed.ledgerHash(1)).rejects.toBeInstanceOf(LedgerSourceError);
    for (const url of ["http://horizon.example", "https://u:p@horizon.example", "https://h.example/?a=1"]) {
      expect(() => new HorizonAnchors({ url })).toThrow(/https/);
    }
  });
});
