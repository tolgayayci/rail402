import { describe, it, expect } from "vitest";
import { createSignerLanes } from "./lane.js";

const tick = () => new Promise<void>(r => setTimeout(r, 1));

describe("createSignerLanes (F4 — per-signer settlement serialization)", () => {
  it("runs same-key work strictly one at a time, in arrival order", async () => {
    const lanes = createSignerLanes();
    const events: string[] = [];
    const job = (id: string) => async () => {
      events.push(`start ${id}`);
      await tick(); // a window in which an unserialized run would interleave
      events.push(`end ${id}`);
    };
    // Fire three on the SAME key concurrently.
    await Promise.all([lanes.run("A", job("1")), lanes.run("A", job("2")), lanes.run("A", job("3"))]);
    // Never a start between another job's start and end — no interleaving — and arrival order kept.
    expect(events).toEqual(["start 1", "end 1", "start 2", "end 2", "start 3", "end 3"]);
  });

  it("runs different keys fully in parallel", async () => {
    const lanes = createSignerLanes();
    const events: string[] = [];
    const job = (id: string) => async () => {
      events.push(`start ${id}`);
      await tick();
      events.push(`end ${id}`);
    };
    await Promise.all([lanes.run("A", job("A")), lanes.run("B", job("B"))]);
    // Both started before either ended: they overlapped.
    expect(events.slice(0, 2).sort()).toEqual(["start A", "start B"]);
  });

  it("releases the lane when a job throws, so the next job still runs", async () => {
    const lanes = createSignerLanes();
    const ran: string[] = [];
    const boom = lanes.run("A", async () => {
      ran.push("boom");
      throw new Error("settlement failed");
    });
    await expect(boom).rejects.toThrow("settlement failed");
    // The lane must not be wedged by the failure.
    await lanes.run("A", async () => {
      ran.push("after");
    });
    expect(ran).toEqual(["boom", "after"]);
  });

  it("returns the job's resolved value", async () => {
    const lanes = createSignerLanes();
    await expect(lanes.run("A", async () => 42)).resolves.toBe(42);
  });
});
