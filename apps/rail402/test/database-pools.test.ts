import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { connectionsPerProcess, databasePools, loadConfig } from "@rail402.dev/service";
import { COLD_SIGNER, secretFile, sponsorKeyFile } from "./secret-fixtures.ts";

const USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const testnet = {
  DATABASE_URL_FILE: secretFile("postgres://rail402:rail402@localhost:5432/rail402"),
  TESTNET_RPC_URL: "http://localhost:8000/rpc",
  TESTNET_SPONSOR_SECRET: Keypair.random().secret(),
};
const pubnet = {
  METRICS_PRIVATE_TOKEN_SHA256: "ab".repeat(32),
  PUBNET_RPC_SINGLE_PROVIDER: "true",
  PUBNET_RPC_URL: "https://mainnet.example/rpc",
  PUBNET_SPONSOR_SECRET_FILE: sponsorKeyFile(Keypair.random().secret()),
  PUBNET_SPONSOR_COLD_SIGNER: COLD_SIGNER,
  PUBNET_REQUIRE_API_KEY: "false",
  PUBNET_RATE_LIMIT_PER_MINUTE: "60",
  PUBNET_KEYLESS_SPONSOR_BUDGET_XLM_PER_HOUR: "1",
  PUBNET_MAX_SPONSOR_SPEND_XLM_PER_HOUR: "10",
  PUBNET_MAX_TX_FEE_STROOPS: "300000",
  PUBNET_INCLUSION_FEE_STROOPS: "200",
  PUBNET_ASSETS: `${USDC}:USDC:7:10000`,
};

const pools = (env: Record<string, string>) => databasePools(loadConfig(env));

describe("the database connections of one process", () => {
  it("opens no pool with the in-memory store", () => {
    expect(pools({ ...testnet, STORE: "memory" })).toBeUndefined();
  });

  it("counts the shared pool, the readiness connection and the discovery and search index pools on one network", () => {
    expect(pools({ ...testnet, BAZAAR_ENABLED: "false" })).toEqual({ shared: 10, readiness: 1 });
    const bazaar = pools(testnet);
    expect(bazaar).toEqual({ shared: 10, readiness: 1, discovery: 5, searchIndex: 2 });
    expect(connectionsPerProcess(bazaar ?? { shared: 0, readiness: 0 })).toBe(18);
    // Pubnet alone shares one pool, as a single network does.
    expect(pools({ ...testnet, ...pubnet, NETWORKS: "stellar:pubnet" })).toEqual({
      shared: 10,
      readiness: 1,
      discovery: 5,
      searchIndex: 2,
    });
  });

  it("adds pubnet's own pools when it is served next to testnet", () => {
    const both = pools({ ...testnet, ...pubnet, NETWORKS: "stellar:testnet,stellar:pubnet" });
    expect(both).toEqual({
      shared: 10,
      readiness: 1,
      pubnet: 5,
      discovery: 5,
      pubnetDiscovery: 5,
      searchIndex: 2,
    });
    expect(connectionsPerProcess(both ?? { shared: 0, readiness: 0 })).toBe(28);
    const smaller = pools({
      ...testnet,
      ...pubnet,
      NETWORKS: "stellar:testnet,stellar:pubnet",
      DISCOVERY_DATABASE_POOL_SIZE: "3",
    });
    expect(connectionsPerProcess(smaller ?? { shared: 0, readiness: 0 })).toBe(24);
    const withoutBazaar = pools({
      ...testnet,
      ...pubnet,
      NETWORKS: "stellar:testnet,stellar:pubnet",
      BAZAAR_ENABLED: "false",
    });
    expect(withoutBazaar).toEqual({ shared: 10, readiness: 1, pubnet: 5 });
  });
});
