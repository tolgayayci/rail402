import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { TESTNET } from "@rail402.dev/stellar";
import { SqliteSpendLedger, defaultLedgerPath } from "@rail402.dev/sdk/sqlite";
import { usdc } from "./helpers.ts";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "rail402-sqlite-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const worker = fileURLToPath(new URL("./fixtures/reserve-worker.ts", import.meta.url));

const spec = (payer: string) =>
  ({
    network: TESTNET,
    payer,
    name: "default",
    ttlMs: 3_600_000,
    caps: { [usdc]: { perCall: 10n, total: 100n, decimals: 7 } },
    autoRenew: true,
    autoCreate: true,
  }) as const;

describe("SqliteSpendLedger", () => {
  it.skipIf(process.platform === "win32")("creates a private directory and file", () => {
    const path = join(scratch, "fresh", "state", "ledger.sqlite");
    const ledger = new SqliteSpendLedger(path);
    ledger.window(spec(Keypair.random().publicKey()));
    expect(statSync(join(scratch, "fresh", "state")).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(`${path}-wal`).mode & 0o077).toBe(0);
    ledger.close();
  });

  it("keeps reservations across reopening, with amounts stored as text", () => {
    const path = join(scratch, "persist.sqlite");
    const payer = Keypair.random().publicKey();
    const first = new SqliteSpendLedger(path);
    const row = first.reserve(spec(payer), {
      callId: "c1",
      scheme: "exact",
      asset: usdc,
      payTo: payer,
      resource: "r",
      amount: 7n,
    });
    first.close();
    const second = new SqliteSpendLedger(path);
    expect(second.get(row.id)).toMatchObject({ amount: 7n, state: "reserved" });
    second.close();
    const raw = new DatabaseSync(path);
    expect(raw.prepare("SELECT typeof(amount) AS type FROM reservations").get()).toEqual({ type: "text" });
    raw.close();
  });

  it("upgrades a version 1 ledger in place and keeps its rows", () => {
    const path = join(scratch, "v1.sqlite");
    const payer = Keypair.random().publicKey();
    const first = new SqliteSpendLedger(path);
    const row = first.reserve(spec(payer), {
      callId: "c1",
      scheme: "exact",
      asset: usdc,
      payTo: payer,
      resource: "r",
      amount: 7n,
    });
    first.markSigned(row.id, { nonce: 3n, expirationLedger: 20, signedAtLedger: 10 });
    first.close();
    // The same file as a version 1 ledger wrote it: without the column version 2 added.
    const raw = new DatabaseSync(path);
    raw.exec("ALTER TABLE reservations DROP COLUMN unprovable; PRAGMA user_version = 1");
    raw.close();
    const upgraded = new SqliteSpendLedger(path);
    expect(upgraded.get(row.id)).toMatchObject({ state: "signed", unprovable: false });
    expect(upgraded.markUnprovable(row.id)).toBe(true);
    expect(upgraded.get(row.id)).toMatchObject({ state: "settled", settledAmount: 7n, unprovable: true });
    upgraded.close();
    const check = new DatabaseSync(path);
    expect(check.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    check.close();
  });

  it("refuses to open a ledger written by a newer version or an unreadable file", () => {
    const path = join(scratch, "newer.sqlite");
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA user_version = 99");
    raw.close();
    expect(() => new SqliteSpendLedger(path)).toThrow(
      expect.objectContaining({ code: "payment_ledger_unavailable" }),
    );
    expect(() => new SqliteSpendLedger(join(scratch, "persist.sqlite", "nested.sqlite"))).toThrow(
      expect.objectContaining({ code: "payment_ledger_unavailable" }),
    );
  });

  it("uses the XDG state directory by default", () => {
    expect(defaultLedgerPath({ XDG_STATE_HOME: "/var/lib/me" })).toBe("/var/lib/me/rail402/ledger.sqlite");
    expect(defaultLedgerPath({ XDG_STATE_HOME: "relative" })).toMatch(
      /\.local\/state\/rail402\/ledger\.sqlite$/,
    );
  });

  it("never lets four processes sharing one window exceed its budget", { timeout: 60_000 }, async () => {
    const path = join(scratch, "shared.sqlite");
    const payer = Keypair.random().publicKey();
    new SqliteSpendLedger(path).close();
    const startAt = Date.now() + 1_500;
    const outputs = await Promise.all(
      Array.from({ length: 4 }, () =>
        run(
          process.execPath,
          [
            "--conditions=@rail402/source",
            "--no-warnings",
            worker,
            path,
            payer,
            "40",
            "10",
            "250",
            String(startAt),
          ],
          {
            timeout: 50_000,
          },
        ),
      ),
    );
    const results = outputs.map(({ stdout }) => JSON.parse(stdout) as { reserved: number; refused: number });
    const reserved = results.reduce((sum, result) => sum + result.reserved, 0);
    const refused = results.reduce((sum, result) => sum + result.refused, 0);
    expect(reserved).toBe(25);
    expect(refused).toBe(4 * 40 - 25);

    const ledger = new SqliteSpendLedger(path);
    expect(ledger.listWindows(TESTNET, payer)).toHaveLength(1);
    const window = ledger.window({
      ...spec(payer),
      caps: { [usdc]: { perCall: 10n, total: 250n, decimals: 7 } },
    });
    expect(ledger.usage(window.id).assets.get(usdc)).toEqual({ spent: 0n, pending: 250n });
    ledger.close();
  });
});
