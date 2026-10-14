/**
 * Every operational signal moves when its cause happens: the whole service (Postgres, the local
 * Stellar network behind a fault proxy, the Bazaar with a real seller) is driven into each condition
 * and /metrics and /health are read back. Needs `docker compose --profile stellar up -d`.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import {
  BASE_FEE,
  type FeeBumpTransaction,
  Keypair,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactStellarScheme as ExactStellarServer } from "@x402/stellar/exact/server";
import { deriveChannelKeypairs } from "@rail402.dev/facilitator";
import type { HealthSnapshot } from "@rail402.dev/service";
import { readContractTtl } from "@rail402.dev/stellar";
import {
  LocalNetwork,
  deploySimpleAccount,
  requirementsFor,
  startRpcProxy,
  type HeldEvent,
  type IssuedAsset,
  type PaymentRequirementsLike,
  type RpcProxy,
} from "@rail402.dev/testkit";
import { startService, type RunningService } from "./service-harness.ts";

const net = new LocalNetwork();
const available = await net.available();
const NETWORK = "stellar:testnet";

/** The value of one series in a Prometheus exposition, 0 when absent. */
function value(exposition: string, series: string): number {
  const line = exposition.split("\n").find((entry) => entry.startsWith(`${series} `));
  return line === undefined ? 0 : Number(line.slice(series.length + 1));
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 45_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await read();
    if (done(current)) return current;
    if (Date.now() > deadline)
      throw new Error(`condition not met: ${JSON.stringify(current).slice(0, 2_000)}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function started(service: RunningService): Promise<HealthSnapshot> {
  await until(
    () => service.runtime.readiness(),
    (readiness) => readiness.ready,
  );
  return until(
    () => Promise.resolve(service.runtime.health()),
    (snapshot) => snapshot.state !== "starting",
  );
}

describe.skipIf(!available)("observability: every signal moves when its cause happens", () => {
  let usdc: IssuedAsset;
  let proxy: RpcProxy;
  let service: RunningService;
  let client: HTTPFacilitatorClient;
  let seller: Keypair;
  let funder: Keypair;
  let account: string;
  let sellerServer: Server;
  let sellerUrl: string;
  const metrics = () => service.metrics.registry.metrics();
  const health = async () => (await (await fetch(`${service.url}/health`)).json()) as HealthSnapshot;

  beforeAll(async () => {
    usdc = await net.issueAsset("USDC");
    funder = Keypair.random();
    await net.fund(funder);
    account = await deploySimpleAccount(net, funder, Keypair.random());
    proxy = await startRpcProxy(net.rpcUrl);
    service = await startService(net, usdc, {
      TESTNET_RPC_URL: proxy.url,
      TESTNET_CHANNEL_COUNT: "2",
      TESTNET_TTL_CONTRACTS: `account:${account}`,
      SETTLE_CHANNEL_WAIT_MS: "60000",
      SETTLE_CONFIRM_TIMEOUT_MS: "8000",
      SEARCH_EMBEDDINGS: "false",
      DISCOVERY_ALLOW_LOOPBACK: "true",
      ORIGIN_CHECK_INTERVAL_MS: "1000",
      // A fresh local network extends new entries by its minimum TTL only; keep them clear of the thresholds.
      CONTRACT_TTL_WARN_LEDGERS: "1000",
      CONTRACT_TTL_CRITICAL_LEDGERS: "100",
    });
    client = new HTTPFacilitatorClient({ url: service.url });
    [seller] = (await net.holders(usdc, 1, "0")) as [Keypair];

    // A stock x402 seller with the bazaar extension, settling through Rail402.
    const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: service.url }))
      .register(NETWORK, new ExactStellarServer())
      .registerExtension(bazaarResourceServerExtension);
    const app = express();
    app.use(
      paymentMiddleware(
        {
          "GET /weather": {
            accepts: {
              scheme: "exact",
              price: { amount: "150000", asset: usdc.sac },
              network: NETWORK,
              payTo: seller.publicKey(),
            },
            description: "Current weather for a city",
            mimeType: "application/json",
            extensions: declareDiscoveryExtension({
              input: { city: "Ankara" },
              inputSchema: { properties: { city: { type: "string" } }, required: ["city"] },
              output: { example: { temperature: 21 } },
            }),
          },
        },
        resourceServer,
      ),
    );
    app.get("/weather", (_req, res) => {
      res.json({ temperature: 21 });
    });
    sellerServer = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => sellerServer.once("listening", resolve));
    sellerUrl = `http://127.0.0.1:${String((sellerServer.address() as AddressInfo).port)}`;
    await started(service);
  });

  afterAll(async () => {
    await new Promise((resolve) => sellerServer.close(resolve));
    await service.stop();
    await proxy.close().catch(() => undefined);
  });

  const pay = async (payer: Keypair, maxTimeoutSeconds = 60) => {
    const terms = requirementsFor(usdc.sac, seller.publicKey(), 100_000n, maxTimeoutSeconds);
    const payload = (await net.payment(payer, terms)) as PaymentPayload;
    return { payload, requirements: terms as PaymentRequirements };
  };

  it("fills /health from the poll and serves it without rebuilding it", async () => {
    const snapshot = await health();
    expect(snapshot).toMatchObject({ status: "ok", version: "test", state: "healthy", warnings: [] });
    const network = snapshot.networks[NETWORK];
    expect(network?.rpc.ok).toBe(true);
    expect(network?.rpc.latestLedger).toBeGreaterThan(0);
    expect(network?.rpc.ledgerAgeSeconds).toBeLessThan(30);
    expect(network?.sponsor.address).toBe(service.sponsor.publicKey());
    expect(BigInt(network?.sponsor.balanceStroops ?? "0")).toBeGreaterThan(0n);
    expect(network?.channels).toMatchObject({ total: 2, inUse: 0 });
    expect(network?.settlements).toMatchObject({ unfinished: 0, unresolvable: 0 });
    expect(snapshot.catalog?.listings).toEqual({ pending: 0, published: 0, quarantined: 0 });
    expect(snapshot.search?.lastBuild).toBe("ok");

    // The TTL gauge is liveUntil − latest at the check: an independent read of liveUntil gives the
    // ledger the check ran at, which must be a recent one.
    const reading = await readContractTtl(net.server, [usdc.sac, account]);
    const exposition = await metrics();
    for (const [alias, contract, entry] of [
      ["USDC", usdc.sac, "instance"],
      ["account", account, "instance"],
      ["account", account, "code"],
    ] as const) {
      const ttl = reading.contracts.get(contract);
      const liveUntil = entry === "instance" ? ttl?.instanceLiveUntil : ttl?.codeLiveUntil;
      const gauge = value(
        exposition,
        `rail402_contract_ttl_ledgers{network="${NETWORK}",contract="${alias}",entry="${entry}"}`,
      );
      expect(gauge, `${alias} ${entry}`).toBeGreaterThan(0);
      const checkedAt = (liveUntil ?? 0) - gauge;
      expect(checkedAt).toBeLessThanOrEqual(reading.latestLedger);
      expect(checkedAt).toBeGreaterThan(reading.latestLedger - 120);
    }
    expect(network?.contracts["USDC"]).toMatchObject({ id: usdc.sac });
    expect(network?.contracts["account"]?.codeTtlLedgers).toBeGreaterThan(0);
    expect(value(exposition, `rail402_rpc_latest_ledger{network="${NETWORK}"}`)).toBeGreaterThan(0);

    // Answered from the snapshot: a burst of requests sees one and the same poll.
    const burst = await Promise.all(Array.from({ length: 20 }, () => health()));
    expect(new Set(burst.map((body) => body.checkedAt)).size).toBe(1);
  });

  it("measures the wait for a channel when settlements outnumber channels", async () => {
    const before = await metrics();
    const payers = await net.holders(usdc, 10, "10");
    const payments = await Promise.all(payers.map((payer) => pay(payer)));
    const results = await Promise.all(
      payments.map(({ payload, requirements }) => client.settle(payload, requirements)),
    );
    expect(results.map((result) => result.success)).toEqual(Array.from({ length: 10 }, () => true));

    const after = await metrics();
    const count = (text: string, series: string) => value(text, series);
    const waits = `rail402_channel_lease_wait_seconds_count{network="${NETWORK}"}`;
    const quick = `rail402_channel_lease_wait_seconds_bucket{le="0.1",network="${NETWORK}"}`;
    expect(count(after, waits) - count(before, waits)).toBe(10);
    // Two channels, ten settlements: most of them waited for a lease.
    expect(count(after, quick) - count(before, quick)).toBeLessThan(10);
    expect(
      count(after, `rail402_rpc_requests_total{network="${NETWORK}",method="getTransaction",outcome="ok"}`),
    ).toBeGreaterThan(0);
    expect(
      count(after, `rail402_rpc_request_duration_seconds_count{network="${NETWORK}",method="getHealth"}`),
    ).toBeGreaterThan(0);
  });

  it("shows the origin check in the catalog outcomes and times searches", async () => {
    const [buyer] = (await net.holders(usdc, 1, "10")) as [Keypair];
    const buyerFetch = wrapFetchWithPaymentFromConfig(fetch, {
      schemes: [
        {
          network: NETWORK,
          client: {
            scheme: "exact",
            createPaymentPayload: async (x402Version: number, requirements: PaymentRequirements) => {
              const payment = await net.payment(buyer, requirements as unknown as PaymentRequirementsLike);
              return { x402Version, payload: payment.payload };
            },
          },
        },
      ],
      spendControls: false,
    });
    const response = await buyerFetch(`${sellerUrl}/weather?city=Ankara`);
    expect(response.status).toBe(200);

    const confirmed = `rail402_catalog_outcomes_total{phase="origin_check",status="success",code="origin_confirmed"}`;
    await until(metrics, (text) => value(text, confirmed) === 1);
    const search = async () =>
      (await (await fetch(`${service.url}/discovery/search?query=weather`)).json()) as {
        resources: unknown[];
        partialResults: boolean;
      };
    const found = await until(search, (result) => result.resources.length === 1);
    expect(found.partialResults).toBe(true);
    const exposition = await metrics();
    expect(
      value(exposition, `rail402_search_duration_seconds_count{method="lexical",partial="true"}`),
    ).toBeGreaterThanOrEqual(1);
    expect(value(exposition, `rail402_search_index_builds_total{outcome="ok"}`)).toBeGreaterThanOrEqual(2);
  });

  it("counts a sequence conflict when a channel's sequence is used behind its back", async () => {
    const before = await metrics();
    const [payer] = (await net.holders(usdc, 1, "10")) as [Keypair];
    const { payload, requirements } = await pay(payer, 15);
    let first = true;
    proxy.onSendTransaction = () => {
      if (!first) return "forward";
      first = false;
      return "hold";
    };
    const held = new Promise<HeldEvent>((resolve) => proxy.events.once("held", resolve));
    const settling = client.settle(payload, requirements);
    const { transaction } = await held;

    // The leased channel's key is derived from the sponsor seed; spend its next sequence elsewhere.
    const envelope = TransactionBuilder.fromXDR(transaction ?? "", net.passphrase) as FeeBumpTransaction;
    const channelAddress = envelope.innerTransaction.source;
    const channel = deriveChannelKeypairs(service.sponsor, NETWORK, 2).find(
      (keypair) => keypair.publicKey() === channelAddress,
    );
    expect(channel).toBeDefined();
    const inner = new TransactionBuilder(await net.server.getAccount(channelAddress), {
      fee: BASE_FEE,
      networkPassphrase: net.passphrase,
    })
      .addOperation(Operation.bumpSequence({ bumpTo: "0" }))
      .setTimeout(30)
      .build();
    inner.sign(channel as Keypair);
    const bump = TransactionBuilder.buildFeeBumpTransaction(funder, "200", inner, net.passphrase);
    bump.sign(funder);
    await net.submit(bump);

    await proxy.releaseHeld();
    const result = await settling;
    expect(result.success).toBe(false);
    proxy.reset();

    const after = await metrics();
    const conflicts = `rail402_sequence_conflicts_total{network="${NETWORK}",kind="bad_seq"}`;
    expect(value(after, conflicts) - value(before, conflicts)).toBeGreaterThanOrEqual(1);
    expect(
      value(after, `rail402_submissions_total{network="${NETWORK}",status="ERROR"}`),
    ).toBeGreaterThanOrEqual(1);
  });

  it("counts transport and request errors while the RPC fails, and reports it in /health", async () => {
    const server = service.runtime.facilitator.networks.get(NETWORK)?.server;
    proxy.failRequests(503);
    await expect(server?.getHealth()).rejects.toThrow();
    proxy.failRequests(undefined);
    await proxy.close();
    await expect(server?.getHealth()).rejects.toThrow();

    const exposition = await metrics();
    for (const series of [
      `rail402_rpc_requests_total{network="${NETWORK}",method="getHealth",outcome="http_error"}`,
      `rail402_rpc_requests_total{network="${NETWORK}",method="getHealth",outcome="network_error"}`,
      `rail402_rpc_transport_errors_total{network="${NETWORK}",target="rpc",kind="http_5xx"}`,
      `rail402_rpc_transport_errors_total{network="${NETWORK}",target="rpc",kind="network"}`,
    ]) {
      expect(value(exposition, series), series).toBeGreaterThanOrEqual(1);
    }

    // The next poll finds the RPC gone: degraded, while /health itself keeps answering 200.
    const snapshot = await until(health, (body) => body.warnings.some((w) => w.code === "rpc_unhealthy"));
    expect(snapshot.state).toBe("degraded");
    const network = snapshot.networks[NETWORK];
    expect(network?.rpc.ok).toBe(false);
    expect(network?.rpc.transportErrors1h).toBeGreaterThanOrEqual(2);
    expect(network?.settlements.last1h?.succeeded).toBeGreaterThanOrEqual(11);
    expect(network?.settlements.repeats1h).toBe(0);
    expect(network?.sequenceConflicts1h).toBeGreaterThanOrEqual(1);
    expect(network?.channels.leaseWaitP95Ms).toBeGreaterThan(0);
    expect(snapshot.catalog?.listings?.published).toBe(1);
    expect(snapshot.catalog?.outcomes1h["origin_check"]?.["success"]).toBe(1);
    expect(snapshot.search?.indexRevision).toBeGreaterThan(0);
    expect(snapshot.search?.p95Ms).toBeGreaterThan(0);
  });
});

