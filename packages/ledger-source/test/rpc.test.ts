import { describe, expect, it } from "vitest";
import { LedgerSourceError, Limiter, RpcLedgerSource } from "../src/index.ts";
import { ledgerMeta } from "./helpers.ts";
import { TEST_KEY } from "./lumeus-fixture.ts";

const HELD = [5_330_309, 5_330_310, 5_330_311];

/** A JSON-RPC endpoint holding the committed ledgers 5,330,309–5,330,311. */
function fakeRpc(options: { latest?: number; broken?: boolean; swapped?: boolean } = {}) {
  const latest = options.latest ?? 5_330_311;
  const calls: string[] = [];
  const requests: { url: string; authorization: string | null; limit: number | undefined }[] = [];
  const fetchFn = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(init?.body as string) as {
      id: number;
      method: string;
      params?: { startLedger: number; pagination: { limit: number } };
    };
    calls.push(body.method);
    requests.push({
      url: typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
      authorization: new Headers(init?.headers).get("authorization"),
      limit: body.params?.pagination.limit,
    });
    const reply = (result: unknown) =>
      Promise.resolve(new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result })));
    if (body.method === "getHealth")
      return reply({ status: "healthy", latestLedger: latest, oldestLedger: 5_330_309 });
    const start = body.params?.startLedger ?? 0;
    if (start > latest) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            error: {
              code: -32602,
              message: "startLedger must be between the oldest ledger and the latest ledger",
            },
          }),
        ),
      );
    }
    const ledgers = HELD.filter((sequence) => sequence >= start && sequence <= latest)
      .slice(0, body.params?.pagination.limit ?? 1)
      .map((sequence) => ({
        sequence: options.broken === true ? sequence + 1 : sequence,
        metadataXdr: ledgerMeta(options.swapped === true ? 5_330_311 : sequence).toXDR("base64"),
      }));
    return reply({ ledgers, latestLedger: latest, oldestLedger: 5_330_309 });
  };
  return { fetch: fetchFn, calls, requests };
}

describe("RpcLedgerSource", () => {
  it("reads ledgers through getLedgers", async () => {
    const rpc = new RpcLedgerSource({ url: "https://rpc.example", fetch: fakeRpc().fetch });
    const ledgers = await rpc.getLedgers(5_330_309, 10);
    expect(ledgers.map((ledger) => ledger.sequence)).toEqual(HELD);
    expect(ledgers[0]?.source).toBe("rpc");
    await expect(rpc.latestLedger()).resolves.toBe(5_330_311);
  });

  it("answers undefined beyond its head and refuses ledgers it pruned", async () => {
    const rpc = new RpcLedgerSource({ url: "https://rpc.example", fetch: fakeRpc().fetch });
    await expect(rpc.getLedger(5_330_312)).resolves.toBeUndefined();
    await expect(rpc.getLedger(5_000_000)).rejects.toMatchObject({ code: "rpc_error" });
  });

  it("refuses a response whose ledgers are not the ones asked for", async () => {
    const rpc = new RpcLedgerSource({ url: "https://rpc.example", fetch: fakeRpc({ broken: true }).fetch });
    await expect(rpc.getLedger(5_330_309)).rejects.toMatchObject({ code: "ledger_mismatch" });
  });

  it("requires https", () => {
    expect(() => new RpcLedgerSource({ url: "http://rpc.example" })).toThrow(LedgerSourceError);
  });

  it("refuses a ledger whose own header names another sequence than the one listed", async () => {
    const rpc = new RpcLedgerSource({ url: "https://rpc.example", fetch: fakeRpc({ swapped: true }).fetch });
    await expect(rpc.getLedger(5_330_309)).rejects.toMatchObject({ code: "ledger_mismatch" });
  });

  it("caps each getLedgers page and reports its retention window", async () => {
    const fake = fakeRpc();
    const rpc = new RpcLedgerSource({ url: "https://rpc.example", fetch: fake.fetch, pageLimit: 2 });
    expect((await rpc.getLedgers(5_330_309, 100)).map((ledger) => ledger.sequence)).toEqual([
      5_330_309, 5_330_310,
    ]);
    expect(fake.requests.find((request) => request.limit !== undefined)?.limit).toBe(2);
    await expect(rpc.retention()).resolves.toEqual({ oldestLedger: 5_330_309, latestLedger: 5_330_311 });
  });
});

