import type * as fs from "node:fs";
import { mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AccessKeys,
  newAccessKey,
  parseAccessKeys,
  presentedKey,
  type AccessKeyRules,
} from "../src/access.ts";

// Runs a hook once the key file has been read and closed, to replace it at that exact moment.
const reads = vi.hoisted(() => ({ hook: undefined as (() => void) | undefined }));
vi.mock("node:fs", async (load) => {
  const actual = await load<typeof fs>();
  const closeSync = ((...args: Parameters<typeof actual.closeSync>) => {
    actual.closeSync(...args);
    const hook = reads.hook;
    reads.hook = undefined;
    hook?.();
  }) as typeof actual.closeSync;
  return { ...actual, closeSync, default: { ...actual, closeSync } };
});

const PUBNET = "stellar:pubnet";
const rules: AccessKeyRules = {
  networks: ["stellar:testnet", PUBNET],
  futureNetworks: false,
  maxLifetimeDays: 400,
  max: 1_000,
};
const holder = newAccessKey("acme-prod-1");
const keyFile = (revoked: boolean) =>
  JSON.stringify({
    schemaVersion: 1,
    keys: [
      {
        id: "acme-prod-1",
        sha256: holder.sha256,
        networks: [PUBNET],
        sponsorBudgetXlmPerHour: "2",
        expiresAt: "2099-01-01T00:00:00Z",
        createdAt: "2098-06-01T00:00:00Z",
        revoked,
      },
    ],
  });

afterEach(() => {
  reads.hook = undefined;
});

describe("reloading a key file that is replaced while a broken one is being read", () => {
  it("applies the good file on the next reload instead of remembering it as seen", () => {
    const directory = mkdtempSync(join(tmpdir(), "rail402-keys-"));
    const path = join(directory, "keys.json");
    const replace = (text: string) => {
      writeFileSync(`${path}.new`, text, { mode: 0o600 });
      renameSync(`${path}.new`, path);
    };
    writeFileSync(path, keyFile(false), { mode: 0o600 });
    const keys = new AccessKeys(parseAccessKeys(keyFile(false), rules), {
      path,
      source: "API_KEYS_DIR",
      rules,
    });
    const decide = () => keys.decide(presentedKey(undefined, holder.key), PUBNET, true).kind;
    expect(decide()).toBe("served");

    replace("{");
    // The revocation lands right after the broken file was read, before the reload has finished.
    reads.hook = () => {
      replace(keyFile(true));
    };
    expect(keys.reload()).toBe(false);
    expect(keys.status().reloadError).toMatch(/^config_access_keys_invalid: API_KEYS_DIR: /);
    expect(reads.hook).toBeUndefined();

    expect(keys.reload()).toBe(true);
    expect(decide()).toBe("unauthorized");
    expect(keys.status()).toMatchObject({ keys: { active: 0, expired: 0, revoked: 1 }, reloadError: null });
  });
});
