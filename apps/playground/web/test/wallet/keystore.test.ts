import { describe, expect, it } from "vitest";
import { KeyHolder } from "@rail402.dev/sdk/browser";
import { StrKey } from "@stellar/stellar-sdk";
import { DATABASE_NAME, memoryKeystore, openKeystore } from "../../src/wallet/keystore.ts";
import { WalletVault } from "../../src/wallet/vault.ts";
import { FakeIndexedDB } from "./fake-indexeddb.ts";

const NETWORK = "stellar:testnet";

/** Every byte string and text in a stored value, for a secret scan. */
function contents(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value instanceof Uint8Array)
    return [Buffer.from(value).toString("latin1"), Buffer.from(value).toString("base64")];
  if (value instanceof ArrayBuffer) return contents(new Uint8Array(value));
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(contents);
  return [];
}

async function persistent() {
  const idb = new FakeIndexedDB();
  const store = await openKeystore({ indexedDB: idb as unknown as IDBFactory, crypto: globalThis.crypto });
  return { idb, store };
}

describe("keystore", () => {
  it("stores the seed encrypted under a non-extractable key and loads it back", async () => {
    const { idb, store } = await persistent();
    expect(store.storage).toBe("persistent");
    const key = KeyHolder.random();
    const seed = key.exportSecret();
    const saved = await store.save(key, NETWORK);
    expect(saved).toMatchObject({ address: key.address, network: NETWORK });

    const loaded = await store.load();
    expect(loaded?.key.address).toBe(key.address);
    expect(loaded?.key.exportSecret()).toBe(seed);
    expect(loaded?.wallet).toEqual(saved);

    // Neither the seed nor its raw bytes are stored anywhere; the encryption key cannot be exported.
    const raw = Buffer.from(StrKey.decodeEd25519SecretSeed(seed)).toString("latin1");
    for (const text of idb.written.flatMap(contents)) {
      expect(text).not.toContain(seed);
      expect(text).not.toContain(raw);
    }
    const keys = [...(idb.databases.get(DATABASE_NAME)?.get("keys")?.data.values() ?? [])] as {
      key: CryptoKey;
    }[];
    expect(keys[0]?.key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", keys[0]?.key as CryptoKey)).rejects.toThrow();
  });

  it("refuses a tampered or rebound record instead of loading another key", async () => {
    const { idb, store } = await persistent();
    await store.save(KeyHolder.random(), NETWORK);
    const wallets = idb.databases.get(DATABASE_NAME)?.get("wallets")?.data;
    const record = wallets?.get("buyer") as Record<string, unknown>;
    wallets?.set("buyer", { ...record, network: "stellar:pubnet" });
    await expect(store.load()).rejects.toMatchObject({ code: "playground_wallet_storage_unavailable" });
  });

  it("forgets the wallet", async () => {
    const { store } = await persistent();
    await store.save(KeyHolder.random(), NETWORK);
    await store.remove();
    expect(await store.load()).toBeUndefined();
  });

  it("keeps the wallet in memory when the browser cannot store it", async () => {
    const store = await openKeystore({ indexedDB: undefined, crypto: {} as Crypto });
    expect(store.storage).toBe("memory");
    const key = KeyHolder.random();
    await store.save(key, NETWORK);
    expect((await store.load())?.key.address).toBe(key.address);
  });
});

describe("wallet vault", () => {
  it("creates, refuses a second wallet, imports and forgets", async () => {
    const vault = WalletVault.over(memoryKeystore());
    const created = await vault.create(NETWORK);
    expect(vault.wallet).toEqual(created);
    await expect(vault.create(NETWORK)).rejects.toMatchObject({ code: "key_exists" });
    await vault.forget();
    expect(vault.wallet).toBeUndefined();
    await expect(vault.import("not a seed", NETWORK)).rejects.toMatchObject({ code: "key_invalid" });
    const key = KeyHolder.random();
    const imported = await vault.import(` ${key.exportSecret()} `, NETWORK);
    expect(imported.address).toBe(key.address);
  });

  it("writes a key file the CLI and SDK read, and never shows the key otherwise", async () => {
    const vault = WalletVault.over(memoryKeystore());
    const key = KeyHolder.random();
    await vault.import(key.exportSecret(), NETWORK);
    const file = vault.keyFile();
    expect(file.fileName).toBe(`rail402-testnet-${key.address.slice(0, 8).toLowerCase()}.key`);
    expect(await file.blob.text()).toBe(`${key.exportSecret()}\n`);
    expect(JSON.stringify(vault)).not.toContain(key.exportSecret());
    expect(JSON.stringify(vault.wallet)).not.toContain(key.exportSecret());
  });

  it("refuses to sign or fund without a wallet", () => {
    const vault = WalletVault.over(memoryKeystore());
    expect(() => vault.keyFile()).toThrow(expect.objectContaining({ code: "payment_signer_unavailable" }));
  });
});