describe("RpcLedgerSource with a Lumeus key", () => {
  it("sends the key as a bearer token to the Lumeus RPC host of its network, within the limiter", async () => {
    const fake = fakeRpc();
    const limiter = new Limiter(1);
    const rpc = new RpcLedgerSource({
      url: "https://rpc-testnet.lumeus.dev",
      network: "stellar:testnet",
      apiKey: TEST_KEY,
      fetch: fake.fetch,
      limiter,
    });
    await Promise.all([rpc.getLedger(5_330_309), rpc.getLedger(5_330_310), rpc.latestLedger()]);
    expect(fake.requests.length).toBeGreaterThanOrEqual(3);
    expect(fake.requests.every((request) => request.authorization === `Bearer ${TEST_KEY}`)).toBe(true);
    expect(fake.requests.every((request) => request.url.startsWith("https://rpc-testnet.lumeus.dev"))).toBe(
      true,
    );
  });

  it("waits for a short Retry-After and stops at once, retryable, on a long one", async () => {
    const fake = fakeRpc();
    const capped = (wait: number, times: number) => {
      let served = 0;
      return (url: string | URL | Request, init?: RequestInit): Promise<Response> =>
        served++ < times
          ? Promise.resolve(
              Response.json(
                {
                  jsonrpc: "2.0",
                  id: 1,
                  error: { code: -32000, message: "rate limited", data: "rate_limited" },
                },
                { status: 429, headers: { "retry-after": String(wait) } },
              ),
            )
          : fake.fetch(url, init);
    };
    const waits: number[] = [];
    const source = (fetchFn: typeof fetch) =>
      new RpcLedgerSource({
        url: "https://rpc-testnet.lumeus.dev",
        network: "stellar:testnet",
        apiKey: TEST_KEY,
        fetch: fetchFn,
        sleep: (ms) => (waits.push(ms), Promise.resolve()),
      });
    await expect(source(capped(2, 1)).getLedger(5_330_309)).resolves.toMatchObject({ sequence: 5_330_309 });
    expect(waits).toEqual([2_000]);
    // The daily testnet cap answers with a Retry-After until 00:00 UTC: no waiting, no hammering.
    waits.length = 0;
    const daily = capped(40_000, 10);
    const error = (await source(daily)
      .getLedger(5_330_309)
      .catch((caught: unknown) => caught)) as LedgerSourceError;
    expect(error).toBeInstanceOf(LedgerSourceError);
    expect(error).toMatchObject({ retryable: true, retryAfterSeconds: 40_000 });
    expect(waits).toEqual([]);
    expect(error.message).not.toContain(TEST_KEY);
  });

  it("sends no Authorization header without a key", async () => {
    const fake = fakeRpc();
    await new RpcLedgerSource({ url: "https://rpc.example", fetch: fake.fetch }).getLedger(5_330_309);
    expect(fake.requests.every((request) => request.authorization === null)).toBe(true);
  });

  it("refuses a key for any other host or network, without repeating it", () => {
    for (const [url, network] of [
      ["https://soroban-testnet.stellar.org", "stellar:testnet"],
      ["https://rpc.lumeus.dev", "stellar:testnet"],
      ["https://rpc.lumeus.dev", "stellar:pubnet"],
      ["https://rpc-testnet.lumeus.dev", undefined],
    ] as const) {
      let message = "";
      try {
        new RpcLedgerSource({ url, apiKey: TEST_KEY, ...(network === undefined ? {} : { network }) });
      } catch (error) {
        expect(error).toBeInstanceOf(LedgerSourceError);
        message = (error as Error).message;
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(TEST_KEY);
    }
  });
});