describe.skipIf(!available)("observability: the sponsor guard", () => {
  let usdc: IssuedAsset;
  let service: RunningService;

  beforeAll(async () => {
    usdc = await net.issueAsset("USDC");
    // Friendbot funds 10,000 XLM: far below this reserve and readiness floor.
    service = await startService(net, usdc, {
      BAZAAR_ENABLED: "false",
      TESTNET_CHANNEL_COUNT: "1",
      TESTNET_SPONSOR_RESERVE_XLM: "1000000",
      TESTNET_MIN_SPONSOR_BALANCE_XLM: "1000000",
      CONTRACT_TTL_WARN_LEDGERS: "1000",
      CONTRACT_TTL_CRITICAL_LEDGERS: "100",
    });
    await until(
      () => Promise.resolve(service.runtime.health()),
      (snapshot) => snapshot.state !== "starting",
    );
  });

  afterAll(async () => {
    await service.stop();
  });

  it("counts refusals below the reserve and reports the sponsor below its floor", async () => {
    const [payer, seller] = (await net.holders(usdc, 2, "10")) as [Keypair, Keypair];
    const terms = requirementsFor(usdc.sac, seller.publicKey(), 100_000n);
    const payload = (await net.payment(payer, terms)) as PaymentPayload;
    const result = await new HTTPFacilitatorClient({ url: service.url })
      .settle(payload, terms as PaymentRequirements)
      .catch((error: unknown) => error as { errorReason?: string });
    expect(result).toMatchObject({ errorReason: "settle_exact_stellar_sponsor_unavailable" });
    expect(
      value(
        await service.metrics.registry.metrics(),
        `rail402_sponsor_guard_refusals_total{network="${NETWORK}",reason="reserve"}`,
      ),
    ).toBe(1);
    const snapshot = service.runtime.health();
    expect(snapshot.state).toBe("degraded");
    expect(snapshot.warnings.map((warning) => warning.code)).toEqual(["sponsor_below_floor"]);
  });
});
