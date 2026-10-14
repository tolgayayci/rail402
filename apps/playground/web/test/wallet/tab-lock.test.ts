import { describe, expect, it } from "vitest";
import { acquireTabLock, type LockRequester } from "../../src/wallet/tab-lock.ts";

/** A lock manager shared by "tabs" in one test: exclusive locks, `ifAvailable` honoured. */
function lockManager(): LockRequester {
  const held = new Set<string>();
  const queue = new Map<string, (() => void)[]>();
  const grant = async (name: string, callback: (lock: unknown) => Promise<void>) => {
    held.add(name);
    try {
      await callback({ name });
    } finally {
      held.delete(name);
      queue.get(name)?.shift()?.();
    }
  };
  return {
    request: (name, options, callback) => {
      if (!held.has(name)) return grant(name, callback);
      if (options.ifAvailable === true) return callback(null);
      return new Promise<void>((resolve) => {
        const waiting = queue.get(name) ?? [];
        waiting.push(() => {
          void grant(name, callback).then(resolve);
        });
        queue.set(name, waiting);
      });
    },
  };
}

describe("tab lock", () => {
  it("lets one tab hold the wallet; another waits until it lets go", async () => {
    const locks = lockManager();
    const first = await acquireTabLock({ locks });
    const second = await acquireTabLock({ locks });
    expect(first.held).toBe(true);
    expect(second.held).toBe(false);
    const waiting = second.wait();
    first.release();
    const later = await waiting;
    expect(later.held).toBe(true);
  });

  it("holds the lock alone when the browser has no Web Locks", async () => {
    const navigator = (globalThis as { navigator?: { locks?: unknown } }).navigator;
    const original = navigator?.locks;
    if (navigator !== undefined)
      Object.defineProperty(navigator, "locks", { value: null, configurable: true });
    try {
      const alone = await acquireTabLock({ name: "test" });
      expect(alone.held).toBe(true);
      expect((await alone.wait()).held).toBe(true);
    } finally {
      if (navigator !== undefined)
        Object.defineProperty(navigator, "locks", { value: original, configurable: true });
    }
  });
});
