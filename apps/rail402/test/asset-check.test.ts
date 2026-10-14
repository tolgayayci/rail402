import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import type { TokenContract } from "@rail402.dev/stellar";
import { ConfigError, checkAssets, loadConfig, type NetworkConfig } from "@rail402.dev/service";
import { randomContractId } from "@rail402.dev/testkit";

const usdc = randomContractId();
const test6 = randomContractId();

function network(assets: string): NetworkConfig {
  const config = loadConfig({
    STORE: "memory",
    TESTNET_RPC_URL: "https://soroban-testnet.stellar.org",
    TESTNET_SPONSOR_SECRET: Keypair.random().secret(),
    TESTNET_ASSETS: assets,
  });
  const [testnet] = config.networks;
  if (testnet === undefined) throw new Error("no testnet");
  return testnet;
}

/** A directory that answers from a table, or fails like an unreachable RPC. */
const directory = (answers: Record<string, TokenContract | Error>) => ({
  inspect: (contract: string) => {
    const answer = answers[contract];
    if (answer === undefined) return Promise.resolve({ found: false } as const);
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  },
});

describe("checkAssets", () => {
  const configured = network(`${usdc}:USDC:7,${test6}:TEST6:6`);

  it("passes when every token is deployed with the configured decimals, and learns its kind", async () => {
    const check = await checkAssets(
      configured,
      directory({
        [usdc]: { found: true, kind: "sac", decimals: 7 },
        [test6]: { found: true, kind: "sep41", decimals: 6 },
      }),
    );
    expect(check).toEqual({
      ok: true,
      detail: "USDC:7, TEST6:6",
      kinds: new Map([
        [usdc, "sac"],
        [test6, "sep41"],
      ]),
    });
  });

  it("fails for good, with a coded ConfigError naming the variable, when the decimals differ", async () => {
    const check = await checkAssets(
      configured,
      directory({
        [usdc]: { found: true, kind: "sac", decimals: 7 },
        [test6]: { found: true, kind: "sep41", decimals: 18 },
      }),
    );
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.error).toBeInstanceOf(ConfigError);
    expect(check.error?.code).toBe("asset_decimals_mismatch");
    expect(check.error?.message).toBe(
      `TESTNET_ASSETS: TEST6 (${test6}) has 18 decimals on stellar:testnet, but 6 are configured`,
    );
    expect(check.detail).toBe(check.error?.message);
  });

  it("fails for good when a contract does not answer decimals()", async () => {
    const check = await checkAssets(
      configured,
      directory({
        [usdc]: { found: true, kind: "sac", decimals: 7 },
        [test6]: { found: true, kind: "sep41", decimals: undefined },
      }),
    );
    expect(check.ok ? undefined : check.error?.code).toBe("asset_not_a_token");
  });

  it("stays retryable while a contract is not deployed or the RPC fails", async () => {
    const missing = await checkAssets(
      configured,
      directory({ [usdc]: { found: true, kind: "sac", decimals: 7 } }),
    );
    expect(missing).toEqual({ ok: false, detail: `TEST6 (${test6}) is not deployed on stellar:testnet` });

    const unreachable = await checkAssets(
      configured,
      directory({ [usdc]: new Error("connect ECONNREFUSED") }),
    );
    expect(unreachable).toEqual({
      ok: false,
      detail: `could not read USDC (${usdc}): connection refused (details in the service log)`,
    });
  });

  it("names the default USDC asset's variable too", () => {
    const defaults = loadConfig({
      STORE: "memory",
      TESTNET_RPC_URL: "https://soroban-testnet.stellar.org",
      TESTNET_SPONSOR_SECRET: Keypair.random().secret(),
    });
    expect(defaults.networks[0]?.assetsVariable).toBe("TESTNET_ASSETS");
  });
});
