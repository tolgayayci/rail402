import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  NPM_INSTALL_FLAGS,
  passesThrough,
  suiteEnvironment,
  toolchainEnvironment,
} from "../src/upstream-e2e-env.ts";

const parent = {
  PATH: "/usr/bin",
  HOME: "/home/operator",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  NODE_OPTIONS: "--max-old-space-size=4096",
  PNPM_HOME: "/home/operator/.pnpm",
  npm_config_registry: "https://registry.npmjs.org/",
  RAIL402_TREASURY_SECRET_FILE: "/secrets/treasury",
  RAIL402_SPONSOR_SECRET_FILE: "/secrets/sponsor",
  RAIL402_FACILITATOR_API_KEY_FILE: "/secrets/key",
  RAIL402_PUBNET_RUN_CONFIRM: "0123456789abcdef",
  RAIL402_PUBNET_LEDGER: "/repo/.work/pubnet-runs/x/ledger.json",
  RAIL402_PUBNET_RPC_URLS: "https://rpc.example/key-in-path",
  GITHUB_TOKEN: "ghp_x",
  NODE_AUTH_TOKEN: "npm_x",
  npm_config__authToken: "npm_y",
  AWS_SECRET_ACCESS_KEY: "aws",
  TESTNET_SPONSOR_SECRET: "S…",
  API_KEY: "k",
  DATABASE_URL: "postgres://user:password@db/rail402",
};

describe("the upstream suite's environment", () => {
  it("passes only an allow-listed toolchain environment and the suite's own variables", () => {
    const env = suiteEnvironment(parent, {
      RAIL402_ROOT: "/repo",
      CLIENT_STELLAR_PRIVATE_KEY: "S-run-scoped",
      STELLAR_RPC_URL: "https://rpc.example",
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/operator",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      NODE_OPTIONS: "--max-old-space-size=4096",
      PNPM_HOME: "/home/operator/.pnpm",
      npm_config_registry: "https://registry.npmjs.org/",
      RAIL402_ROOT: "/repo",
      CLIENT_STELLAR_PRIVATE_KEY: "S-run-scoped",
      STELLAR_RPC_URL: "https://rpc.example",
    });
  });

  it("never passes a secret-ish variable of this process, whatever prefix it has", () => {
    const env = suiteEnvironment(parent, {});
    const secretish = /SECRET|PRIVATE|TOKEN|PASSWORD|KEY|CONFIRM|LEDGER|DATABASE|RAIL402_/i;
    expect(Object.keys(env).filter((name) => secretish.test(name))).toEqual([]);
    for (const name of [
      "NODE_AUTH_TOKEN",
      "npm_config__authToken",
      "PNPM_SECRET",
      "NODE_PRIVATE_KEY",
      "LC_KEY",
    ]) {
      expect(passesThrough(name), name).toBe(false);
    }
  });

  it("refuses a suite variable nobody reviewed", () => {
    expect(() => suiteEnvironment(parent, { RAIL402_TREASURY_SECRET_FILE: "/secrets/treasury" })).toThrow(
      /not a suite variable/,
    );
  });
});

describe("third-party installs", () => {
  const dir = mkdtempSync(join(tmpdir(), "rail402-third-party-"));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("keep only the toolchain variables of this process, never a secret's", () => {
    expect(toolchainEnvironment(parent)).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/operator",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      NODE_OPTIONS: "--max-old-space-size=4096",
      PNPM_HOME: "/home/operator/.pnpm",
      npm_config_registry: "https://registry.npmjs.org/",
    });
  });

  it("run no dependency's install script", () => {
    // A package whose dependency has a postinstall script, both as local tarballs: npm stays offline.
    const marker = join(dir, "postinstall-ran");
    const write = (name: string, manifest: Record<string, unknown>, files: Record<string, string>) => {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, "package.json"), JSON.stringify({ name, version: "1.0.0", ...manifest }));
      for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, name, file), text);
    };
    write(
      "stand-in-dependency",
      { scripts: { postinstall: "node postinstall.js" } },
      {
        "postinstall.js": `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");`,
        "index.js": "module.exports = 1;",
      },
    );
    write("stand-in-package", { dependencies: { "stand-in-dependency": "1.0.0" } }, { "index.js": "" });
    const npmEnv = toolchainEnvironment({
      ...parent,
      PATH: process.env["PATH"] ?? "",
      HOME: dir,
      npm_config_cache: join(dir, "cache"),
      npm_config_offline: "true",
    });
    const npm = (args: readonly string[], cwd: string) => {
      const result = spawnSync("npm", args, { cwd, env: npmEnv, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    };
    mkdirSync(join(dir, "tarballs"));
    for (const name of ["stand-in-dependency", "stand-in-package"]) {
      npm(["pack", "--pack-destination", join(dir, "tarballs")], join(dir, name));
    }
    mkdirSync(join(dir, "project"));
    writeFileSync(join(dir, "project", "package.json"), JSON.stringify({ name: "consumer", private: true }));
    npm(
      [
        "install",
        ...NPM_INSTALL_FLAGS,
        join(dir, "tarballs/stand-in-dependency-1.0.0.tgz"),
        join(dir, "tarballs/stand-in-package-1.0.0.tgz"),
      ],
      join(dir, "project"),
    );
    expect(existsSync(join(dir, "project/node_modules/stand-in-dependency/postinstall.js"))).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });
});
