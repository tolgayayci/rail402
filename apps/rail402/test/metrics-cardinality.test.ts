/**
 * Every label value in /metrics comes from a bounded set: networks, schemes and codes from the
 * registry, RPC methods from a fixed list, contract aliases from configuration. Callers control
 * request bodies, headers, paths and the reasons a facilitator echoes; none of that may grow a label.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Keypair, rpc, xdr } from "@stellar/stellar-sdk";
import { catalogBackgroundCodes, catalogResultCodes } from "@rail402.dev/bazaar";
import { silentLogger, type StellarFacilitator } from "@rail402.dev/facilitator";
import {
  ContractTtlMonitor,
  Metrics,
  RPC_METHODS,
  allCodes,
  createApp,
  loadConfig,
  meterRpcServer,
  metricsCatalogObserver,
  metricsObserver,
  metricsSearchObserver,
} from "@rail402.dev/service";

const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const EXTRA = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const random = () => `x${randomBytes(6).toString("hex")}`;

const config = loadConfig({
  STORE: "memory",
  TESTNET_RPC_URL: "http://localhost:8000/rpc",
  TESTNET_SPONSOR_SECRET: Keypair.random().secret(),
  TESTNET_TTL_CONTRACTS: `payments:${EXTRA}`,
  RATE_LIMIT_PER_MINUTE: "0",
});
const aliases = new Set(config.networks.flatMap((network) => network.ttlContracts.map((c) => c.alias)));

/** Label → the values it may take. Every label of every rail402_ series must be listed. */
const ALLOWED: Record<string, ReadonlySet<string>> = {
  network: new Set(["stellar:testnet", "stellar:pubnet", "unknown"]),
  scheme: new Set(["exact", "upto", "unsupported"]),
  amount: new Set(["zero", "partial", "max"]),
  mode: new Set(["onchain", "offchain"]),
  action: new Set(["extend", "restore"]),
  reason: new Set([...Object.keys(allCodes), "", "unregistered"]),
  code: new Set([...Object.keys(allCodes), ...catalogResultCodes, ...catalogBackgroundCodes]),
  method: new Set([
    ...RPC_METHODS,
    "other",
    "hybrid",
    "lexical",
    "filter",
    "GET",
    "POST",
    "PUT",
    "DELETE",
    "HEAD",
    "OPTIONS",
    "PATCH",
  ]),
  contract: aliases,
  entry: new Set(["instance", "code"]),
  outcome: new Set([
    "valid",
    "invalid",
    "success",
    "failure",
    "pending",
    "ok",
    "rpc_error",
    "http_error",
    "timeout",
    "network_error",
    "charged",
    "wasted",
    "degraded",
    "failed",
    "succeeded",
    "expired",
    "unresolvable",
  ]),
  state: new Set(["succeeded", "failed", "expired", "pending", "published", "quarantined"]),
  settled_by: new Set(["rail402", "third_party"]),
  status: new Set([
    "PENDING",
    "DUPLICATE",
    "TRY_AGAIN_LATER",
    "ERROR",
    "UPSTREAM_ERROR",
    "success",
    "processing",
    "rejected",
    // HTTP statuses of rail402_http_request_duration_seconds.
    ...["200", "400", "401", "404", "405", "413", "415", "429", "500", "503"],
  ]),
  kind: new Set(["bad_seq", "try_again_later", "network", "http_5xx", "http_429"]),
  target: new Set(["rpc", "horizon"]),
  phase: new Set(["verify", "settle", "outbox", "origin_check", "enrich"]),
  stage: new Set(["document", "query"]),
  partial: new Set(["true", "false"]),
  task: new Set([
    "poll",
    "reconcile",
    "origin_check",
    "catalog_queue",
    "listing_facts",
    "search_index",
    "settlement_ledger",
    "catalog_stats",
    "health",
    "upto_ttl_keeper",
  ]),
  route: new Set([
    "/usage",
    "/verify",
    "/settle",
    "/supported",
    "/health",
    "/ready",
    "/metrics",
    "/discovery/resources",
    "/discovery/search",
    "/discovery/resources/:id",
    "unmatched",
  ]),
  le: new Set(), // histogram bounds are fixed by the metric definition
};

