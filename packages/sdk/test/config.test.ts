import { inspect } from "node:util";
import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { PUBNET, TESTNET } from "@rail402.dev/stellar";
import { randomContractId } from "@rail402.dev/testkit";
import { egressFromConfig, resolveAgentConfig, resolvePolicy } from "@rail402.dev/sdk";

describe("resolveAgentConfig", () => {
  it("defaults to testnet, the public testnet RPC and Bazaar, a SQLite budget and search-only mode", () => {
    const config = resolveAgentConfig({ XDG_STATE_HOME: "/state" });
    expect(config).toMatchObject({
      network: TESTNET,
      rpcUrl: "https://soroban-testnet.stellar.org",
      bazaarUrl: "https://testnet.rail402.dev",
      key: undefined,
      session: { name: "default", ttlMs: 86_400_000 },
      budgetStore: "sqlite",
      ledgerPath: "/state/rail402/ledger.sqlite",
      egress: { allowHttp: false, allowPrivateNetwork: false, ports: undefined },
      maxInflight: 1,
      explorer: "stellar.expert",
      logLevel: "info",
    });
    expect(config.policy).toEqual({ assets: [{ asset: "USDC" }] });
  });

  it("prefers a key file, expands ~/ and always removes the secret from the environment", () => {
    const seed = Keypair.random().secret();
    const env: Record<string, string | undefined> = {
      RAIL402_SECRET_KEY: seed,
      RAIL402_SECRET_KEY_FILE: "~/keys/buyer.key",
    };
    const config = resolveAgentConfig(env);
    expect(config.key).toEqual({ secretFile: `${homedir()}/keys/buyer.key` });
    expect(env["RAIL402_SECRET_KEY"]).toBeUndefined();
    const fromEnv = resolveAgentConfig({ RAIL402_SECRET_KEY: seed });
    expect(fromEnv.key !== undefined && "secret" in fromEnv.key ? fromEnv.key.secret : undefined).toBe(seed);
    // The configuration renders without the seed however it is printed.
    for (const text of [
      JSON.stringify(fromEnv),
      inspect(fromEnv, { depth: Infinity }),
      JSON.stringify({ ...fromEnv.key }),
    ]) {
      expect(text).not.toContain(seed);
    }
    expect(resolveAgentConfig({}, { keyFile: "/flag.key" }).key).toEqual({ secretFile: "/flag.key" });
  });

  it("maps caps, extra assets, recipients and trust onto the spending policy", async () => {
    const token = randomContractId();
    const seller = Keypair.random().publicKey();
    const config = resolveAgentConfig({
      RAIL402_ASSETS: `TEST6:${token}:6`,
      RAIL402_MAX_PER_CALL: "0.05 USDC, 2 TEST6",
      RAIL402_MAX_TOTAL: "0.50,10 TEST6",
      RAIL402_DENIED_RECIPIENTS: seller,
      RAIL402_REQUIRE_LISTING: "true",
      RAIL402_MIN_TRUST: "http=origin_verified,mcp=domain_verified",
      RAIL402_SESSION: "task-42",
      RAIL402_SESSION_TTL: "2h",
    });
    expect(config.policy).toEqual({
      assets: [
        { asset: "USDC", perCall: "0.05", sessionTotal: "0.50" },
        { asset: token, symbol: "TEST6", decimals: 6, perCall: "2", sessionTotal: "10" },
      ],
      recipients: { deny: [seller] },
      requireCatalogListing: true,
      minTrust: { http: "origin_verified", mcp: "domain_verified" },
    });
    expect(config.session).toEqual({ name: "task-42", ttlMs: 7_200_000 });
    const policy = await resolvePolicy(TESTNET, config.policy, {
      requireCaps: true,
      describe: () => Promise.resolve({ symbol: "TEST6", name: "TEST6:G", decimals: 6 }),
    });
    expect(policy.assets.map((asset) => [asset.symbol, asset.perCall])).toEqual([
      ["USDC", 500_000n],
      ["TEST6", 2_000_000n],
    ]);
  });

  it("maps the schemes, pinned upto contracts and allowed settlement authorities", async () => {
    const contract = randomContractId();
    const authority = Keypair.random().publicKey();
    const config = resolveAgentConfig({
      RAIL402_SCHEMES: "exact, upto",
      RAIL402_UPTO_CONTRACTS: contract,
      RAIL402_UPTO_FACILITATORS: authority,
    });
    expect(config.policy).toMatchObject({
      schemes: ["exact", "upto"],
      uptoContracts: [contract],
      uptoFacilitators: [authority],
    });
    const policy = await resolvePolicy(TESTNET, config.policy, { requireCaps: true });
    expect(policy.uptoContracts).toEqual([contract]);
    expect([...(policy.uptoFacilitators ?? [])]).toEqual([authority]);
    expect(resolveAgentConfig({ RAIL402_SCHEMES: "exact" }).policy.schemes).toEqual(["exact"]);
  });

  it("requires explicit endpoints and caps on pubnet and refuses the development switches there", () => {
    const pubnet = {
      RAIL402_NETWORK: PUBNET,
      RAIL402_RPC_URL: "https://rpc.example",
      RAIL402_BAZAAR_URL: "https://bazaar.example/",
    };
    expect(resolveAgentConfig({ ...pubnet })).toMatchObject({
      network: PUBNET,
      bazaarUrl: "https://bazaar.example",
    });
    expect(resolveAgentConfig({ ...pubnet, RAIL402_ALLOWED_PORTS: "443" }).network).toBe(PUBNET);
    const refusals: Record<string, string | undefined>[] = [
      { RAIL402_NETWORK: PUBNET, RAIL402_BAZAAR_URL: "https://bazaar.example" },
      { RAIL402_NETWORK: PUBNET, RAIL402_RPC_URL: "https://rpc.example" },
      { ...pubnet, RAIL402_RPC_URL: "http://rpc.example" },
      { ...pubnet, RAIL402_ALLOW_HTTP: "true" },
      { ...pubnet, RAIL402_ALLOW_PRIVATE_NETWORK: "loopback" },
      { ...pubnet, RAIL402_ALLOWED_PORTS: "22,6379,8443" },
      { ...pubnet, RAIL402_SECRET_KEY_FILE: "/k.key" },
      { ...pubnet, RAIL402_SECRET_KEY_FILE: "/k.key", RAIL402_MAX_PER_CALL: "0.05" },
    ];
    for (const env of refusals) {
      expect(() => resolveAgentConfig(env), JSON.stringify(env)).toThrow(
        expect.objectContaining({ code: "payment_policy_invalid" }),
      );
    }
    expect(
      resolveAgentConfig({
        ...pubnet,
        RAIL402_SECRET_KEY_FILE: "/k.key",
        RAIL402_MAX_PER_CALL: "0.05",
        RAIL402_MAX_TOTAL: "1",
      }).policy.assets,
    ).toEqual([{ asset: "USDC", perCall: "0.05", sessionTotal: "1" }]);
  });

  it("allows http and loopback destinations on testnet only when asked", () => {
    const config = resolveAgentConfig(
      {
        RAIL402_RPC_URL: "http://localhost:8000/rpc",
        RAIL402_ALLOW_PRIVATE_NETWORK: "loopback",
        RAIL402_ALLOWED_PORTS: "443, 3000",
      },
      { allowHttp: true },
    );
    expect(config).toMatchObject({
      rpcUrl: "http://localhost:8000/rpc",
      egress: { allowHttp: true, allowPrivateNetwork: "loopback", ports: [443, 3000] },
    });
    expect(egressFromConfig(config)).toEqual({
      schemes: ["https:", "http:"],
      allowPrivateNetwork: "loopback",
      ports: [443, 3000],
    });
    expect(egressFromConfig(resolveAgentConfig({}))).toEqual({
      schemes: ["https:"],
      allowPrivateNetwork: false,
    });
  });

  it.each([
    ["RAIL402_NETWORK", "stellar:futurenet"],
    ["RAIL402_RPC_URL", "not a url"],
    ["RAIL402_RPC_URL", "ftp://rpc.example"],
    ["RAIL402_MAX_PER_CALL", "ten dollars"],
    ["RAIL402_MAX_PER_CALL", "0.05 EURC"],
    ["RAIL402_ASSETS", "TEST6:GABC:6"],
    ["RAIL402_SESSION", "no spaces"],
    ["RAIL402_SESSION_TTL", "30"],
    ["RAIL402_SESSION_TTL", "10s"],
    ["RAIL402_SESSION_TTL", "31d"],
    ["RAIL402_BUDGET_STORE", "redis"],
    ["RAIL402_ALLOW_HTTP", "yes"],
    ["RAIL402_ALLOW_PRIVATE_NETWORK", "all"],
    ["RAIL402_REQUIRE_LISTING", "maybe"],
    ["RAIL402_MIN_TRUST", "trusted"],
    ["RAIL402_MIN_TRUST", "web=settled"],
    ["RAIL402_ALLOWED_PORTS", "443,http"],
    ["RAIL402_ALLOWED_PORTS", "0"],
    ["RAIL402_ALLOWED_PORTS", "65536"],
    ["RAIL402_MAX_INFLIGHT", "0"],
    ["RAIL402_MAX_INFLIGHT", "9"],
    ["RAIL402_EXPLORER", "https://explorer.example/tx"],
    ["RAIL402_LOG_LEVEL", "verbose"],
    ["RAIL402_SCHEMES", "exact,stream"],
    ["RAIL402_UPTO_CONTRACTS", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"],
    ["RAIL402_UPTO_FACILITATORS", "not-an-address"],
  ])("refuses %s=%s and names the setting", (setting, value) => {
    expect(() => resolveAgentConfig({ [setting]: value })).toThrow(
      expect.objectContaining({ code: "payment_policy_invalid", details: { setting } }),
    );
  });

  it("needs a template for the rail402 explorer", () => {
    expect(() => resolveAgentConfig({ RAIL402_EXPLORER: "rail402" })).toThrow(
      expect.objectContaining({ details: { setting: "RAIL402_EXPLORER_URL" } }),
    );
  });

  it("accepts a custom explorer template and the memory budget", () => {
    const config = resolveAgentConfig({
      RAIL402_EXPLORER: "rail402",
      RAIL402_EXPLORER_URL: "https://explorer.example/{network}/tx/{hash}",
      RAIL402_BUDGET_STORE: "memory",
      RAIL402_LOG_LEVEL: "debug",
      RAIL402_MAX_INFLIGHT: "4",
    });
    expect(config).toMatchObject({
      explorer: { template: "https://explorer.example/{network}/tx/{hash}" },
      budgetStore: "memory",
      logLevel: "debug",
      maxInflight: 4,
    });
  });
});
