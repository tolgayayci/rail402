/**
 * The page's testnet wallet store. The secret seed is encrypted with AES-GCM under a key that WebCrypto
 * generated as non-extractable and that IndexedDB keeps as a `CryptoKey` object: script can use it to
 * decrypt, but can never read its bytes. Only the ciphertext and the public address are stored; the
 * seed is decrypted once per page load into a `KeyHolder`, which keeps it in a private field.
 *
 * Without IndexedDB or WebCrypto the wallet lives in memory for this tab only (`storage: "memory"`).
 * Only modules under `wallet/` import this file.
 */
import { KeyHolder } from "@rail402.dev/sdk/browser";
import { playgroundError } from "../../../src/shared/codes.ts";

export const DATABASE_NAME = "rail402-playground";
const DATABASE_VERSION = 1;
const WALLETS = "wallets";
const KEYS = "keys";
const WALLET_ID = "buyer";
const KEY_ID = "wallet-key";

/** The public part of a stored wallet. */
export interface StoredWallet {
  readonly address: string;
  readonly network: string;
  /** ISO date-time. */
  readonly createdAt: string;
}

/** The record IndexedDB holds: public facts and the encrypted seed, never the seed itself. */
interface WalletRecord extends StoredWallet {
  readonly id: typeof WALLET_ID;
  readonly iv: Uint8Array;
  readonly ciphertext: ArrayBuffer;
}

export interface Keystore {
  /** `persistent`: encrypted in IndexedDB; `memory`: this tab only. */
  readonly storage: "persistent" | "memory";
  /** The stored wallet and its key; undefined when none is stored. Rejects when it cannot be read. */
  load(): Promise<{ readonly key: KeyHolder; readonly wallet: StoredWallet } | undefined>;
  save(key: KeyHolder, network: string): Promise<StoredWallet>;
  /** Deletes the wallet (and its encryption key). */
  remove(): Promise<void>;
}

export interface KeystoreOptions {
  /** Default: the page's `indexedDB`. */
  readonly indexedDB?: IDBFactory | undefined;
  /** Default: the page's `crypto`. */
  readonly crypto?: Crypto | undefined;
  readonly now?: () => Date;
}

/** Opens the persistent keystore, or the in-memory one when the browser cannot store the wallet. */
export async function openKeystore(options: KeystoreOptions = {}): Promise<Keystore> {
  const scope = globalThis as { indexedDB?: IDBFactory; crypto?: Crypto };
  const factory = options.indexedDB ?? scope.indexedDB;
  const crypto = options.crypto ?? scope.crypto;
  const now = options.now ?? (() => new Date());
  if (factory === undefined || crypto?.subtle === undefined) return memoryKeystore(now);
  let database: IDBDatabase;
  try {
    database = await openDatabase(factory);
  } catch {
    return memoryKeystore(now);
  }
  return persistentKeystore(database, crypto, now);
}

/** A keystore that keeps the wallet in this tab only. */
export function memoryKeystore(now: () => Date = () => new Date()): Keystore {
  let held: { key: KeyHolder; wallet: StoredWallet } | undefined;
  return {
    storage: "memory",
    load: () => Promise.resolve(held),
    save: (key, network) => {
      const wallet = { address: key.address, network, createdAt: now().toISOString() };
      held = { key, wallet };
      return Promise.resolve(wallet);
    },
    remove: () => {
      held = undefined;
      return Promise.resolve();
    },
  };
}

function persistentKeystore(database: IDBDatabase, crypto: Crypto, now: () => Date): Keystore {
  const unreadable = () =>
    playgroundError("playground_wallet_storage_unavailable", {
      reason:
        "The stored wallet could not be read or decrypted in this browser; forget it and create a new one.",
    });
  return {
    storage: "persistent",
    load: async () => {
      const record = await request<WalletRecord | undefined>(
        database.transaction(WALLETS, "readonly").objectStore(WALLETS).get(WALLET_ID),
      );
      if (record === undefined) return undefined;
      const stored = await request<{ id: string; key: CryptoKey } | undefined>(
        database.transaction(KEYS, "readonly").objectStore(KEYS).get(KEY_ID),
      );
      if (stored === undefined) throw unreadable();
      let key: KeyHolder;
      try {
        const plain = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: copy(record.iv), additionalData: bindingOf(record) },
          stored.key,
          record.ciphertext,
        );
        key = KeyHolder.fromSecret(new TextDecoder().decode(plain));
      } catch {
        throw unreadable();
      }
      if (key.address !== record.address) throw unreadable();
      return {
        key,
        wallet: { address: record.address, network: record.network, createdAt: record.createdAt },
      };
    },
    save: async (key, network) => {
      const wallet: StoredWallet = { address: key.address, network, createdAt: now().toISOString() };
      const secretKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
      ]);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: bindingOf(wallet) },
        secretKey,
        new TextEncoder().encode(key.exportSecret()),
      );
      const record: WalletRecord = { id: WALLET_ID, ...wallet, iv, ciphertext };
      const transaction = database.transaction([WALLETS, KEYS], "readwrite");
      transaction.objectStore(KEYS).put({ id: KEY_ID, key: secretKey });
      transaction.objectStore(WALLETS).put(record);
      await completion(transaction);
      return wallet;
    },
    remove: async () => {
      const transaction = database.transaction([WALLETS, KEYS], "readwrite");
      transaction.objectStore(WALLETS).delete(WALLET_ID);
      transaction.objectStore(KEYS).delete(KEY_ID);
      await completion(transaction);
    },
  };
}

/** The ciphertext is bound to the address and network it was stored under. */
function bindingOf(wallet: StoredWallet): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${wallet.address}|${wallet.network}`);
}

function copy(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out;
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const opening = factory.open(DATABASE_NAME, DATABASE_VERSION);
    opening.onupgradeneeded = () => {
      const database = opening.result;
      if (!database.objectStoreNames.contains(WALLETS))
        database.createObjectStore(WALLETS, { keyPath: "id" });
      if (!database.objectStoreNames.contains(KEYS)) database.createObjectStore(KEYS, { keyPath: "id" });
    };
    opening.onsuccess = () => {
      resolve(opening.result);
    };
    opening.onerror = () => {
      reject(opening.error ?? new Error("IndexedDB could not be opened"));
    };
    opening.onblocked = () => {
      reject(new Error("IndexedDB is blocked by another tab"));
    };
  });
}

function request<T>(pending: IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    pending.onsuccess = () => {
      resolve(pending.result as T);
    };
    pending.onerror = () => {
      reject(pending.error ?? new Error("IndexedDB request failed"));
    };
  });
}

function completion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve();
    };
    transaction.onerror = () => {
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    };
    transaction.onabort = () => {
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    };
  });
}
