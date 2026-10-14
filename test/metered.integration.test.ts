/**
 * The demo seller's metered resources on the private Stellar network (docker compose --profile
 * stellar up -d): `GET /history` and the MCP tool `hourly_forecast` are paid with `upto` through
 * Rail402 running in this process, with the settlement contract deployed for the run. The buyer SDK
 * authorizes the 0.01 cap; the seller settles only what the call used (per day, per hour), the rest of
 * the cap returns to the budget after the chain proves the settlement, and both resources are
 * cataloged at their cap. A request the seller fails is never settled.
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Keypair } from "@stellar/stellar-sdk";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { METERED_PRICES, baseUnits, createSeller } from "@rail402.dev/demo-seller";
import { KeyHolder, createBuyer, exactScheme, toAtomic, uptoScheme, type Buyer } from "@rail402.dev/sdk";
import { TESTNET } from "@rail402.dev/stellar";
import {
  LocalNetwork,
  deployUpto,
  pinHorizon,
  type HorizonPin,
  type IssuedAsset,
  type LocalUptoContract,
} from "@rail402.dev/testkit";
import { startRail402, type RunningRail402 } from "../packages/sdk/test/service.ts";

const net = new LocalNetwork();
const available = await net.available();

const asset = (tusd: IssuedAsset) => ({ contract: tusd.sac, decimals: 7 });
const HASH = /^[0-9a-f]{64}$/;

describe.skipIf(!available)("the demo seller's metered upto resources on the local network", () => {
  let horizon: HorizonPin;
  let tusd: IssuedAsset;
  let contract: LocalUptoContract;
  let rail402: RunningRail402;
  let seller: Keypair;
  let payer: Keypair;
  let sellerServer: Server;
  let sellerUrl: string;
  let buyer: Buyer;
  let cap: bigint;

  const balance = (holder: string) => net.tokenBalance(tusd.sac, holder).catch(() => 0n);
  const maxAmount = { amount: "0.05", asset: "TUSD" };

  beforeAll(async () => {
    // The facilitator's upto expiry bound follows Horizon's ledger time; the private network closes
    // a ledger every second, so this process reads 2 s and the buyer estimates 5 s (see the SDK's
    // upto suite).
    horizon = pinHorizon({ seconds: 2 });
    [tusd, contract] = await Promise.all([net.issueAsset("TUSD"), deployUpto(net)]);
    rail402 = await startRail402(net, tusd, {
      TESTNET_UPTO_CONTRACT: contract.address,
      TESTNET_UPTO_WASM_HASH: contract.wasmHash,
      TESTNET_UPTO_TTL_KEEPER: "false",
    });
    [seller] = (await net.holders(tusd, 1, "0")) as [Keypair];
    [payer] = (await net.holders(tusd, 1, "1")) as [Keypair];
    cap = baseUnits(METERED_PRICES.cap, asset(tusd));

    sellerServer = createSeller({
      payTo: seller.publicKey(),
      facilitator: new HTTPFacilitatorClient({ url: rail402.url }),
      asset: asset(tusd),
    }).listen(0, "127.0.0.1");
    await new Promise((resolve) => sellerServer.once("listening", resolve));
    const port = (sellerServer.address() as AddressInfo).port;
    sellerUrl = `http://127.0.0.1:${String(port)}`;

    buyer = await createBuyer({
      network: TESTNET,
      signer: KeyHolder.fromSecret(payer.secret()),
      rpcUrl: net.rpcUrl,
      bazaarUrl: rail402.url,
      facilitatorUrl: rail402.url,
      policy: {
        assets: [{ asset: tusd.sac, symbol: "TUSD", decimals: 7, perCall: "0.05", sessionTotal: "1" }],
        uptoContracts: [contract.address],
      },
      egress: { schemes: ["http:"], ports: [port], allowPrivateNetwork: "loopback" },
      schemes: [exactScheme(), uptoScheme({ contract: contract.address, ledgerSeconds: 5 })],
    });
  }, 180_000);

  afterAll(async () => {
    await buyer.close();
    sellerServer.closeAllConnections();
    await new Promise((resolve) => sellerServer.close(resolve));
    await rail402.stop();
    horizon.restore();
  });

  it("settles the days of history returned, not the cap", async () => {
    const perDay = baseUnits(METERED_PRICES.perDay, asset(tusd));
    const [payerBefore, sellerBefore, sponsorBefore] = await Promise.all([
      balance(payer.publicKey()),
      balance(seller.publicKey()),
      balance(rail402.sponsor),
    ]);
    const result = await buyer.pay(
      { kind: "http", url: `${sellerUrl}/history`, query: { city: "Ankara", days: "3" } },
      { maxAmount },
    );
    const charged = perDay * 3n;
    expect(result.response).toMatchObject({
      status: 200,
      json: { city: "Ankara", charged: { units: 3, amount: charged.toString() } },
    });
    expect(result.payment).toMatchObject({
      status: "settled",
      scheme: "upto",
      authorized: { atomic: cap.toString() },
      settled: { atomic: charged.toString() },
      payTo: seller.publicKey(),
      verifiedOnChain: true,
    });
    expect(result.payment?.transaction).toMatch(HASH);
    expect(await balance(payer.publicKey())).toBe(payerBefore - charged);
    expect(await balance(seller.publicKey())).toBe(sellerBefore + charged);
    expect(await balance(rail402.sponsor)).toBe(sponsorBefore);
  });

  it("settles the forecast hours the MCP tool returned, and hides the charge from the buyer", async () => {
    const perHour = baseUnits(METERED_PRICES.perHour, asset(tusd));
    const sellerBefore = await balance(seller.publicKey());
    const result = await buyer.pay(
      {
        kind: "mcp",
        url: `${sellerUrl}/mcp`,
        toolName: "hourly_forecast",
        arguments: { city: "Izmir", hours: 5 },
      },
      { maxAmount },
    );
    const charged = perHour * 5n;
    expect(result.response).toMatchObject({
      kind: "mcp",
      isError: false,
      structuredContent: { city: "Izmir", charged: { units: 5, amount: charged.toString() } },
    });
    expect(JSON.stringify(result.response)).not.toContain("rail402/upto-charge");
    expect(result.payment).toMatchObject({
      status: "settled",
      scheme: "upto",
      authorized: { atomic: cap.toString() },
      settled: { atomic: charged.toString() },
      verifiedOnChain: true,
    });
    expect(await balance(seller.publicKey())).toBe(sellerBefore + charged);
  });

  it("settles nothing for a request the seller fails", async () => {
    const [payerBefore, sellerBefore] = await Promise.all([
      balance(payer.publicKey()),
      balance(seller.publicKey()),
    ]);
    const outcome = await buyer
      .pay(
        { kind: "http", url: `${sellerUrl}/history`, query: { city: "Ankara", days: "99" } },
        { maxAmount },
      )
      .then(
        (result) => ({ result, error: undefined }),
        (error: unknown) => ({ result: undefined, error }),
      );
    expect(outcome.result?.payment?.status ?? "not_settled").not.toBe("settled");
    expect(await balance(payer.publicKey())).toBe(payerBefore);
    expect(await balance(seller.publicKey())).toBe(sellerBefore);
  });

  it("catalogs both metered resources at their cap", async () => {
    let history: string | undefined;
    let hourly: string | undefined;
    for (let attempt = 0; attempt < 30 && (history === undefined || hourly === undefined); attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 500));
      await rail402.runtime.bazaar?.catalog.checkOrigins();
      await rail402.runtime.bazaar?.search.refresh();
      const found = await buyer.search("weather history for a city");
      history ??= found.hits.find((hit) => hit.resource === `${sellerUrl}/history`)?.listingId ?? undefined;
      const tools = await buyer.search("hourly weather forecast", { type: "mcp" });
      hourly ??= tools.hits.find((hit) => hit.toolName === "hourly_forecast")?.listingId ?? undefined;
    }
    expect(history).toBeDefined();
    expect(hourly).toBeDefined();
    for (const id of [history, hourly]) {
      const listing = await buyer.listing(id ?? "");
      expect(listing).toMatchObject({ state: "published", owner: seller.publicKey() });
      expect(listing.prices).toEqual([expect.objectContaining({ scheme: "upto", atomic: cap.toString() })]);
    }
    const [budget] = (await buyer.budget()).assets;
    expect(toAtomic(budget?.spent ?? "0", 7)).toBe(
      baseUnits(METERED_PRICES.perDay, asset(tusd)) * 3n +
        baseUnits(METERED_PRICES.perHour, asset(tusd)) * 5n,
    );
  });
});
