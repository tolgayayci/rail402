/**
 * The storage ledger survives a reload with the same budget and pending payments, refuses to run on
 * a record it cannot read until it is reset, and never keeps a change it could not save.
 */
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { TESTNET } from "@rail402.dev/stellar";
import {
  STORAGE_LEDGER_RETENTION_MS,
  StorageSpendLedger,
  type ReservationRequest,
  type WindowSpec,
} from "@rail402.dev/sdk";
import { memoryStore, usdc } from "./helpers.ts";

const HOUR = 3_600_000;
const T0 = 1_800_000_000_000;

function windowSpec(payer: string, overrides: Partial<WindowSpec> = {}): WindowSpec {
  return {
    network: TESTNET,
    payer,
    name: "default",
    ttlMs: HOUR,
    caps: { [usdc]: { perCall: 100n, total: 250n, decimals: 7 } },
    autoRenew: true,
    autoCreate: true,
    ...overrides,
  };
}

const request = (amount: bigint, overrides: Partial<ReservationRequest> = {}): ReservationRequest => ({
  callId: crypto.randomUUID(),
  scheme: "exact",
  asset: usdc,
  payTo: Keypair.random().publicKey(),
  resource: "https://seller.example/x",
  amount,
  ...overrides,
});

const unavailable = expect.objectContaining({ code: "payment_ledger_unavailable" }) as Error;

