/**
 * Channel accounts give every in-flight settlement its own transaction source, so concurrent
 * settlements never compete for one sequence number. A channel is leased exclusively from the moment
 * a settlement starts until its transaction is final — including while it is pending after a timeout,
 * because a transaction that may still land holds that channel's next sequence number.
 */
export interface ChannelPool {
  /** Every channel address in the pool, leased or not. */
  readonly addresses: readonly string[];
  /** Leases a free channel, waiting up to `waitMs`. Resolves `undefined` when none frees up in time. */
  acquire(waitMs: number): Promise<string | undefined>;
  /** Returns a channel to the pool. Releasing a free channel is a no-op. */
  release(address: string): Promise<void>;
  /** Number of channels currently leased. */
  inUse(): Promise<number>;
}

/** Process-local pool for the in-process facilitator and tests. */
export class MemoryChannelPool implements ChannelPool {
  readonly addresses: readonly string[];
  private readonly free: string[];
  private readonly leased = new Set<string>();
  private readonly waiters: ((address: string) => void)[] = [];

  constructor(addresses: readonly string[]) {
    if (addresses.length === 0) throw new Error("a channel pool needs at least one channel");
    if (new Set(addresses).size !== addresses.length) throw new Error("duplicate channel address");
    this.addresses = [...addresses];
    this.free = [...addresses];
  }

  acquire(waitMs: number): Promise<string | undefined> {
    const address = this.free.shift();
    if (address !== undefined) {
      this.leased.add(address);
      return Promise.resolve(address);
    }
    if (waitMs <= 0) return Promise.resolve(undefined);

    return new Promise((resolve) => {
      const waiter = (granted: string) => {
        clearTimeout(timer);
        resolve(granted);
      };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        resolve(undefined);
      }, waitMs);
      this.waiters.push(waiter);
    });
  }

  release(address: string): Promise<void> {
    if (!this.leased.has(address)) return Promise.resolve();
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      // Hand the channel straight to the next waiter; it stays leased.
      waiter(address);
    } else {
      this.leased.delete(address);
      this.free.push(address);
    }
    return Promise.resolve();
  }

  inUse(): Promise<number> {
    return Promise.resolve(this.leased.size);
  }
}
