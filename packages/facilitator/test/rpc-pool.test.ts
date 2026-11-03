import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { DEFAULT_RPC_TIMEOUT_MS, DEFAULT_TIMING, RpcPool, boundedRpcServer } from "@rail402.dev/facilitator";

const providers = [
  { alias: "paid", url: "https://paid.example/rpc/KEY" },
  { alias: "free", url: "https://free.example/rpc" },
  { alias: "spare", url: "https://spare.example/rpc" },
];
const readings = (paid: boolean, free: boolean, spare = true) =>
  new Map([
    ["paid", paid],
    ["free", free],
    ["spare", spare],
  ]);

describe("RpcPool", () => {
  it("moves to the next provider on quota errors and reports it", () => {
    const switches: string[] = [];
    const pool = new RpcPool(providers, { onSwitch: (from, to) => switches.push(`${from}->${to}`) });
    expect(pool.active.alias).toBe("paid");
    // One failed reading is not enough.
    expect(pool.observe(readings(false, true))).toBeUndefined();
    expect(pool.observe(readings(false, true))).toBe("free");
    expect(pool.active.alias).toBe("free");
    expect(switches).toEqual(["paid->free"]);
  });

  it("moves back to the primary after five healthy readings", () => {
    const pool = new RpcPool(providers);
    pool.observe(readings(false, true));
    pool.observe(readings(false, true));
    for (let round = 0; round < 4; round++) expect(pool.observe(readings(true, true))).toBeUndefined();
    expect(pool.observe(readings(true, true))).toBe("paid");
  });

  it("stays on the active provider when no other is healthy", () => {
    const pool = new RpcPool(providers);
    for (let round = 0; round < 5; round++) pool.observe(readings(false, false, false));
    expect(pool.active.alias).toBe("paid");
  });

  it("pins a settlement to the provider active when it was claimed", () => {
    const pool = new RpcPool(providers);
    const pinned = pool.pin();
    pool.observe(readings(false, true));
    pool.observe(readings(false, true));
    expect(pinned.alias).toBe("paid");
    expect(pinned.server).toBe(pool.servers.get("paid"));
    expect(pool.pin().alias).toBe("free");
    // The shared client follows the active provider.
    expect(pool.server.serverURL.toString()).toBe(pool.servers.get("free")?.serverURL.toString());
  });

  it("refuses an empty list and repeated aliases", () => {
    expect(() => new RpcPool([])).toThrow(/at least one/);
    expect(
      () =>
        new RpcPool([
          providers[0] as { alias: string; url: string },
          { alias: "paid", url: "https://x.example" },
        ]),
    ).toThrow(/unique/);
  });
});

describe("RPC call timeouts", () => {
  it("bound every call of a pool's clients well below the claim TTL", () => {
    expect(DEFAULT_RPC_TIMEOUT_MS).toBeLessThan(DEFAULT_TIMING.claimTtlMs);
    const pool = new RpcPool(providers);
    for (const server of pool.servers.values()) {
      expect(server.httpClient.defaults.timeout).toBe(DEFAULT_RPC_TIMEOUT_MS);
    }
    const tight = new RpcPool(providers, { timeoutMs: 250 });
    expect(tight.servers.get("paid")?.httpClient.defaults.timeout).toBe(250);
    expect(() => boundedRpcServer("https://rpc.example", 0)).toThrow(/positive/);
  });

  it("fails a call to a provider that never answers", async () => {
    const hanging: Server = createServer(() => undefined);
    await new Promise<void>((resolve) => hanging.listen(0, "127.0.0.1", resolve));
    const { port } = hanging.address() as AddressInfo;
    try {
      const server = boundedRpcServer(`http://127.0.0.1:${String(port)}/rpc`, 100);
      const started = Date.now();
      await expect(server.getLatestLedger()).rejects.toThrow(/timeout/);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      hanging.closeAllConnections();
      await new Promise((resolve) => hanging.close(resolve));
    }
  });
});
