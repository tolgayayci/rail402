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
  /**
   * Returns a leased channel to the pool but keeps it out of rotation for `cooldownMs`, doubled for
   * each quarantine since its last plain `release`, up to `MAX_QUARANTINE_FACTOR` times: used when
   * another transaction took the channel's sequence number, so a channel someone else keeps using is
   * not handed straight back to the next settlement. Quarantining a free channel is a no-op.
   * `sequence` is the channel account's sequence number seen at the conflict, kept until the next
   * lease takes it (`takeQuarantineSequence`) or a plain `release` drops it.
   */
  quarantine(address: string, cooldownMs: number, sequence?: string): Promise<void>;
  /**
   * The sequence number a leased channel's last quarantine recorded, removed as it is read; undefined
   * when it was not quarantined since its last plain release. The holder compares it with the
   * account's current sequence number: a number that moved means someone still uses the account.
   */
  takeQuarantineSequence(address: string): Promise<string | undefined>;
  /** Number of channels currently leased; a quarantined channel is not leased. */
  inUse(): Promise<number>;
}

/** The longest quarantine, as a multiple of the cooldown: 1, 2, 4, 8, then 16 times. */
export const MAX_QUARANTINE_FACTOR = 16;

/** The cooldown of the `streak`-th quarantine in a row (1-based). */
export function quarantineMs(cooldownMs: number, streak: number): number {
  return cooldownMs * Math.min(MAX_QUARANTINE_FACTOR, 2 ** Math.max(0, streak - 1));
}

/** Process-local pool for the in-process facilitator and tests. */
export class MemoryChannelPool implements ChannelPool {
  readonly addresses: readonly string[];
  private readonly free: string[];
  private readonly leased = new Set<string>();
  private readonly waiters: ((address: string) => void)[] = [];
  /** Quarantines in a row per channel, since its last plain release. */
  private readonly streaks = new Map<string, number>();
  /** The sequence number each quarantined channel's account had at its conflict. */
  private readonly quarantineSequences = new Map<string, string>();

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
    this.streaks.delete(address);
    this.quarantineSequences.delete(address);
    this.handOver(address);
    return Promise.resolve();
  }

  quarantine(address: string, cooldownMs: number, sequence?: string): Promise<void> {
    if (!this.leased.has(address)) return Promise.resolve();
    if (sequence === undefined) this.quarantineSequences.delete(address);
    else this.quarantineSequences.set(address, sequence);
    const streak = (this.streaks.get(address) ?? 0) + 1;
    this.streaks.set(address, streak);
    // Neither leased nor free until the cooldown passes.
    this.leased.delete(address);
    setTimeout(
      () => {
        this.leased.add(address);
        this.handOver(address);
      },
      quarantineMs(cooldownMs, streak),
    ).unref();
    return Promise.resolve();
  }

  takeQuarantineSequence(address: string): Promise<string | undefined> {
    const sequence = this.quarantineSequences.get(address);
    this.quarantineSequences.delete(address);
    return Promise.resolve(sequence);
  }

  /** Gives a leased channel to the next waiter, or back to the free list. */
  private handOver(address: string): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      // Hand the channel straight to the next waiter; it stays leased.
      waiter(address);
    } else {
      this.leased.delete(address);
      this.free.push(address);
    }
  }

  inUse(): Promise<number> {
    return Promise.resolve(this.leased.size);
  }
}
