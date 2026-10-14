import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { operatorAccount } from "../src/testnet.ts";

describe("operatorAccount", () => {
  const directory = mkdtempSync(join(tmpdir(), "operator-account-"));
  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const sponsor = Keypair.random();
  const file = join(directory, "sponsor");
  writeFileSync(file, `${sponsor.secret()}\n`, { mode: 0o600 });

  it("derives the same account from the same sponsor and label, and another for another label", () => {
    const first = operatorAccount("second seller", file);
    expect(first.origin).toBe("derived");
    expect(operatorAccount("second seller", file).keypair.publicKey()).toBe(first.keypair.publicKey());
    expect(operatorAccount("hosted seller", file).keypair.publicKey()).not.toBe(first.keypair.publicKey());
    expect(first.keypair.publicKey()).not.toBe(sponsor.publicKey());
  });

  it("depends on the sponsor seed, so a public label alone does not give the key", () => {
    const other = join(directory, "other");
    writeFileSync(other, Keypair.random().secret(), { mode: 0o600 });
    expect(operatorAccount("second seller", other).keypair.publicKey()).not.toBe(
      operatorAccount("second seller", file).keypair.publicKey(),
    );
  });

  it("is a fresh account without a seed file", () => {
    const fresh = operatorAccount("second seller", "");
    expect(fresh.origin).toBe("fresh");
    expect(fresh.keypair.publicKey()).not.toBe(operatorAccount("second seller", "").keypair.publicKey());
  });
});
