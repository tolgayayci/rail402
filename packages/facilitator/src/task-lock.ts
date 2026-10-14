/**
 * Runs a background task on one replica at a time. A replica that finds the task running elsewhere
 * skips it rather than waiting: the next round runs it again, from a fresh reading of the ledger.
 */
export interface TaskLock {
  /** Runs `task` while holding the lock `name`; resolves undefined without running it when held elsewhere. */
  run<T>(name: string, task: () => Promise<T>): Promise<T | undefined>;
}

/** A lock within one process, for a single replica (the in-memory store). */
export class MemoryTaskLock implements TaskLock {
  private readonly held = new Set<string>();

  async run<T>(name: string, task: () => Promise<T>): Promise<T | undefined> {
    if (this.held.has(name)) return undefined;
    this.held.add(name);
    try {
      return await task();
    } finally {
      this.held.delete(name);
    }
  }
}
