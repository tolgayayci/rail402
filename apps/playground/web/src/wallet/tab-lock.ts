/**
 * One tab holds the wallet at a time, through a Web Lock. The tab that holds it may sign and keeps the
 * budget ledger; other tabs are read-only (`playground_wallet_locked`) until the holder closes. This
 * also keeps the synchronous localStorage ledger to a single writer.
 */

export const WALLET_LOCK = "rail402-playground-wallet";

export interface TabLock {
  readonly held: boolean;
  /** Gives the lock up (on forget or when the page goes away). */
  release(): void;
  /** For a lock this tab does not hold: settles once the holder lets go and this tab holds it. */
  wait(): Promise<TabLock>;
}

/** The part of `navigator.locks` the tab lock uses. */
export interface LockRequester {
  request(
    name: string,
    options: { readonly ifAvailable?: boolean },
    callback: (lock: unknown) => Promise<void>,
  ): Promise<unknown>;
}

/**
 * Takes the wallet lock if no other tab holds it. Without the Web Locks API (old browsers, tests), the
 * tab assumes it is alone and holds the lock.
 */
export function acquireTabLock(
  options: { readonly locks?: LockRequester | undefined; readonly name?: string } = {},
): Promise<TabLock> {
  const locks: LockRequester | null | undefined =
    options.locks ?? (globalThis as { navigator?: { locks?: LockRequester | null } }).navigator?.locks;
  const name = options.name ?? WALLET_LOCK;
  if (locks === undefined || locks === null) {
    const alone: TabLock = { held: true, release: () => undefined, wait: () => Promise.resolve(alone) };
    return Promise.resolve(alone);
  }
  return new Promise((resolve) => {
    let release: () => void = () => undefined;
    const holding = new Promise<void>((done) => {
      release = done;
    });
    locks
      .request(name, { ifAvailable: true }, async (lock) => {
        if (lock === null) {
          resolve(waiting(locks, name));
          return;
        }
        const held: TabLock = { held: true, release, wait: () => Promise.resolve(held) };
        resolve(held);
        await holding;
      })
      .catch(() => {
        // A lock manager that fails (for example in an opaque origin) cannot coordinate tabs.
        const alone: TabLock = { held: true, release: () => undefined, wait: () => Promise.resolve(alone) };
        resolve(alone);
      });
  });
}

/** A lock held elsewhere: `wait` queues for it. */
function waiting(locks: LockRequester, name: string): TabLock {
  let queued: Promise<TabLock> | undefined;
  return {
    held: false,
    release: () => undefined,
    wait: () => {
      queued ??= new Promise((resolve) => {
        let release: () => void = () => undefined;
        const holding = new Promise<void>((done) => {
          release = done;
        });
        void locks
          .request(name, {}, async () => {
            const held: TabLock = { held: true, release, wait: () => Promise.resolve(held) };
            resolve(held);
            await holding;
          })
          .catch(() => undefined);
      });
      return queued;
    },
  };
}