describe("storage spend ledger", () => {
  it("keeps windows, reservations, proofs and results across a reload", () => {
    const store = memoryStore();
    const spec = windowSpec(Keypair.random().publicKey());
    const first = new StorageSpendLedger(store, { prefix: "rail402.test" });
    expect(first.key).toBe("rail402.test:v1");
    const settled = first.reserve(spec, request(100n, { idempotencyKey: "order_12345678" }), T0);
    first.markSigned(settled.id, { nonce: 2n ** 63n + 5n, expirationLedger: 900, signedAtLedger: 880 }, T0);
    first.markTransmitted(settled.id, T0);
    first.settle(settled.id, { transaction: "ab".repeat(32), settledAmount: 100n, verified: true }, T0);
    first.storeResult(settled.id, '{"v":1}', T0);
    const pending = first.reserve(spec, request(60n, { scheme: "upto" }), T0);
    first.markSigned(pending.id, { nonce: 7n, expirationLedger: 950, signedAtLedger: 930 }, T0);
    first.markUnresolved(pending.id, T0);

    const reloaded = new StorageSpendLedger(store, { prefix: "rail402.test" });
    const window = reloaded.window(spec, T0);
    expect(window).toEqual(first.window(spec, T0));
    expect(reloaded.get(settled.id)).toEqual(first.get(settled.id));
    expect(reloaded.get(settled.id)?.nonce).toBe(2n ** 63n + 5n);
    expect(reloaded.findByIdempotencyKey(window.id, "order_12345678")?.result).toBe('{"v":1}');
    expect(reloaded.unfinished(TESTNET, spec.payer).map((row) => row.id)).toEqual([pending.id]);
    expect(reloaded.usage(window.id).assets.get(usdc)).toEqual({ spent: 100n, pending: 60n });
    // The session cap still counts what was spent and reserved before the reload.
    expect(() => reloaded.reserve(spec, request(91n), T0)).toThrow(
      expect.objectContaining({ code: "payment_session_cap_exceeded" }),
    );
    reloaded.reserve(spec, request(90n), T0);
  });

  it("keeps one record per prefix", () => {
    const store = memoryStore();
    const payer = Keypair.random().publicKey();
    const one = new StorageSpendLedger(store, { prefix: "a" });
    const two = new StorageSpendLedger(store, { prefix: "b" });
    one.reserve(windowSpec(payer), request(100n), T0);
    expect(two.unfinished(TESTNET, payer)).toEqual([]);
    expect([...store.entries.keys()].sort()).toEqual(["a:v1"]);
    expect(() => new StorageSpendLedger(store, { prefix: " " })).toThrow(TypeError);
  });

  it("sees changes made through another instance before every operation", () => {
    const store = memoryStore();
    const spec = windowSpec(Keypair.random().publicKey());
    const tabA = new StorageSpendLedger(store, { prefix: "p" });
    const tabB = new StorageSpendLedger(store, { prefix: "p" });
    tabA.reserve(spec, request(100n), T0);
    tabB.reserve(spec, request(100n), T0);
    expect(() => tabA.reserve(spec, request(51n), T0)).toThrow(
      expect.objectContaining({ code: "payment_session_cap_exceeded" }),
    );
    tabB.reset();
    expect(tabA.unfinished(TESTNET, spec.payer)).toEqual([]);
  });

  it.each([
    ["not JSON", "{"],
    ["another version", JSON.stringify({ v: 2, windows: [], reservations: [] })],
    ["a malformed amount", null],
    ["a reservation without its window", undefined],
  ])("refuses every operation on a record that is %s until it is reset", (_case, planted) => {
    const store = memoryStore();
    const spec = windowSpec(Keypair.random().publicKey());
    const ledger = new StorageSpendLedger(store, { prefix: "p" });
    const row = ledger.reserve(spec, request(100n), T0);
    const valid = store.entries.get("p:v1") ?? "";
    const record = JSON.parse(valid) as { windows: unknown[]; reservations: { amount: string }[] };
    let text: string;
    if (planted === null) {
      text = JSON.stringify({ ...record, reservations: [{ ...record.reservations[0], amount: "1e3" }] });
    } else if (planted === undefined) {
      text = JSON.stringify({ ...record, windows: [] });
    } else {
      text = planted;
    }
    store.entries.set("p:v1", text);

    const reopened = new StorageSpendLedger(store, { prefix: "p" });
    expect(reopened.corrupt).toBe(true);
    for (const operation of [
      () => reopened.window(spec, T0),
      () => reopened.reserve(spec, request(1n), T0),
      () => reopened.get(row.id),
      () => reopened.unfinished(TESTNET, spec.payer),
      () => reopened.release(row.id, "forced", T0),
    ]) {
      expect(operation).toThrow(unavailable);
    }
    expect(ledger.corrupt).toBe(true);
    expect(() => ledger.get(row.id)).toThrow(unavailable);
    // Never discarded silently: the unreadable record is still there.
    expect(store.entries.get("p:v1")).toBe(text);

    reopened.reset();
    expect(reopened.corrupt).toBe(false);
    expect(store.entries.has("p:v1")).toBe(false);
    expect(reopened.get(row.id)).toBeUndefined();
    reopened.reserve(spec, request(100n), T0);
    expect(ledger.corrupt).toBe(false);
  });

  it("undoes a change it could not save and refuses it", () => {
    const store = memoryStore();
    let full = false;
    const flaky = {
      ...store,
      setItem: (key: string, value: string) => {
        if (full) throw new DOMException("quota", "QuotaExceededError");
        store.setItem(key, value);
      },
    };
    const spec = windowSpec(Keypair.random().publicKey());
    const ledger = new StorageSpendLedger(flaky, { prefix: "p" });
    const kept = ledger.reserve(spec, request(100n), T0);
    full = true;
    expect(() => ledger.reserve(spec, request(100n), T0)).toThrow(unavailable);
    expect(() =>
      ledger.markSigned(kept.id, { nonce: 1n, expirationLedger: 2, signedAtLedger: 1 }, T0),
    ).toThrow(unavailable);
    expect(ledger.unfinished(TESTNET, spec.payer).map((row) => [row.id, row.state])).toEqual([
      [kept.id, "reserved"],
    ]);
    full = false;
    expect(ledger.markSigned(kept.id, { nonce: 1n, expirationLedger: 2, signedAtLedger: 1 }, T0)).toBe(true);
    expect(new StorageSpendLedger(store, { prefix: "p" }).get(kept.id)?.state).toBe("signed");
  });

  it("refuses while the store cannot be read", () => {
    const blocked = {
      getItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    const ledger = new StorageSpendLedger(blocked, { prefix: "p" });
    expect(() => ledger.window(windowSpec(Keypair.random().publicKey()), T0)).toThrow(unavailable);
    expect(ledger.corrupt).toBe(false);
  });

  it("drops ended windows whose payments are resolved once the retention has passed", () => {
    const store = memoryStore();
    const payer = Keypair.random().publicKey();
    const spec = windowSpec(payer);
    const ledger = new StorageSpendLedger(store, { prefix: "p" });
    const done = ledger.reserve(spec, request(10n), T0);
    ledger.release(done.id, "not_signed", T0);
    const open = ledger.reserve(windowSpec(payer, { name: "other" }), request(10n), T0);
    ledger.markSigned(open.id, { nonce: 1n, expirationLedger: 2, signedAtLedger: 1 }, T0);
    const first = ledger.window(spec, T0);
    const other = ledger.window(windowSpec(payer, { name: "other" }), T0);
    ledger.endWindow(first.id, T0 + HOUR);
    ledger.endWindow(other.id, T0 + HOUR);

    ledger.window(spec, T0 + HOUR + STORAGE_LEDGER_RETENTION_MS - 1);
    expect(ledger.listWindows(TESTNET, payer).map((window) => window.id)).toContain(first.id);
    ledger.window(spec, T0 + HOUR + STORAGE_LEDGER_RETENTION_MS + HOUR);
    const left = ledger.listWindows(TESTNET, payer).map((window) => window.id);
    expect(left).not.toContain(first.id);
    expect(ledger.get(done.id)).toBeUndefined();
    // A signed payment the chain has not resolved is kept, with its window.
    expect(left).toContain(other.id);
    expect(ledger.get(open.id)?.state).toBe("signed");
  });
});
