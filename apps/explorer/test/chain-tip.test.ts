import { describe, expect, it } from "vitest";
import { ChainTip } from "../src/web/chain-tip.ts";

const answering = (sequence: unknown, calls: { count: number }, ok = true) =>
  (() => {
    calls.count++;
    return Promise.resolve(
      new Response(JSON.stringify({ result: { sequence } }), { status: ok ? 200 : 500 }),
    );
  }) as typeof fetch;

describe("the chain's newest ledger", () => {
  it("shares one read between viewers for a few seconds, then reads again", async () => {
    const calls = { count: 0 };
    let now = 0;
    const tip = new ChainTip("https://rpc.example", { fetch: answering(100, calls), now: () => now });
    const reads = await Promise.all([tip.latest(), tip.latest(), tip.latest()]);
    expect(reads).toEqual([100, 100, 100]);
    expect(await tip.latest()).toBe(100);
    expect(calls.count).toBe(1);
    now += 5_000;
    await tip.latest();
    expect(calls.count).toBe(2);
  });

  it.each([
    ["an error status", answering(100, { count: 0 }, false)],
    ["an answer without a ledger", answering("100", { count: 0 })],
    ["a network failure", () => Promise.reject(new Error("down"))],
  ])("gives no ledger on %s", async (_name, fetchImpl) => {
    expect(await new ChainTip("https://rpc.example", { fetch: fetchImpl }).latest()).toBeUndefined();
  });

  it("does not keep showing a ledger once reads fail", async () => {
    let up = true;
    let now = 0;
    const tip = new ChainTip("https://rpc.example", {
      fetch: () =>
        up
          ? Promise.resolve(new Response(JSON.stringify({ result: { sequence: 7 } })))
          : Promise.reject(new Error("down")),
      now: () => now,
    });
    expect(await tip.latest()).toBe(7);
    up = false;
    now += 5_000;
    expect(await tip.latest()).toBeUndefined();
  });
});
