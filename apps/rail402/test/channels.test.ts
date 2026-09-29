/**
 * The channels operator command's argument and safety checks. Each case fails before any RPC call, so
 * the RPC URL points nowhere; channels.integration.test.ts covers the commands against a network.
 */
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { channels } from "./channels-cli.ts";

const env = {
  STORE: "memory",
  TESTNET_RPC_URL: "http://127.0.0.1:1/rpc",
  TESTNET_SPONSOR_SECRET: Keypair.random().secret(),
};

describe("channels command", () => {
  it.each([
    ["no command", []],
    ["an unknown command", ["drain"]],
    ["two commands", ["status", "retire"]],
  ])("answers %s with usage and exit code 64", async (_label, args) => {
    const result = await channels(args, env);
    expect(result.code).toBe(64);
    expect(result.stderr).toContain(
      "usage: channels <status|provision|retire> [--network …] [--count N] [--force]",
    );
    expect(result.stdout).toBe("");
  });

  it.each(["0", "1001", "2.5", "many"])("refuses --count %s", async (count) => {
    const result = await channels(["status", "--count", count], env);
    expect(result.code).toBe(64);
    expect(result.stderr).toContain("--count must be an integer between 1 and 1000");
  });

  it("refuses a --network that is not configured", async () => {
    const result = await channels(["status", "--network", "stellar:pubnet"], env);
    expect(result.code).toBe(64);
    expect(result.stderr).toContain("network stellar:pubnet is not configured");
  });

  it("exits with 78 on invalid configuration", async () => {
    const result = await channels(["status"], { STORE: "memory" });
    expect(result.code).toBe(78);
    expect(result.stderr).toContain("TESTNET_RPC_URL");
  });

  it("requires --force to retire with STORE=memory", async () => {
    const result = await channels(["retire"], env);
    expect(result.code).toBe(64);
    expect(result.stderr).toContain(
      "STORE=memory cannot show whether settlements are in flight; stop the service and pass --force",
    );
    expect(result.stdout).toBe("");
  });
});
