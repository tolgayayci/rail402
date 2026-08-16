import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveConfig,
  loadConfigFile,
  saveConfigValue,
  isConfigKey,
  DEFAULTS,
  configFilePath,
} from "./config.js";

describe("resolveConfig", () => {
  it("defaults to Rail402 hosted testnet infrastructure", () => {
    const c = resolveConfig({}, {}, {});
    expect(c.facilitatorUrl).toBe(DEFAULTS.facilitatorUrl);
    expect(c.explorerUrl).toBe(DEFAULTS.explorerUrl);
    expect(c.explorerWebUrl).toBe(DEFAULTS.explorerWebUrl);
    expect(c.network).toBe("stellar:testnet");
    expect(c.secret).toBeUndefined();
  });

  it("honours precedence: flag > env > file > default", () => {
    const file = { facilitatorUrl: "https://file.example" };
    const env = { RAIL402_FACILITATOR_URL: "https://env.example" } as NodeJS.ProcessEnv;
    expect(resolveConfig({}, {}, file).facilitatorUrl).toBe("https://file.example");
    expect(resolveConfig({}, env, file).facilitatorUrl).toBe("https://env.example");
    expect(resolveConfig({ facilitator: "https://flag.example" }, env, file).facilitatorUrl).toBe(
      "https://flag.example",
    );
  });

  it("resolves the secret from flag, env, or file", () => {
    expect(resolveConfig({ secret: "SFLAG" }, {}, {}).secret).toBe("SFLAG");
    expect(resolveConfig({}, { RAIL402_SECRET: "SENV" } as NodeJS.ProcessEnv, {}).secret).toBe("SENV");
    expect(resolveConfig({}, {}, { secret: "SFILE" }).secret).toBe("SFILE");
  });

  it("strips trailing slashes from URLs", () => {
    const c = resolveConfig({ facilitator: "https://x.example/", explorer: "https://y.example///" }, {}, {});
    expect(c.facilitatorUrl).toBe("https://x.example");
    expect(c.explorerUrl).toBe("https://y.example");
  });

  it("lets a self-hosted explorer override the default", () => {
    const c = resolveConfig(
      { explorer: "https://my-explorer.internal", explorerWeb: "https://my-explorer.web" },
      {},
      {},
    );
    expect(c.explorerUrl).toBe("https://my-explorer.internal");
    expect(c.explorerWebUrl).toBe("https://my-explorer.web");
  });
});

describe("config file", () => {
  it("round-trips through save and load", () => {
    const home = mkdtempSync(join(tmpdir(), "rail402-cfg-"));
    try {
      expect(loadConfigFile(home)).toEqual({});
      const path = saveConfigValue("network", "stellar:testnet", home);
      expect(path).toBe(configFilePath(home));
      saveConfigValue("facilitatorUrl", "https://saved.example", home);
      const loaded = loadConfigFile(home);
      expect(loaded.network).toBe("stellar:testnet");
      expect(loaded.facilitatorUrl).toBe("https://saved.example");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("isConfigKey", () => {
  it("accepts known keys and rejects the rest", () => {
    expect(isConfigKey("facilitatorUrl")).toBe(true);
    expect(isConfigKey("secret")).toBe(true);
    expect(isConfigKey("nope")).toBe(false);
    expect(isConfigKey("__proto__")).toBe(false);
  });
});
