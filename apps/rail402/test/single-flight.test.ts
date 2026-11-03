import { describe, expect, it } from "vitest";
import { singleFlight } from "../src/single-flight.ts";

const never = () => new Promise<void>(() => undefined);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("one background run per key at a time", () => {
  it("skips a call while the key's run is under way, and runs it again once that one finished", async () => {
    let calls = 0;
    let finish: () => void = () => undefined;
    const run = singleFlight(
      () => {
        calls += 1;
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
      { deadlineMs: 60_000, onOverrun: () => undefined },
    );
    const first = run("testnet");
    await run("testnet");
    expect(calls).toBe(1);
    finish();
    await first;
    const second = run("testnet");
    expect(calls).toBe(2);
    finish();
    await second;
  });

  it("runs different keys side by side", async () => {
    const started: string[] = [];
    const run = singleFlight(
      (key: string) => {
        started.push(key);
        return never();
      },
      { deadlineMs: 60_000, onOverrun: () => undefined },
    );
    void run("testnet");
    void run("pubnet");
    await sleep(0);
    expect(started).toEqual(["testnet", "pubnet"]);
  });

  it("lets the next run start once one outlasted the deadline, and reports it", async () => {
    let calls = 0;
    const overruns: string[] = [];
    const run = singleFlight(
      () => {
        calls += 1;
        return never();
      },
      { deadlineMs: 20, onOverrun: (key: string) => overruns.push(key) },
    );
    await run("testnet");
    expect(overruns).toEqual(["testnet"]);
    void run("testnet");
    await sleep(0);
    expect(calls).toBe(2);
  });
});
