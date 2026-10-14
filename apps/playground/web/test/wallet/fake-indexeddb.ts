/**
 * A minimal in-memory IndexedDB for the keystore's tests: one database, object stores keyed by an
 * in-line key path, get/put/delete requests and transactions that complete once their requests ran.
 */

type Store = Map<unknown, unknown>;

interface FakeRequest<T> {
  result: T;
  error: DOMException | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

function request<T>(run: () => T, done: () => void): FakeRequest<T> {
  const pending: FakeRequest<T> = { result: undefined as T, error: null, onsuccess: null, onerror: null };
  setTimeout(() => {
    pending.result = run();
    pending.onsuccess?.();
    done();
  }, 0);
  return pending;
}

export class FakeIndexedDB {
  readonly databases = new Map<string, Map<string, { keyPath: string; data: Store }>>();
  /** Every value ever written, for scans. */
  readonly written: unknown[] = [];

  open(name: string): unknown {
    const opening = {
      result: undefined as unknown,
      error: null,
      onupgradeneeded: null as (() => void) | null,
      onsuccess: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onblocked: null as (() => void) | null,
    };
    setTimeout(() => {
      const fresh = !this.databases.has(name);
      const stores = this.databases.get(name) ?? new Map<string, { keyPath: string; data: Store }>();
      this.databases.set(name, stores);
      opening.result = this.#database(stores);
      if (fresh) opening.onupgradeneeded?.();
      opening.onsuccess?.();
    }, 0);
    return opening;
  }

  #database(stores: Map<string, { keyPath: string; data: Store }>) {
    const written = this.written;
    return {
      objectStoreNames: { contains: (store: string) => stores.has(store) },
      createObjectStore: (store: string, options: { keyPath: string }) => {
        stores.set(store, { keyPath: options.keyPath, data: new Map() });
      },
      transaction: (names: string | string[]) => {
        let open = 0;
        const transaction = {
          error: null,
          oncomplete: null as (() => void) | null,
          onerror: null as (() => void) | null,
          onabort: null as (() => void) | null,
          objectStore: (store: string) => {
            const target = stores.get(store);
            if (target === undefined || !([] as string[]).concat(names).includes(store)) {
              throw new DOMException("no such store", "NotFoundError");
            }
            const finish = () => {
              open--;
              if (open === 0) setTimeout(() => transaction.oncomplete?.(), 0);
            };
            const track = <T>(run: () => T) => {
              open++;
              return request(run, finish);
            };
            return {
              get: (key: unknown) => track(() => target.data.get(key)),
              put: (value: Record<string, unknown>) =>
                track(() => {
                  written.push(value);
                  target.data.set(value[target.keyPath], value);
                }),
              delete: (key: unknown) => track(() => target.data.delete(key)),
            };
          },
        };
        return transaction;
      },
    };
  }
}
