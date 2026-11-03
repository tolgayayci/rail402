import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { ConfigError, configFailureLine, loadConfig } from "@rail402.dev/service";
import { COLD_SIGNER, secretFile, sponsorKeyFile } from "./secret-fixtures.ts";

const PUBNET_USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const DATABASE_URL = "postgres://rail402:s3cr3t-password@localhost:5432/rail402";
const testnetSeed = Keypair.random().secret();
const pubnetSeed = Keypair.random().secret();

const testnet = { TESTNET_RPC_URL: "https://soroban-testnet.stellar.org" };
/** Testnet and pubnet with every secret in a file. */
const pubnet = {
  ...testnet,
  NETWORKS: "stellar:testnet,stellar:pubnet",
  DATABASE_URL_FILE: secretFile(DATABASE_URL),
  TESTNET_SPONSOR_SECRET: testnetSeed,
  METRICS_PRIVATE_TOKEN_SHA256: "c0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff",
  PUBNET_RPC_SINGLE_PROVIDER: "true",
  PUBNET_RPC_URL: "https://mainnet.sorobanrpc.com",
  PUBNET_SPONSOR_SECRET_FILE: sponsorKeyFile(pubnetSeed),
  PUBNET_SPONSOR_COLD_SIGNER: COLD_SIGNER,
  PUBNET_REQUIRE_API_KEY: "false",
  PUBNET_RATE_LIMIT_PER_MINUTE: "60",
  PUBNET_KEYLESS_SPONSOR_BUDGET_XLM_PER_HOUR: "1",
  PUBNET_MAX_SPONSOR_SPEND_XLM_PER_HOUR: "10",
  PUBNET_MAX_TX_FEE_STROOPS: "300000",
  PUBNET_INCLUSION_FEE_STROOPS: "200",
  PUBNET_ASSETS: `${PUBNET_USDC}:USDC:7:10000`,
};

function refusal(env: Record<string, string>): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }
  throw new Error("the configuration was accepted");
}