describe("metric label cardinality", () => {
  it("keeps every label value within its bounded set, whatever callers send", async () => {
    const metrics = new Metrics();
    const facilitator = {
      core: {
        getSupported: () => ({
          kinds: [
            { x402Version: 2, scheme: "exact", network: "stellar:testnet", extra: {} },
            { x402Version: 2, scheme: "upto", network: "stellar:testnet", extra: {} },
          ],
          extensions: [],
          signers: {},
        }),
        // A facilitator could echo anything as a reason; the label must not.
        verify: () => Promise.resolve({ isValid: false, invalidReason: random(), invalidMessage: "?" }),
        settle: (_payload: unknown, requirements: { scheme: string }) =>
          Promise.resolve(
            requirements.scheme === "upto"
              ? { success: true, transaction: random(), network: "stellar:testnet", amount: "1" }
              : { success: false, errorReason: random(), transaction: "", network: "stellar:testnet" },
          ),
      },
      networks: new Map(),
    } as unknown as StellarFacilitator;
    const app = createApp({
      config,
      facilitator,
      metrics,
      log: silentLogger,
      readiness: () => Promise.resolve({ ready: true, checks: {} }),
      version: "test",
    });

    for (let round = 0; round < 20; round++) {
      const requirements = {
        scheme: round % 4 === 0 ? "exact" : round % 4 === 1 ? "upto" : random(),
        network: round % 3 === 0 ? "stellar:testnet" : `stellar:${random()}`,
        asset: USDC,
        payTo: Keypair.random().publicKey(),
        amount: "1",
        maxTimeoutSeconds: 60,
        extra: {},
      };
      for (const path of ["/verify", "/settle"]) {
        await app.request(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            x402Version: 2,
            paymentPayload: { x402Version: 2, accepted: requirements, payload: {} },
            paymentRequirements: requirements,
          }),
        });
      }
      await app.request(`/${random()}`);
      await app.request(`/discovery/resources/${random()}`, { method: round % 2 === 0 ? "GET" : "DELETE" });
    }

    const settlement = metricsObserver(metrics);
    settlement.finalized({
      network: "stellar:testnet",
      scheme: "exact",
      state: "failed",
      reason: random(),
      durationMs: 1,
      onChainFailure: false,
      settledBy: "rail402",
    });
    settlement.submission("stellar:testnet", { status: "ERROR", resultCode: random(), phase: "submit" });
    const catalog = metricsCatalogObserver(metrics);
    catalog.outcome("origin_check", "success", "origin_confirmed");
    catalog.outcome("outbox", "rejected", "bazaar_resource_unsafe");
    const search = metricsSearchObserver(metrics);
    search.indexBuild("degraded", 5);
    search.embeddingFailure("query");
    search.search("lexical", true, 3);

    // RPC calls with methods outside the fixed list.
    const client = new rpc.Server("http://127.0.0.1:9/rpc", { allowHttp: true });
    client.httpClient.post = (() =>
      Promise.resolve({
        data: { result: {} },
        headers: {},
        config: {},
        status: 200,
        statusText: "OK",
      })) as never;
    meterRpcServer(client, "stellar:testnet", metrics);
    for (let call = 0; call < 5; call++) {
      await client.httpClient.post("http://127.0.0.1:9/rpc", { jsonrpc: "2.0", id: 1, method: random() });
    }
    await client.httpClient.post("http://127.0.0.1:9/rpc", { jsonrpc: "2.0", id: 1, method: "getHealth" });

    // TTLs are labelled by configured alias, never by what the ledger returns.
    const [network] = config.networks;
    const ttl = new ContractTtlMonitor({
      network: "stellar:testnet",
      server: {
        getLedgerEntries: (...keys: xdr.LedgerKey[]) =>
          Promise.resolve({
            latestLedger: 100,
            entries: keys
              .filter((key) => key.switch() === xdr.LedgerEntryType.contractData())
              .map((key) => ({
                key,
                liveUntilLedgerSeq: 500,
                val: xdr.LedgerEntryData.contractData(
                  new xdr.ContractDataEntry({
                    ext: new xdr.ExtensionPoint(0),
                    contract: key.contractData().contract(),
                    key: xdr.ScVal.scvLedgerKeyContractInstance(),
                    durability: xdr.ContractDataDurability.persistent(),
                    val: xdr.ScVal.scvContractInstance(
                      new xdr.ScContractInstance({
                        executable: xdr.ContractExecutable.contractExecutableStellarAsset(),
                        storage: null,
                      }),
                    ),
                  }),
                ),
              })),
          }),
      },
      contracts: network?.ttlContracts ?? [],
      metrics,
      log: silentLogger,
    });
    await ttl.check();

    const exposition = await metrics.registry.metrics();
    const seen = new Map<string, Set<string>>();
    for (const line of exposition.split("\n")) {
      const match = /^(rail402_(?!process_)\w+)\{(.*)\} \S+$/.exec(line);
      if (match === null) continue;
      for (const [, label = "", value = ""] of (match[2] ?? "").matchAll(/(\w+)="([^"]*)"/g)) {
        if (label === "le") continue;
        const allowed = ALLOWED[label];
        expect(allowed, `label ${label} of ${match[1] ?? ""} has no bounded set`).toBeDefined();
        expect(allowed?.has(value), `${match[1] ?? ""}{${label}="${value}"}`).toBe(true);
        (seen.get(label) ?? seen.set(label, new Set()).get(label))?.add(value);
      }
    }
    // The hostile inputs did reach the metrics, collapsed into their bounded values.
    expect(seen.get("reason")).toContain("unregistered");
    expect(seen.get("scheme")).toContain("unsupported");
    expect(seen.get("network")).toContain("unknown");
    expect(seen.get("method")).toContain("other");
    expect(seen.get("route")).toContain("unmatched");
    expect(seen.get("amount")).toContain("max");
    expect([...(seen.get("contract") ?? [])].sort()).toEqual(["USDC", "payments", "upto"]);
  });
});
