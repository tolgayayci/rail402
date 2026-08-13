import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { X402Error } from "@rail402/errors";
import { loadConfig, describeConfig } from "./env.js";

const SECRET = Keypair.random().secret();
const SECRET_2 = Keypair.random().secret();
const env = (o: Record<string, string | undefined> = {}) =>
  ({ FACILITATOR_STELLAR_SECRET: SECRET, ...o }) as NodeJS.ProcessEnv;

/** Assert loadConfig throws a specific coded error rather than a bare Error. */
const expectCode = (e: Record<string, string | undefined>, code: string, match?: RegExp) => {
  try {
    loadConfig(env(e));
    throw new Error("expected loadConfig to throw");
  } catch (err) {
    expect(err, "must be a coded X402Error").toBeInstanceOf(X402Error);
    const x = err as X402Error;
    expect(x.code).toBe(code);
    expect(x.reason.trim().length).toBeGreaterThan(20);
    if (match) expect(x.reason).toMatch(match);
  }
};

describe("defaults make testnet free and frictionless", () => {
  // A fresh deployment with only a secret must yield a working, open testnet facilitator.
  it("needs nothing but a signer secret", () => {
    const c = loadConfig(env());
    expect(c.networks.map(n => n.network)).toEqual(["stellar:testnet"]);
    expect(c.apiKeys).toEqual([]);
    expect(c.areFeesSponsored).toBe(true);
  });

  it("hard-wires no fee anywhere", () => {
    // Hard rule: any mainnet fee must be configuration a self-hoster
    // can change or remove. There is deliberately no fee field with a non-zero default.
    const c = loadConfig(env()) as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(c)) {
      if (/fee/i.test(key) && typeof value === "number") {
        // Only the safety ceiling is numeric, and it is a circuit breaker, not a price.
        expect(key).toBe("maxTransactionFeeStroops");
      }
    }
  });

  it("defaults the fee ceiling above the library's known-too-low 50,000", () => {
    // Stellar's own reference facilitator documents real Soroban resource fees exceeding 50,000.
    expect(loadConfig(env()).maxTransactionFeeStroops).toBeGreaterThan(50_000);
  });
});

describe("fails fast at startup, never at first payment", () => {
  it("refuses pubnet without an RPC URL", () => {
    // @x402/stellar's getRpcUrl() throws lazily for pubnet; as a runtime error that would surface
    // as a 500 on a real payment. Catch it before the port is bound.
    expectCode(
      { STELLAR_NETWORKS: "stellar:pubnet" },
      "config_network_rpc_missing",
      /STELLAR_PUBNET_RPC_URL/,
    );
  });

  it("accepts pubnet once an RPC URL is supplied", () => {
    const c = loadConfig(
      env({ STELLAR_NETWORKS: "stellar:pubnet", STELLAR_PUBNET_RPC_URL: "https://rpc.example" }),
    );
    expect(c.networks).toEqual([
      { network: "stellar:pubnet", rpcUrl: "https://rpc.example" },
    ]);
  });

  it("rejects unknown networks by name", () => {
    expectCode({ STELLAR_NETWORKS: "stellar:futurenet" }, "config_network_rpc_missing", /futurenet/);
  });

  it("rejects an empty network list", () => {
    expectCode({ STELLAR_NETWORKS: " " }, "config_network_rpc_missing");
  });

  it("requires at least one signer", () => {
    try {
      loadConfig({ STELLAR_NETWORKS: "stellar:testnet" } as NodeJS.ProcessEnv);
      throw new Error("expected throw");
    } catch (err) {
      expect((err as X402Error).code).toBe("config_no_signer");
    }
  });

  it("rejects a malformed signer secret without echoing it", () => {
    const bogus = "SNOTAREALSECRETKEYATALL";
    try {
      loadConfig({ FACILITATOR_STELLAR_SECRET: bogus } as NodeJS.ProcessEnv);
      throw new Error("expected throw");
    } catch (err) {
      const x = err as X402Error;
      // No secrets in logs. The reason must not contain the value.
      expect(x.reason).not.toContain(bogus);
    }
  });

  it("rejects duplicate channel secrets, which would share a sequence number", () => {
    expectCode(
      { FACILITATOR_STELLAR_CHANNEL_SECRETS: SECRET },
      "config_no_signer",
      /sequence number/i,
    );
  });

  it("refuses to advertise sponsorship it does not perform", () => {
    // areFeesSponsored must reflect actual runtime behaviour.
    expectCode({ FEES_SPONSORED: "false" }, "config_fee_sponsorship_mismatch", /false advertising/i);
  });
});

describe("throughput configuration", () => {
  it("accepts a channel-account pool alongside the primary signer", () => {
    const c = loadConfig(env({ FACILITATOR_STELLAR_CHANNEL_SECRETS: SECRET_2 }));
    expect(c.signerSecrets).toHaveLength(2);
  });

  it("accepts a distinct fee-bump source", () => {
    const c = loadConfig(env({ FACILITATOR_STELLAR_FEE_BUMP_SECRET: SECRET_2 }));
    expect(c.feeBumpSecret).toBe(SECRET_2);
  });

  it("rejects an invalid fee-bump secret", () => {
    expectCode({ FACILITATOR_STELLAR_FEE_BUMP_SECRET: "nope" }, "config_network_rpc_missing");
  });
});

describe("describeConfig", () => {
  it("never leaks a secret", () => {
    const described = JSON.stringify(
      describeConfig(loadConfig(env({ FACILITATOR_STELLAR_FEE_BUMP_SECRET: SECRET_2 }))),
    );
    expect(described).not.toContain(SECRET);
    expect(described).not.toContain(SECRET_2);
    expect(described).toContain("signerCount");
  });

  it("reports auth as open when no keys are set", () => {
    expect(describeConfig(loadConfig(env())).auth).toBe("open");
  });
});
