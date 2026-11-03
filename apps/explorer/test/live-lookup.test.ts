/** Live lookups of hashes not indexed yet: syntax first, a negative cache, and bounded budgets. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { afterAll, describe, expect, it } from "vitest";
import { ExplorerConfigError } from "../src/config.ts";
import { webConfig } from "../src/web/config.ts";
import { LiveLookup, TokenBuckets } from "../src/web/live-lookup.ts";
import { CONTEXT, TRANSACTIONS, fakeRpc, liveLookup } from "./web.ts";

const unknown = (n: number) => n.toString(16).padStart(64, "0");

describe("live lookup", () => {
  it("serves repeated unknown hashes from the negative cache", async () => {
    let now = 0;
    const { lookup, calls } = liveLookup({}, undefined, () => now);
    expect(await lookup.lookup(unknown(1), "a")).toEqual({ kind: "not_found", cached: false });
    for (let index = 0; index < 20; index++) {
      expect(await lookup.lookup(unknown(1), `client-${String(index)}`)).toEqual({
        kind: "not_found",
        cached: true,
      });
    }
    expect(calls).toHaveLength(1);
    now += 21_000;
    await lookup.lookup(unknown(1), "a");
    expect(calls).toHaveLength(2);
    // A malformed hash never reaches the RPC.
    expect(await lookup.lookup("not-a-hash", "a")).toEqual({ kind: "not_found", cached: false });
    expect(calls).toHaveLength(2);
  });

  it("enforces the per-client and global lookup budgets", async () => {
    let now = 0;
    const budget = { perClientPerMinute: 2, globalPerMinute: 3, negativeTtlMs: 1_000 };
    const { lookup, calls } = liveLookup({}, budget, () => now);
    await lookup.lookup(unknown(1), "a");
    await lookup.lookup(unknown(2), "a");
    await expect(lookup.lookup(unknown(3), "a")).rejects.toMatchObject({ code: "explorer_lookup_busy" });
    await lookup.lookup(unknown(4), "b");
    const error = await lookup.lookup(unknown(5), "c").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "explorer_lookup_busy" });
    expect((error as { details: { retryAfter: number } }).details.retryAfter).toBeGreaterThan(0);
    expect(calls).toHaveLength(3);
    now += 60_000;
    await lookup.lookup(unknown(6), "c");
    expect(calls).toHaveLength(4);
  });

  it("keeps a reserve for first lookups, refunds refused ones and groups IPv6 clients by /64", async () => {
    let now = 0;
    const budget = { perClientPerMinute: 3, globalPerMinute: 8, reservedShare: 0.25, negativeTtlMs: 1 };
    const { lookup, calls } = liveLookup({}, budget, () => now);
    // Two busy clients spend the shared part (6 of 8).
    for (const [index, client] of ["a", "a", "a", "b", "b", "b"].entries()) {
      now += 2;
      await lookup.lookup(unknown(100 + index), client);
    }
    // A newcomer still gets its first lookup from the reserve; its second is refused and refunded.
    now += 2;
    await lookup.lookup(unknown(200), "c");
    now += 2;
    await expect(lookup.lookup(unknown(201), "c")).rejects.toMatchObject({ code: "explorer_lookup_busy" });
    expect(calls).toHaveLength(7);
    // Addresses in one IPv6 /64 share one client budget.
    const v6 = liveLookup({}, { perClientPerMinute: 1, globalPerMinute: 100, negativeTtlMs: 1 }, () => now);
    await v6.lookup.lookup(unknown(300), "2001:db8:1:2::1");
    await expect(v6.lookup.lookup(unknown(301), "2001:db8:1:2::ffff")).rejects.toMatchObject({
      code: "explorer_lookup_busy",
    });
    await v6.lookup.lookup(unknown(302), "2001:db8:1:3::1");
  });

  it("answers a found, not yet indexed transaction from memory for a minute", async () => {
    let now = 0;
    const fixture = TRANSACTIONS["x402org-exact-1"];
    const budget = { perClientPerMinute: 1, globalPerMinute: 1, negativeTtlMs: 1 };
    const { lookup, calls } = liveLookup({ [fixture.hash]: fixture }, budget, () => now);
    await lookup.lookup(fixture.hash, "a");
    for (const client of ["a", "b", "c"]) {
      await expect(lookup.lookup(fixture.hash, client)).resolves.toMatchObject({ kind: "found" });
    }
    expect(calls).toHaveLength(1);
    now += 61_000;
    await lookup.lookup(fixture.hash, "d");
    expect(calls).toHaveLength(2);
  });

  it("shares one RPC call between concurrent lookups and classifies with the index's rules", async () => {
    const fixture = TRANSACTIONS["x402org-exact-1"];
    const { lookup, calls } = liveLookup({ [fixture.hash]: fixture });
    const [one, two] = await Promise.all([
      lookup.lookup(fixture.hash, "a"),
      lookup.lookup(fixture.hash, "b"),
    ]);
    expect(calls).toHaveLength(1);
    expect(one).toBe(two);
    expect(one).toMatchObject({
      kind: "found",
      result: {
        ledger: fixture.ledger,
        classification: { kind: "settlement", row: { txHash: fixture.hash } },
      },
    });
  });

  it("refuses an RPC answer whose events do not match the transaction's result", async () => {
    const fixture = TRANSACTIONS["x402org-exact-1"];
    const meta = xdr.TransactionMeta.fromXDR(fixture.metaXdr, "base64");
    for (const event of meta.v4().operations()[0]?.events() ?? []) {
      event
        .body()
        .v0()
        .data(nativeToScVal(1n, { type: "i128" }));
    }
    const forged = { ...fixture, metaXdr: meta.toXDR("base64") };
    const { lookup } = liveLookup({ [fixture.hash]: forged });
    const error = await lookup.lookup(fixture.hash, "a").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "explorer_lookup_unavailable" });
    expect((error as Error).message + JSON.stringify(error)).toMatch(/events do not match its result/);
  });

  it("refuses an RPC answer for another transaction than the hash asked for", async () => {
    const fixture = TRANSACTIONS["x402org-exact-1"];
    const asked = unknown(9);
    const { lookup } = liveLookup({ [asked]: fixture });
    const error = await lookup.lookup(asked, "a").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "explorer_lookup_unavailable" });
    expect(JSON.stringify(error) + (error as Error).message).toMatch(/another transaction/);
    // A fee bump is found by its inner hash too.
    const bumped = TRANSACTIONS["rail402-exact"];
    const outcome = await liveLookup({ [bumped.hash]: bumped }).lookup.lookup(bumped.hash, "a");
    expect(outcome).toMatchObject({ kind: "found" });
    const inner =
      outcome.kind === "found" && outcome.result.classification.kind === "settlement"
        ? outcome.result.classification.row.innerHash
        : null;
    expect(inner).toMatch(/^[0-9a-f]{64}$/);
    await expect(
      liveLookup({ [inner ?? ""]: bumped }).lookup.lookup(inner ?? "", "a"),
    ).resolves.toMatchObject({ kind: "found" });
  });

  it("refuses an RPC URL that is not https and bounds its client buckets", () => {
    for (const rpcUrl of ["http://rpc.example.org", "https://user:pw@rpc.example.org"]) {
      expect(() => new LiveLookup({ network: "stellar:testnet", rpcUrl, context: CONTEXT })).toThrow(/https/);
    }
    const buckets = new TokenBuckets(60, { maxKeys: 2 });
    expect(buckets.take("a")).toBe(0);
    expect(buckets.take("b")).toBe(0);
    buckets.sweep();
    expect(buckets.size).toBeLessThanOrEqual(2);
  });
});

describe("live lookup through Lumeus RPC", () => {
  const key = `lum_test_${"0".repeat(32)}`;
  const scratch = mkdtempSync(join(tmpdir(), "rail402-explorer-lookup-"));
  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("sends the key as a bearer token to the network's Lumeus RPC, and to no other host", async () => {
    const x402org = TRANSACTIONS["x402org-exact-1"];
    const rpc = fakeRpc({ [x402org.hash]: x402org });
    const seen: { url: string; authorization: string | null }[] = [];
    const lookup = new LiveLookup({
      network: "stellar:testnet",
      rpcUrl: "https://rpc-testnet.lumeus.dev",
      apiKey: key,
      context: CONTEXT,
      fetch: (url, init) => {
        seen.push({
          url: typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return rpc.fetch(url, init);
      },
    });
    expect(await lookup.lookup(x402org.hash, "a")).toMatchObject({ kind: "found" });
    expect(seen).toEqual([{ url: "https://rpc-testnet.lumeus.dev/", authorization: `Bearer ${key}` }]);
    for (const [rpcUrl, network] of [
      ["https://soroban-testnet.stellar.org", "stellar:testnet"],
      ["https://rpc.lumeus.dev", "stellar:testnet"],
      ["https://rpc.lumeus.dev", "stellar:pubnet"],
    ] as const) {
      expect(
        () => new LiveLookup({ network, rpcUrl, apiKey: key, context: { ...CONTEXT, network } }),
      ).toThrow();
    }
  });

  it("takes a publishable key apart from the indexer's, sent with the Explorer's origin", async () => {
    const publishable = `lum_pub_test_${"3".repeat(32)}`;
    const file = join(scratch, "publishable.key");
    writeFileSync(file, `${publishable}\n`, { mode: 0o600 });
    expect(
      webConfig({
        EXPLORER_DATABASE_URL: "postgres://reader@db/rail402_explorer",
        EXPLORER_NETWORKS: "testnet",
        EXPLORER_TESTNET_LUMEUS_KEY_FILE: file,
      }).networks[0],
    ).toMatchObject({ lookupRpcUrl: "https://rpc-testnet.lumeus.dev/", lookupApiKey: publishable });
    const x402org = TRANSACTIONS["x402org-exact-1"];
    const rpc = fakeRpc({ [x402org.hash]: x402org });
    const headers: Headers[] = [];
    const lookup = new LiveLookup({
      network: "stellar:testnet",
      rpcUrl: "https://rpc-testnet.lumeus.dev",
      apiKey: publishable,
      origin: "https://explorer.rail402.dev/",
      context: CONTEXT,
      fetch: (url, init) => {
        headers.push(new Headers(init?.headers));
        return rpc.fetch(url, init);
      },
    });
    expect(await lookup.lookup(x402org.hash, "a")).toMatchObject({ kind: "found" });
    expect(headers.map((entry) => [entry.get("authorization"), entry.get("origin")])).toEqual([
      [`Bearer ${publishable}`, "https://explorer.rail402.dev"],
    ]);
    // A publishable key works only from an allowed origin: without one it is refused at start.
    expect(
      () =>
        new LiveLookup({
          network: "stellar:testnet",
          rpcUrl: "https://rpc-testnet.lumeus.dev",
          apiKey: publishable,
          context: CONTEXT,
        }),
    ).toThrow(/origin/);
  });

  it("defaults to the network's Lumeus RPC when its key file is set, never with an inline key", () => {
    const file = join(scratch, "testnet.key");
    writeFileSync(file, `${key}\n`, { mode: 0o600 });
    const base = {
      EXPLORER_DATABASE_URL: "postgres://reader@db/rail402_explorer",
      EXPLORER_NETWORKS: "testnet",
    };
    expect(webConfig(base).networks[0]).toMatchObject({
      lookupRpcUrl: "https://soroban-testnet.stellar.org/",
      lookupApiKey: undefined,
    });
    expect(webConfig({ ...base, EXPLORER_TESTNET_LUMEUS_KEY_FILE: file }).networks[0]).toMatchObject({
      lookupRpcUrl: "https://rpc-testnet.lumeus.dev/",
      lookupApiKey: key,
    });
    // Another lookup RPC is allowed, and never gets the key.
    expect(
      webConfig({
        ...base,
        EXPLORER_TESTNET_LUMEUS_KEY_FILE: file,
        EXPLORER_TESTNET_LOOKUP_RPC_URL: "https://soroban-testnet.stellar.org",
      }).networks[0]?.lookupApiKey,
    ).toBeUndefined();
    expect(() => webConfig({ ...base, EXPLORER_TESTNET_LUMEUS_KEY: key })).toThrow(/is refused/);
    expect(() =>
      webConfig({
        ...base,
        EXPLORER_NETWORKS: "pubnet",
        EXPLORER_PUBNET_LUMEUS_KEY_FILE: file,
      }),
    ).toThrow(/belongs to stellar:testnet/);
    expect(() =>
      webConfig({
        ...base,
        EXPLORER_TESTNET_LUMEUS_KEY_FILE: file,
        EXPLORER_TESTNET_LOOKUP_RPC_URL: "https://rpc.lumeus.dev",
      }),
    ).toThrow(ExplorerConfigError);
  });
});