describe("secrets from files", () => {
  it("reads every secret from its file, trimmed", () => {
    const cursor = "ab".repeat(32);
    const config = loadConfig({ ...pubnet, SEARCH_CURSOR_SECRET_FILE: secretFile(`${cursor}\n`) });
    expect(config.store).toEqual({ kind: "postgres", url: DATABASE_URL, acquireTimeoutMs: 5_000 });
    expect(config.search.cursorSecret?.toString("hex")).toBe(cursor);
    expect(config.networks.map((network) => network.sponsorSecret)).toEqual([testnetSeed, pubnetSeed]);
  });

  it("reads testnet secrets from files too, with or without a testnet tag", () => {
    const untagged = loadConfig({
      ...testnet,
      STORE: "memory",
      TESTNET_SPONSOR_SECRET_FILE: secretFile(testnetSeed),
    });
    expect(untagged.networks[0]?.sponsorSecret).toBe(testnetSeed);
    const tagged = loadConfig({
      ...testnet,
      STORE: "memory",
      TESTNET_SPONSOR_SECRET_FILE: sponsorKeyFile(testnetSeed, "stellar:testnet", 0o440),
    });
    expect(tagged.networks[0]?.sponsorSecret).toBe(testnetSeed);
  });

  it.each([
    ["PUBNET_SPONSOR_SECRET", pubnetSeed],
    ["DATABASE_URL", DATABASE_URL],
    ["SEARCH_CURSOR_SECRET", "ab".repeat(32)],
    ["DATABASE_MIGRATION_URL", "postgres://owner:0wner-pass@localhost:5432/rail402"],
  ])("refuses %s from the environment when pubnet is enabled", (name, value) => {
    const env = Object.fromEntries(
      Object.entries({ ...pubnet, [name]: value }).filter(([key]) => key !== `${name}_FILE`),
    );
    const error = refusal(env);
    expect(error.code).toBe("config_secret_in_env");
    expect(error.message).toContain(`${name}_FILE`);
    expect(error.message).not.toContain(value);
  });

  it("refuses a pubnet sponsor secret from the environment", () => {
    const { PUBNET_SPONSOR_SECRET_FILE: _file, ...env } = pubnet;
    expect(refusal({ ...env, PUBNET_SPONSOR_SECRET: pubnetSeed }).code).toBe("config_secret_in_env");
  });

  it("refuses a variable set both directly and as a file", () => {
    const error = refusal({
      ...testnet,
      STORE: "memory",
      TESTNET_SPONSOR_SECRET: testnetSeed,
      TESTNET_SPONSOR_SECRET_FILE: secretFile(testnetSeed),
    });
    expect(error.code).toBe("config_secret_conflict");
  });

  it("refuses a secret file readable by group or others", () => {
    // A pubnet seed file is readable by its owner only: 0400 or 0600.
    for (const mode of [0o404, 0o444, 0o440, 0o640, 0o604]) {
      const error = refusal({
        ...pubnet,
        PUBNET_SPONSOR_SECRET_FILE: sponsorKeyFile(pubnetSeed, "stellar:pubnet", mode),
        PUBNET_SPONSOR_COLD_SIGNER: COLD_SIGNER,
      });
      expect(error.code, mode.toString(8)).toBe("config_secret_file_insecure");
    }
    // Writable by the group or others is refused for every secret.
    for (const mode of [0o420, 0o402, 0o660]) {
      const error = refusal({ ...pubnet, DATABASE_URL_FILE: secretFile(DATABASE_URL, mode) });
      expect(error.code, mode.toString(8)).toBe("config_secret_file_insecure");
    }
    for (const mode of [0o400, 0o600]) {
      expect(
        loadConfig({
          ...pubnet,
          PUBNET_SPONSOR_SECRET_FILE: sponsorKeyFile(pubnetSeed, "stellar:pubnet", mode),
        }).networks.some((network) => network.network === "stellar:pubnet"),
      ).toBe(true);
    }
    // So is the previous sponsor's seed kept for an authority rotation.
    expect(
      refusal({
        ...pubnet,
        PUBNET_PREVIOUS_SPONSOR_SECRET_FILE: sponsorKeyFile(
          Keypair.random().secret(),
          "stellar:pubnet",
          0o440,
        ),
      }).code,
    ).toBe("config_secret_file_insecure");
    // Readable by the group is fine for a database URL (a mounted secret is often group-readable).
    expect(loadConfig({ ...pubnet, DATABASE_URL_FILE: secretFile(DATABASE_URL, 0o440) }).store.kind).toBe(
      "postgres",
    );
  });

  it("refuses database and cursor secret files readable by others when pubnet is enabled", () => {
    for (const [name, value] of [
      ["DATABASE_URL", DATABASE_URL],
      ["SEARCH_CURSOR_SECRET", "ab".repeat(32)],
    ] as const) {
      for (const mode of [0o444, 0o404]) {
        const error = refusal({ ...pubnet, [`${name}_FILE`]: secretFile(value, mode) });
        expect(error.code, `${name} ${mode.toString(8)}`).toBe("config_secret_file_insecure");
        expect(error.message).toMatch(/readable by others/);
      }
    }
    // Testnet alone keeps accepting a world-readable database URL file.
    expect(
      loadConfig({
        ...testnet,
        TESTNET_SPONSOR_SECRET: testnetSeed,
        DATABASE_URL_FILE: secretFile(DATABASE_URL, 0o444),
      }).store.kind,
    ).toBe("postgres");
  });

  it("refuses pubnet RPC URLs with credentials in the environment, and takes them from the file", () => {
    for (const url of [
      "https://user:pass@rpc.example/soroban",
      "https://rpc.example/soroban?apikey=secret-key",
      "https://rpc.example/soroban#secret-key",
    ]) {
      const error = refusal({ ...pubnet, PUBNET_RPC_URL: url });
      expect(error.code, url).toBe("config_secret_in_env");
      expect(error.message).toContain("PUBNET_RPC_URLS_FILE");
      expect(error.message).not.toContain("secret-key");
      const { PUBNET_RPC_URL: _single, ...listed } = pubnet;
      expect(refusal({ ...listed, PUBNET_RPC_URLS: `a=${url}` }).code).toBe("config_secret_in_env");
      const fromFile = loadConfig({ ...listed, PUBNET_RPC_URLS_FILE: secretFile(`a=${url}`) });
      expect(fromFile.networks.find((network) => network.network === "stellar:pubnet")?.rpcUrl).toBe(url);
    }
  });

  it("refuses the schema owner's connection in the service process when pubnet is enabled", () => {
    const owner = "postgres://owner:0wner-pass@localhost:5432/rail402";
    for (const migrateOnStart of ["true", "false"]) {
      const error = refusal({
        ...pubnet,
        MIGRATE_ON_START: migrateOnStart,
        DATABASE_MIGRATION_URL_FILE: secretFile(owner),
      });
      expect(error.code).toBe("config_pubnet_migration_url_in_service");
      expect(error.message).not.toContain("0wner-pass");
    }
  });

  it("refuses a missing, relative, empty, oversized or non-regular secret file", () => {
    for (const path of [
      "/nonexistent/rail402/secret",
      "relative/secret",
      secretFile("   \n"),
      secretFile("x".repeat(5_000)),
      mkdtempSync(join(tmpdir(), "rail402-dir-")),
    ]) {
      const error = refusal({ ...pubnet, DATABASE_URL_FILE: path });
      expect(error.code, path).toBe("config_secret_file_unreadable");
      expect(error.message, path).toContain("DATABASE_URL_FILE");
    }
  });

  it("refuses a pubnet secret file tagged for testnet, or not tagged at all", () => {
    expect(
      refusal({ ...pubnet, PUBNET_SPONSOR_SECRET_FILE: sponsorKeyFile(pubnetSeed, "stellar:testnet") }).code,
    ).toBe("config_secret_network_mismatch");
    expect(refusal({ ...pubnet, PUBNET_SPONSOR_SECRET_FILE: secretFile(pubnetSeed) }).code).toBe(
      "config_secret_file_untagged",
    );
    // A pubnet-tagged seed is refused as the testnet sponsor too.
    expect(
      refusal({
        ...testnet,
        STORE: "memory",
        TESTNET_SPONSOR_SECRET_FILE: sponsorKeyFile(testnetSeed, "stellar:pubnet"),
      }).code,
    ).toBe("config_secret_network_mismatch");
  });

  it("never echoes a file secret in a startup error", () => {
    const badSeed = "SBADSEEDTHATISNOTVALIDATALLXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
    const error = refusal({ ...pubnet, PUBNET_SPONSOR_SECRET_FILE: sponsorKeyFile(badSeed) });
    expect(configFailureLine(error)).not.toContain(badSeed);
    expect(configFailureLine(error)).toContain("PUBNET_SPONSOR_SECRET");
    const insecure = refusal({ ...pubnet, DATABASE_URL_FILE: secretFile(DATABASE_URL, 0o666) });
    expect(configFailureLine(insecure)).not.toContain("s3cr3t-password");
  });
});
