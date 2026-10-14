import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { TESTNET } from "@rail402.dev/stellar";
import {
  MemorySpendLedger,
  StorageSpendLedger,
  budgetSnapshot,
  type ReservationRequest,
  type SpendLedger,
  type WindowSpec,
} from "@rail402.dev/sdk";
import { SqliteSpendLedger } from "@rail402.dev/sdk/sqlite";
import { memoryStore, testPolicy, usdc } from "./helpers.ts";

const scratch = mkdtempSync(join(tmpdir(), "rail402-ledger-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

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

const ledgers: [string, () => SpendLedger][] = [
  ["memory", () => new MemorySpendLedger()],
  ["sqlite", () => new SqliteSpendLedger(join(scratch, `${crypto.randomUUID()}.sqlite`))],
  ["storage", () => new StorageSpendLedger(memoryStore(), { prefix: "ledger" })],
];

describe.each(ledgers)("%s spend ledger", (_name, open) => {
  it("reserves within the per-call and session caps and refuses beyond them", () => {
    const ledger = open();
    const spec = windowSpec(Keypair.random().publicKey());
    ledger.reserve(spec, request(100n), T0);
    ledger.reserve(spec, request(100n), T0);
    expect(() => ledger.reserve(spec, request(101n), T0)).toThrow(
      expect.objectContaining({ code: "payment_per_call_cap_exceeded" }),
    );
    expect(() => ledger.reserve(spec, request(51n), T0)).toThrow(
      expect.objectContaining({
        code: "payment_session_cap_exceeded",
        details: { price: "0.0000051", sessionCap: "0.000025", spent: "0", pending: "0.00002" },
      }),
    );
    ledger.reserve(spec, request(50n), T0);
    expect(() => ledger.reserve(spec, request(0n), T0)).toThrow(
      expect.objectContaining({ code: "payment_amount_not_permitted" }),
    );
    expect(() => ledger.reserve(spec, request(1n, { asset: "CUNKNOWN" }), T0)).toThrow(
      expect.objectContaining({ code: "payment_asset_not_permitted" }),
    );
    ledger.close();
  });

  it("moves reservations through their states and counts spent and pending", () => {
    const ledger = open();
    const spec = windowSpec(Keypair.random().publicKey());
    const a = ledger.reserve(spec, request(40n), T0);
    const b = ledger.reserve(spec, request(30n), T0);
    const c = ledger.reserve(spec, request(20n, { scheme: "upto" }), T0);

    expect(ledger.markTransmitted(a.id, T0)).toBe(false);
    expect(ledger.markSigned(a.id, { nonce: 5n, expirationLedger: 120, signedAtLedger: 100 }, T0)).toBe(true);
    expect(ledger.markSigned(a.id, { nonce: 5n, expirationLedger: 120, signedAtLedger: 100 }, T0)).toBe(
      false,
    );
    expect(ledger.release(a.id, "not_signed", T0)).toBe(false);
    expect(ledger.markTransmitted(a.id, T0)).toBe(true);
    expect(
      ledger.settle(a.id, { transaction: "ab".repeat(32), settledAmount: 40n, verified: false }, T0),
    ).toBe(true);

    expect(ledger.release(b.id, "not_signed", T0)).toBe(true);

    ledger.markSigned(c.id, { nonce: 6n, expirationLedger: 130, signedAtLedger: 101 }, T0);
    ledger.settle(c.id, { transaction: null, settledAmount: 5n, verified: false }, T0);

    const window = ledger.window(spec, T0);
    const usage = ledger.usage(window.id);
    // a: 40 spent; b: released; c: 5 spent and 15 unproven remainder pending.
    expect(usage.assets.get(usdc)).toEqual({ spent: 45n, pending: 15n });
    expect(ledger.get(a.id)).toMatchObject({
      state: "settled",
      nonce: 5n,
      expirationLedger: 120,
      signedAtLedger: 100,
      transaction: "ab".repeat(32),
      verified: false,
    });
    expect(ledger.get(b.id)).toMatchObject({ state: "released", releaseReason: "not_signed" });

    ledger.settle(c.id, { transaction: "cd".repeat(32), settledAmount: 5n, verified: true }, T0);
    expect(ledger.usage(window.id).assets.get(usdc)).toEqual({ spent: 45n, pending: 0n });
    // A claim never replaces a settlement the chain confirmed.
    expect(
      ledger.settle(c.id, { transaction: "ee".repeat(32), settledAmount: 20n, verified: false }, T0),
    ).toBe(false);
    expect(ledger.get(c.id)).toMatchObject({
      settledAmount: 5n,
      verified: true,
      transaction: "cd".repeat(32),
    });
    // A verified settlement is final, even for a forced release.
    expect(ledger.release(c.id, "forced", T0)).toBe(false);
    expect(ledger.release(a.id, "claim_false", T0)).toBe(true);
    expect(ledger.usage(window.id)).toMatchObject({ falseClaims: 1 });
    ledger.close();
  });

  it("lists unfinished reservations across windows, oldest first", () => {
    const ledger = open();
    const payer = Keypair.random().publicKey();
    const spec = windowSpec(payer);
    const first = ledger.reserve(spec, request(10n), T0);
    const second = ledger.reserve(spec, request(10n), T0 + 1);
    const done = ledger.reserve(spec, request(10n), T0 + 2);
    ledger.markSigned(done.id, { nonce: 1n, expirationLedger: 10, signedAtLedger: 1 }, T0);
    ledger.settle(done.id, { transaction: "ef".repeat(32), settledAmount: 10n, verified: true }, T0);
    const later = ledger.reserve(spec, request(10n), T0 + 2 * HOUR);
    ledger.reserve(windowSpec(Keypair.random().publicKey()), request(10n), T0);
    expect(ledger.unfinished(TESTNET, payer).map((row) => row.id)).toEqual([first.id, second.id, later.id]);
    ledger.setAwaitingProof(first.id, true, T0);
    expect(ledger.get(first.id)?.awaitingProof).toBe(true);
    ledger.close();
  });

  it("renews an expired window, and never raises caps stored in an active one", () => {
    const ledger = open();
    const payer = Keypair.random().publicKey();
    const first = ledger.window(windowSpec(payer), T0);
    expect(ledger.window(windowSpec(payer), T0 + HOUR - 1).id).toBe(first.id);

    const raised = windowSpec(payer, { caps: { [usdc]: { perCall: 1_000n, total: 5_000n, decimals: 7 } } });
    expect(() => ledger.reserve(raised, request(101n), T0)).toThrow(
      expect.objectContaining({ code: "payment_per_call_cap_exceeded" }),
    );
    const lowered = windowSpec(payer, { caps: { [usdc]: { perCall: 10n, total: 20n, decimals: 7 } } });
    expect(() => ledger.reserve(lowered, request(11n), T0)).toThrow(
      expect.objectContaining({ code: "payment_per_call_cap_exceeded" }),
    );

    const renewed = ledger.window(raised, T0 + HOUR);
    expect(renewed.id).not.toBe(first.id);
    expect(renewed.expiresAt).toBe(T0 + 2 * HOUR);
    // The renewed window takes the caps configured now.
    ledger.reserve(raised, request(1_000n), T0 + HOUR);
    expect(ledger.listWindows(TESTNET, payer).map((window) => window.id)).toEqual([renewed.id, first.id]);
    ledger.close();
  });

  it("refuses when a window that does not renew has ended, or a required session was never started", () => {
    const ledger = open();
    const payer = Keypair.random().publicKey();
    const task = windowSpec(payer, { name: "task-42", autoRenew: false, autoCreate: false });
    expect(() => ledger.window(task, T0)).toThrow(
      expect.objectContaining({ code: "payment_session_expired" }),
    );
    const started = ledger.startWindow(task, T0);
    ledger.reserve(task, request(10n), T0 + 1);
    expect(() => ledger.reserve(task, request(10n), T0 + HOUR)).toThrow(
      expect.objectContaining({ code: "payment_session_expired" }),
    );
    expect(ledger.endWindow(started.id, T0 + HOUR)).toBe(true);
    expect(ledger.endWindow(started.id, T0 + HOUR)).toBe(false);
    expect(() => ledger.window(task, T0 + HOUR)).toThrow(
      expect.objectContaining({ code: "payment_session_expired" }),
    );
    const restarted = ledger.startWindow(task, T0 + HOUR);
    expect(restarted.id).not.toBe(started.id);
    expect(() => ledger.window(windowSpec(payer, { name: "bad name!" }), T0)).toThrow(
      expect.objectContaining({ code: "payment_policy_invalid" }),
    );
    ledger.close();
  });

  it("keeps idempotency keys unique per window and frees a key only when nothing was signed", () => {
    const ledger = open();
    const spec = windowSpec(Keypair.random().publicKey());
    const first = ledger.reserve(spec, request(10n, { idempotencyKey: "job-1-abcdef" }), T0);
    expect(() => ledger.reserve(spec, request(10n, { idempotencyKey: "job-1-abcdef" }), T0)).toThrow(
      expect.objectContaining({ code: "payment_in_progress", paid: "unknown", retryable: true }),
    );
    ledger.release(first.id, "not_signed", T0);
    const second = ledger.reserve(spec, request(10n, { idempotencyKey: "job-1-abcdef" }), T0);
    const window = ledger.window(spec, T0);
    expect(ledger.findByIdempotencyKey(window.id, "job-1-abcdef")?.id).toBe(second.id);
    expect(ledger.get(first.id)?.idempotencyKey).toBeUndefined();

    ledger.markSigned(second.id, { nonce: 2n, expirationLedger: 50, signedAtLedger: 40 }, T0);
    ledger.storeResult(second.id, '{"ok":true}', T0);
    expect(ledger.findByIdempotencyKey(window.id, "job-1-abcdef")?.result).toBe('{"ok":true}');
    expect(() => ledger.reserve(spec, request(10n, { idempotencyKey: "job-1-abcdef" }), T0)).toThrow(
      /already completed/,
    );
    ledger.close();
  });

  it("frees a key once the chain proves its signed authorization expired unused", () => {
    const ledger = open();
    const spec = windowSpec(Keypair.random().publicKey());
    const first = ledger.reserve(spec, request(10n, { idempotencyKey: "job-2-abcdef" }), T0);
    ledger.markSigned(first.id, { nonce: 3n, expirationLedger: 50, signedAtLedger: 40 }, T0);
    ledger.markUnresolved(first.id, T0);
    expect(() => ledger.reserve(spec, request(10n, { idempotencyKey: "job-2-abcdef" }), T0)).toThrow(
      /awaits on-chain proof/,
    );
    ledger.release(first.id, "expired_unused", T0);
    const second = ledger.reserve(spec, request(10n, { idempotencyKey: "job-2-abcdef" }), T0);
    expect(ledger.findByIdempotencyKey(ledger.window(spec, T0).id, "job-2-abcdef")?.id).toBe(second.id);
    ledger.close();
  });

  it("reports a budget snapshot in whole units", async () => {
    const ledger = open();
    const payer = Keypair.random().publicKey();
    const policy = await testPolicy();
    const spec = {
      ...windowSpec(payer),
      caps: { [usdc]: { perCall: 1_000_000n, total: 10_000_000n, decimals: 7 } },
    };
    const row = ledger.reserve(spec, request(250_000n), T0);
    ledger.markSigned(row.id, { nonce: 1n, expirationLedger: 10, signedAtLedger: 1 }, T0);
    ledger.settle(row.id, { transaction: null, settledAmount: 250_000n, verified: true }, T0);
    ledger.reserve(spec, request(100_000n), T0);
    expect(budgetSnapshot(ledger, spec, policy, T0)).toMatchObject({
      session: "default",
      network: TESTNET,
      payer,
      expiresAt: new Date(T0 + HOUR).toISOString(),
      assets: [
        {
          asset: "USDC",
          contract: usdc,
          perCallCap: "0.1",
          sessionCap: "1",
          spent: "0.025",
          pending: "0.01",
          remaining: "0.965",
        },
      ],
      awaitingProof: 0,
    });
    ledger.close();
  });
});
