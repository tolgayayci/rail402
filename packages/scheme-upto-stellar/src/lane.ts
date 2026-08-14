/**
 * Per-signer settlement serialization (F4).
 *
 * A Stellar settlement reads the signer account's sequence number (`getAccount`) and consumes it on
 * submit. Two settlements running concurrently on the SAME signer read the same sequence number and
 * one is rejected with `txBadSeq`. The facilitator's throughput design is N *independent* signers
 * (each its own sequence lane), but within one lane the critical section from read to submit must
 * not interleave.
 *
 * This is that lock: a per-key promise chain. Different keys (different signers) run fully in
 * parallel; same-key calls run strictly one at a time, in arrival order. The lock is released on
 * both success and failure, so a throwing settlement never wedges its lane.
 *
 * Keys are signer addresses — a small fixed set — so the internal map is bounded and needs no
 * eviction. It deliberately guards only the read→submit critical section its caller wraps, not
 * confirmation polling: once a transaction is submitted its sequence number is spent, so the next
 * settlement on the lane may proceed while the previous one still waits to be included in a ledger.
 */
export interface SignerLanes {
  /** Run `fn` with exclusive access to `key`'s lane. Resolves/rejects with `fn`'s result. */
  run<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

export function createSignerLanes(): SignerLanes {
  // For each key, a promise that resolves when the currently-queued work on that lane is done.
  const tail = new Map<string, Promise<void>>();

  return {
    async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const previous = tail.get(key) ?? Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>(resolve => {
        release = resolve;
      });
      // The next caller on this key waits for `previous` AND for me to release.
      tail.set(key, previous.then(() => mine));
      // Wait my turn. `previous` is built only from resolve-only promises, so it never rejects.
      await previous;
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}
