import { afterEach, describe, expect, it, vi } from "vitest";
import { LatestLedger, silentLogger } from "@rail402.dev/facilitator";

function rpcAt(start: number) {
  const state = { ledger: start, calls: 0, fail: false };
  const server = {
    getHealth: () => {
      state.calls++;
      return state.fail
        ? Promise.reject(new Error("rpc down"))
        : Promise.resolve({ status: "healthy", latestLedger: state.ledger } as never);
    },
  };
  return { state, server };
}

describe("LatestLedger", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shares one reading between concurrent callers and reuses it while fresh", async () => {
    const { state, server } = rpcAt(100);
    const ledger = new LatestLedger(server);
    expect(await Promise.all([ledger.read(5_000), ledger.read(1_000)])).toEqual([100, 100]);
    expect(await ledger.read(1_000)).toBe(100);
    expect(state.calls).toBe(1);
  });

  it("answers within the caller's max age while refreshing, and waits beyond it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { state, server } = rpcAt(100);
    const ledger = new LatestLedger(server);
    await ledger.read(1_000);

    state.ledger = 101;
    vi.advanceTimersByTime(3_000);
    expect(await ledger.read(5_000)).toBe(100); // verify: the 3 s old reading, refreshed behind it
    expect(state.calls).toBe(2);
    expect(await ledger.read(5_000)).toBe(101);

    state.ledger = 102;
    vi.advanceTimersByTime(3_000);
    expect(await ledger.read(1_000)).toBe(102); // settle: too old for it, so it waits
    expect(state.calls).toBe(3);
  });

  it("keeps answering the last reading when a background refresh fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { state, server } = rpcAt(100);
    const warn = vi.fn();
    const ledger = new LatestLedger(server, { ...silentLogger, warn });
    await ledger.read(1_000);
    state.fail = true;
    vi.advanceTimersByTime(2_000);
    expect(await ledger.read(5_000)).toBe(100);
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledOnce();
    });
    await expect(ledger.read(1_000)).rejects.toThrow("rpc down");
  });
});
