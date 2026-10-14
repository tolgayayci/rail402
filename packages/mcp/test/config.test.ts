import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { PUBNET } from "@rail402.dev/stellar";
import { main, resolveMcpCommand } from "@rail402.dev/mcp";

const token = "k".repeat(43);
const key = { RAIL402_SECRET_KEY_FILE: "/keys/buyer.key" };

function refused(argv: string[], env: Record<string, string | undefined>, setting: string): void {
  expect(() => resolveMcpCommand(argv, env), `${argv.join(" ")} ${JSON.stringify(env)}`).toThrow(
    expect.objectContaining({ code: "payment_policy_invalid", details: { setting } }),
  );
}

describe("resolveMcpCommand", () => {
  it("serves stdio by default with the testnet defaults", () => {
    const command = resolveMcpCommand([], {});
    expect(command).toMatchObject({
      kind: "serve",
      config: { transport: { kind: "stdio" }, agent: { network: "stellar:testnet", key: undefined } },
    });
  });

  it("serves HTTP on loopback with a token, and removes the token from the environment", () => {
    const env: Record<string, string | undefined> = { ...key, RAIL402_MCP_TOKEN: token };
    const command = resolveMcpCommand(["--http", "--port", "0"], env);
    expect(command).toMatchObject({
      kind: "serve",
      config: {
        transport: {
          kind: "http",
          host: "127.0.0.1",
          port: 0,
          token,
          allowedHosts: ["localhost", "127.0.0.1", "[::1]"],
          allowedOrigins: ["localhost", "127.0.0.1", "[::1]"],
        },
      },
    });
    expect(env["RAIL402_MCP_TOKEN"]).toBeUndefined();
    expect(resolveMcpCommand(["--http"], {})).toMatchObject({
      config: { transport: { port: 3402, token: undefined } },
    });
    expect(
      resolveMcpCommand(["--http", "--host", "::1"], {
        RAIL402_MCP_ALLOWED_ORIGINS: "https://app.example:8443, localhost",
      }),
    ).toMatchObject({ config: { transport: { host: "::1", allowedOrigins: ["app.example", "localhost"] } } });
  });

  it("answers --help and --version without reading the configuration", () => {
    expect(resolveMcpCommand(["--help"], { RAIL402_NETWORK: "bogus" })).toEqual({ kind: "help" });
    expect(resolveMcpCommand(["-v"], { RAIL402_NETWORK: "bogus" })).toEqual({ kind: "version" });
  });

  it("refuses unsafe or malformed transport settings", () => {
    refused(["--http", "--host", "0.0.0.0"], {}, "--host");
    refused(["--http", "--host", "192.168.1.10"], {}, "--host");
    refused(["--http", "--port", "70000"], {}, "--port");
    refused(["--port", "3402"], {}, "--http");
    refused(["--http"], { ...key }, "RAIL402_MCP_TOKEN");
    refused(["--http"], { ...key, RAIL402_MCP_TOKEN: "short" }, "RAIL402_MCP_TOKEN");
    refused(["--http"], { RAIL402_MCP_TOKEN: `${"k".repeat(43)} spaces` }, "RAIL402_MCP_TOKEN");
    refused(["--http"], { RAIL402_MCP_ALLOWED_ORIGINS: "http://" }, "RAIL402_MCP_ALLOWED_ORIGINS");
    refused(["--secret", "S..."], {}, "argv");
    refused(["extra"], {}, "argv");
  });

  it("fails on pubnet without explicit endpoints, or with a key but no caps", () => {
    const endpoints = {
      RAIL402_RPC_URL: "https://rpc.example",
      RAIL402_BAZAAR_URL: "https://bazaar.example",
    };
    refused([], { RAIL402_NETWORK: PUBNET }, "RAIL402_RPC_URL");
    refused([], { RAIL402_NETWORK: PUBNET, RAIL402_RPC_URL: "https://rpc.example" }, "RAIL402_BAZAAR_URL");
    refused([], { RAIL402_NETWORK: PUBNET, ...endpoints, ...key }, "RAIL402_MAX_PER_CALL");
    expect(
      resolveMcpCommand([], {
        RAIL402_NETWORK: PUBNET,
        ...endpoints,
        ...key,
        RAIL402_MAX_PER_CALL: "0.05 USDC",
        RAIL402_MAX_TOTAL: "0.50 USDC",
      }),
    ).toMatchObject({ kind: "serve", config: { agent: { network: PUBNET } } });
    // Search-only on pubnet needs no caps.
    expect(resolveMcpCommand([], { RAIL402_NETWORK: PUBNET, ...endpoints })).toMatchObject({ kind: "serve" });
  });
});

describe("main", () => {
  const directory = mkdtempSync(join(tmpdir(), "rail402-mcp-"));
  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("exits 1 with a coded line on stderr, never echoing the key, when startup fails", async () => {
    const path = join(directory, "loose.key");
    const seed = Keypair.random().secret();
    writeFileSync(path, seed, { mode: 0o644 });
    const written: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string) => {
      written.push(chunk);
      return true;
    };
    try {
      expect(await main([], { RAIL402_SECRET_KEY_FILE: path, RAIL402_BUDGET_STORE: "memory" })).toBe(1);
      expect(await main(["--http", "--host", "0.0.0.0"], {})).toBe(1);
    } finally {
      process.stderr.write = write;
    }
    const lines = written.map((line) => JSON.parse(line) as { error: { code: string; reason: string } });
    expect(lines.map((line) => line.error.code)).toEqual(["key_file_insecure", "payment_policy_invalid"]);
    expect(written.join("")).not.toContain(seed);
  });
});
