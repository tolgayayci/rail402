/**
 * `exact` and `upto` payments in three kinds of SEP-41 asset through the service run as a real process
 * on the private Stellar network: a classic asset's Stellar Asset Contract (7 decimals, like USDC), and
 * the test token deployed with 6 decimals (TEST6) and with 18 (TEST18, whose amounts exceed 64 bits).
 * Stock x402 sellers and buyers price, pay and settle (`upto` with the scheme's own client and server
 * and the stock settlement override); the chain is read back for balances, transfer events and who
 * paid the fee. Needs `docker compose --profile stellar up -d`.
 */
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { Keypair } from "@stellar/stellar-sdk";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { decodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { paymentMiddleware, setSettlementOverrides, x402ResourceServer } from "@x402/express";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactStellarScheme as ExactStellarServer } from "@x402/stellar/exact/server";
import { assetDecimals, exact } from "@rail402.dev/sdk/seller";
import { UptoStellarScheme as UptoClient } from "@rail402.dev/upto/client";
import { UptoStellarScheme as UptoServer, uptoSettlementOverrides } from "@rail402.dev/upto/server";
import {
  LocalNetwork,
  ServiceProcess,
  buildTransfer,
  classicTestAsset,
  deploySimpleAccount,
  deployToken,
  deployUpto,
  exactDriver,
  onChainSettlement,
  randomContractId,
  stopServiceProcesses,
  tokenTestAsset,
  uptoDriver,
  type DriverRequirements,
  type PayerKind,
  type PaymentDriver,
  type PaymentRequirementsLike,
} from "@rail402.dev/testkit";
import { readTarget, supportedSigners } from "../src/harness.ts";

const MAIN = fileURLToPath(new URL("../../../apps/rail402/src/main.ts", import.meta.url));
const NETWORK = "stellar:testnet";
const net = new LocalNetwork();
const available = await net.available();

/** 0.25 whole units in base units, per number of decimals. */
const QUARTER: Readonly<Record<number, bigint>> = {
  6: 250_000n,
  7: 2_500_000n,
  18: 250_000_000_000_000_000n,
};
/** What each asset's resource costs: TEST18's price is beyond the 64-bit range (2^63 − 1 ≈ 9.22e18). */
const PRICE: Readonly<
  Record<
    string,
    { readonly amount: string; readonly base: bigint; readonly above: string; readonly below: string }
  >
> = {
  USDC: { amount: "0.25", base: 2_500_000n, above: "0.3", below: "0.2" },
  TEST6: { amount: "0.25", base: 250_000n, above: "0.3", below: "0.2" },
  TEST18: { amount: "12.5", base: 12_500_000_000_000_000_000n, above: "15", below: "10" },
};

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

async function ready(service: ServiceProcess): Promise<void> {
  await service.listening();
  await until(
    () => fetch(`${service.url}/ready`).then((response) => response.status),
    (status) => status === 200,
    60_000,
  );
}

interface DiscoveryItem {
  readonly resource: string;
  readonly accepts: readonly {
    readonly scheme: string;
    readonly asset: string;
    readonly amount: string;
    readonly payTo: string;
  }[];
  readonly rail402: {
    readonly options: readonly {
      readonly decimals?: number;
      readonly symbol?: string;
      readonly receivable?: boolean;
    }[];
  };
}

describe.skipIf(!available)("exact and upto payments in SEP-41 assets of any decimals", () => {
  let service: ServiceProcess;
  let sponsor: Keypair;
  let signers: string[];
  let drivers: PaymentDriver[];
  let uptoDrivers: PaymentDriver[];
  const sellers: Seller[] = [];
  const base = { STORE: "memory", TESTNET_RPC_URL: net.rpcUrl, RATE_LIMIT_PER_MINUTE: "0" };

  beforeAll(async () => {
    const [usdc, test6, test18, contract] = await Promise.all([
      net.issueAsset("USDC"),
      deployToken(net, { symbol: "TEST6", decimals: 6 }),
      deployToken(net, { symbol: "TEST18", decimals: 18 }),
      deployUpto(net),
    ]);
    const assets = [classicTestAsset(net, usdc), tokenTestAsset(net, test6), tokenTestAsset(net, test18)];
    drivers = assets.map((asset) => exactDriver(net, asset));
    sponsor = Keypair.random();
    await net.fund(sponsor);
    service = await ServiceProcess.start({
      entry: MAIN,
      env: {
        ...base,
        TESTNET_SPONSOR_SECRET: sponsor.secret(),
        TESTNET_CHANNEL_COUNT: "2",
        TESTNET_ASSETS: drivers
          .map(({ asset }) => `${asset.contract}:${asset.symbol}:${String(asset.decimals)}`)
          .join(","),
        TESTNET_MIN_SPONSOR_BALANCE_XLM: "1",
        // The default fee ceilings stay: every payment below, each one the payTo's first receipt of the
        // asset, fits under them.
        TESTNET_UPTO_ENABLED: "true",
        TESTNET_UPTO_CONTRACT: contract.address,
        TESTNET_UPTO_WASM_HASH: contract.wasmHash,
        TESTNET_UPTO_TTL_KEEPER: "false",
        SEARCH_EMBEDDINGS: "false",
        DISCOVERY_ALLOW_LOOPBACK: "true",
        ORIGIN_CHECK_INTERVAL_MS: "1000",
      },
    });
    await ready(service);
    const { supported } = await readTarget(service.url);
    signers = supportedSigners(supported);
    const authority = uptoAuthority(supported);
    uptoDrivers = assets.map((asset) =>
      uptoDriver(net, asset, {
        contract: contract.address,
        authority,
        client: (signer, options) => new UptoClient(signer, options),
        // The service process estimates ledger time from public Horizon (5–7 s); a client assuming 6 s
        // signs a window every such estimate accepts.
        ledgerSeconds: 6,
      }),
    );
  });

  afterAll(async () => {
    await Promise.all(sellers.map((seller) => seller.close()));
    await stopServiceProcesses();
  });

  const driver = (symbol: string, scheme: "exact" | "upto" = "exact") => {
    const found = (scheme === "exact" ? drivers : uptoDrivers).find(
      (candidate) => candidate.asset.symbol === symbol,
    );
    if (found === undefined) throw new Error(`no driver for ${symbol}`);
    return found;
  };

  it("checks every accepted asset's decimals on chain before it is ready", async () => {
    const readiness = (await (await fetch(`${service.url}/ready`)).json()) as {
      checks: Record<string, { ok: boolean; detail?: string }>;
    };
    expect(readiness.checks["stellar:testnet:assets"]).toEqual({
      ok: true,
      detail: "USDC:7, TEST6:6, TEST18:18",
    });
  });

  it("converts a price in whole units with each token's on-chain decimals", async () => {
    for (const { asset } of drivers) {
      const decimals = await assetDecimals(asset.contract, {
        network: NETWORK,
        rpcUrl: net.rpcUrl,
        allowHttp: true,
      });
      expect(decimals, asset.symbol).toBe(asset.decimals);
      const option = exact({
        network: NETWORK,
        payTo: Keypair.random().publicKey(),
        price: { amount: "0.25", asset: asset.contract, decimals },
      });
      expect(option.price, asset.symbol).toEqual({
        amount: String(QUARTER[decimals]),
        asset: asset.contract,
      });
    }
  });

  const cases: readonly { readonly payer: PayerKind; readonly payTo: PayerKind }[] = [
    { payer: "G", payTo: "G" },
    { payer: "C", payTo: "G" },
    { payer: "G", payTo: "C" },
  ];

  describe.each(["USDC", "TEST6", "TEST18"])("%s", (symbol) => {
    it.each(cases)(
      "a $payer… payer pays a $payTo… payTo through a stock seller; only the payment moves",
      async ({ payer: payerKind, payTo: payToKind }) => {
        const paying = driver(symbol);
        const { asset } = paying;
        const price = PRICE[symbol];
        if (price === undefined) throw new Error(`no price for ${symbol}`);
        const [payer, payTo] = await Promise.all([
          paying.payer(payerKind, price.base * 2n),
          paying.recipient(payToKind),
        ]);

        const decimals = await assetDecimals(asset.contract, {
          network: NETWORK,
          rpcUrl: net.rpcUrl,
          allowHttp: true,
        });
        const option = exact({
          network: NETWORK,
          payTo,
          price: { amount: price.amount, asset: asset.contract, decimals },
        });
        expect(option.price.amount).toBe(price.base.toString());
        const path = `/report/${symbol.toLowerCase()}/${payerKind}-${payToKind}`;
        // The seller stays up: the Bazaar lists the resource once its own 402 answer confirms it.
        const seller = await startSeller(service.url, path, option);
        sellers.push(seller);

        const balances = async () => ({
          payer: await net.tokenBalance(asset.contract, payer.address),
          payTo: await net.tokenBalance(asset.contract, payTo),
          facilitator: await Promise.all(signers.map((signer) => net.tokenBalance(asset.contract, signer))),
          sponsorXlm: await net.nativeBalance(sponsor.publicKey()),
        });
        const before = await balances();

        const buyer = wrapFetchWithPaymentFromConfig(fetch, {
          schemes: [
            {
              network: NETWORK,
              client: {
                scheme: "exact",
                createPaymentPayload: async (x402Version: number, requirements: PaymentRequirements) => {
                  const payment = await paying.pay(payer, requirements as unknown as PaymentRequirementsLike);
                  return { x402Version, payload: payment.payload };
                },
              },
            },
          ],
          spendControls: false,
        });
        const response = await buyer(`${seller.url}${path}`);
        expect(response.status, await response.clone().text()).toBe(200);
        const header = response.headers.get("payment-response");
        if (header === null) throw new Error("no PAYMENT-RESPONSE");
        const settlement = decodePaymentResponseHeader(header);
        expect(settlement).toMatchObject({ success: true, network: NETWORK, payer: payer.address });
        const hash = settlement.transaction;

        // One transfer of the price from payer to payTo, in the asset; the fee paid by a facilitator
        // account through a fee bump around a facilitator channel.
        const onChain = await onChainSettlement(net.server, net.passphrase, hash);
        expect(onChain.transfers).toEqual(paying.expectedTransfers(payer.address, payTo, price.base));
        expect(signers).toContain(onChain.feeSource);
        expect(signers).toContain(onChain.innerSource);
        expect(onChain.feeSource).toBe(sponsor.publicKey());

        // Non-custody: the parties' balances move by the price, no facilitator account holds or moves
        // the asset, and the sponsor spent exactly the fee.
        const after = await balances();
        expect(after.payer).toBe(before.payer - price.base);
        expect(after.payTo).toBe(before.payTo + price.base);
        expect(after.facilitator).toEqual(before.facilitator);
        expect(after.facilitator.every((balance) => balance === 0n)).toBe(true);
        expect(before.sponsorXlm - after.sponsorXlm).toBe(onChain.feeChargedStroops);

        // The Bazaar lists the resource with the token's facts read from the chain.
        const item = await until(
          () => discovery(service.url, payTo),
          (items) => items[0]?.rail402.options[0]?.decimals !== undefined,
        ).then((items) => items[0]);
        expect(item?.accepts).toEqual([
          expect.objectContaining({ asset: asset.contract, amount: price.base.toString(), payTo }),
        ]);
        expect(item?.rail402.options[0]).toMatchObject({ symbol, decimals: asset.decimals });
        // A contract account can always receive; a G… account's receivability is decided for a classic
        // asset (its trustline) and unknown for a custom token.
        if (asset.kind === "sep41" && payToKind === "G") {
          expect(item?.rail402.options[0]?.receivable).toBeUndefined();
        } else {
          expect(item?.rail402.options[0]?.receivable).toBe(true);
        }
      },
    );

    it("refuses a payer holding less than the amount, or none of the token, as insufficient_funds", async () => {
      const paying = driver(symbol);
      const client = new HTTPFacilitatorClient({ url: service.url });
      const payTo = await paying.recipient("G");
      const amount = PRICE[symbol]?.base ?? 1n;
      const short = await paying.payer("G", amount - 1n);
      // No balance: for a token, no balance entry at all; for a classic asset, an empty trustline.
      const empty = await paying.payer("G", 0n);
      for (const payer of [short, empty]) {
        if (payer.kind !== "G") throw new Error("G payers only");
        const built = await buildTransfer({
          payer: payer.keypair,
          asset: paying.asset.contract,
          to: payTo,
          amount,
          nonce: BigInt(Math.floor(Math.random() * 2 ** 40)),
          expirationLedger: (await net.latestLedger()) + 12,
        });
        const requirements = paying.requirements(payTo, amount) as PaymentRequirements;
        const payload = {
          x402Version: 2,
          resource: { url: "https://seller.example/resource" },
          accepted: requirements,
          payload: { transaction: built.xdr },
        } as PaymentPayload;
        expect(await client.verify(payload, requirements)).toMatchObject({
          isValid: false,
          invalidReason: "insufficient_funds",
        });
        const settled = await client.settle(payload, requirements).catch((error: unknown) => error);
        expect(JSON.stringify(settled)).toContain("insufficient_funds");
      }
      expect(await net.tokenBalance(paying.asset.contract, payTo)).toBe(0n);
    });

    it("searches the listing by the asset's symbol and a ceiling in whole units", async () => {
      const price = PRICE[symbol];
      if (price === undefined) throw new Error(`no price for ${symbol}`);
      const search = (maxPrice: string) =>
        fetch(
          `${service.url}/discovery/search?query=report&asset=${symbol}&maxPrice=${maxPrice}&limit=50`,
        ).then(async (response) => (await response.json()) as { resources: DiscoveryItem[] });
      // At least the three exact listings of this asset (upto listings join them later in the run).
      const matching = await until(
        () => search(price.above),
        (result) => result.resources.length >= cases.length,
      );
      const contract = driver(symbol).asset.contract;
      expect(
        matching.resources.every((item) => item.accepts.every((option) => option.asset === contract)),
      ).toBe(true);
      expect((await search(price.below)).resources).toEqual([]);
    });
  });

  describe.each(["USDC", "TEST6", "TEST18"])("upto %s", (symbol) => {
    it.each(cases)(
      "a $payer… payer authorizes a cap for a $payTo… payTo; the seller settles part of it and only that moves",
      async ({ payer: payerKind, payTo: payToKind }) => {
        const paying = driver(symbol, "upto");
        const { asset } = paying;
        const price = PRICE[symbol];
        if (price === undefined) throw new Error(`no price for ${symbol}`);
        // The cap is the listed price; the seller charges 40 % of it after serving the request.
        const cap = price.base;
        const actual = (cap * 2n) / 5n;
        const [payer, payTo] = await Promise.all([
          paying.payer(payerKind, cap * 2n),
          paying.recipient(payToKind),
        ]);
        const path = `/metered/${symbol.toLowerCase()}/${payerKind}-${payToKind}`;
        const seller = await startUptoSeller(service.url, path, {
          payTo,
          price: { amount: cap.toString(), asset: asset.contract },
          actual,
        });
        sellers.push(seller);

        const balances = async () => ({
          payer: await net.tokenBalance(asset.contract, payer.address),
          payTo: await net.tokenBalance(asset.contract, payTo),
          facilitator: await Promise.all(signers.map((signer) => net.tokenBalance(asset.contract, signer))),
          sponsorXlm: await net.nativeBalance(sponsor.publicKey()),
        });
        const before = await balances();

        const buyer = wrapFetchWithPaymentFromConfig(fetch, {
          schemes: [
            {
              network: NETWORK,
              client: {
                scheme: "upto",
                createPaymentPayload: async (x402Version: number, requirements: PaymentRequirements) => {
                  expect(requirements.amount).toBe(cap.toString());
                  const payment = await paying.pay(payer, requirements as unknown as DriverRequirements);
                  return { x402Version, payload: payment.payload };
                },
              },
            },
          ],
          spendControls: false,
        });
        const response = await buyer(`${seller.url}${path}`);
        expect(response.status, await response.clone().text()).toBe(200);
        const header = response.headers.get("payment-response");
        if (header === null) throw new Error("no PAYMENT-RESPONSE");
        const settlement = decodePaymentResponseHeader(header);
        expect(settlement).toMatchObject({
          success: true,
          network: NETWORK,
          payer: payer.address,
          amount: actual.toString(),
        });

        const onChain = await onChainSettlement(net.server, net.passphrase, settlement.transaction);
        expect(onChain.transfers).toEqual(paying.expectedTransfers(payer.address, payTo, cap, actual));
        expect(onChain.feeSource).toBe(sponsor.publicKey());
        expect(signers).toContain(onChain.innerSource);

        // Non-custody: only the settled amount moves, straight from payer to payTo; no facilitator
        // account (sponsor, channels, settlement authority) holds or moves the asset.
        const after = await balances();
        expect(after.payer).toBe(before.payer - actual);
        expect(after.payTo).toBe(before.payTo + actual);
        expect(after.facilitator).toEqual(before.facilitator);
        expect(after.facilitator.every((balance) => balance === 0n)).toBe(true);
        expect(before.sponsorXlm - after.sponsorXlm).toBe(onChain.feeChargedStroops);

        // The Bazaar lists the upto resource at its cap, with the token's facts read from the chain.
        const item = await until(
          () => discovery(service.url, payTo),
          (items) => items[0]?.rail402.options[0]?.decimals !== undefined,
        ).then((items) => items[0]);
        expect(item?.accepts).toEqual([
          expect.objectContaining({ scheme: "upto", asset: asset.contract, amount: cap.toString(), payTo }),
        ]);
        expect(item?.rail402.options[0]).toMatchObject({ symbol, decimals: asset.decimals });
      },
    );
  });

  it("refuses to start when a configured asset's decimals differ from the chain's", async () => {
    const token = driver("TEST6").asset.contract;
    const wrong = await ServiceProcess.start({
      entry: MAIN,
      env: {
        ...base,
        TESTNET_SPONSOR_SECRET: sponsor.secret(),
        TESTNET_AUTO_PROVISION_CHANNELS: "false",
        TESTNET_ASSETS: `${token}:TEST6:7`,
      },
    });
    const exit = await wrong.exited;
    expect(exit.code).toBe(78);
    expect(wrong.stderr).toContain(
      `rail402: asset_decimals_mismatch: TESTNET_ASSETS: TEST6 (${token}) has 6 decimals on stellar:testnet, but 7 are configured`,
    );
  });

  it("refuses to start when a configured asset is a contract but not a token", async () => {
    const deployer = Keypair.random();
    await net.fund(deployer);
    const account = await deploySimpleAccount(net, deployer, Keypair.random());
    const wrong = await ServiceProcess.start({
      entry: MAIN,
      env: {
        ...base,
        TESTNET_SPONSOR_SECRET: sponsor.secret(),
        TESTNET_AUTO_PROVISION_CHANNELS: "false",
        TESTNET_ASSETS: `${account}:ACCT:7`,
      },
    });
    expect((await wrong.exited).code).toBe(78);
    expect(wrong.stderr).toContain("rail402: asset_not_a_token: TESTNET_ASSETS: ACCT");
  });

  it("starts but is not ready while a configured asset is not deployed", async () => {
    const missing = randomContractId();
    const waiting = await ServiceProcess.start({
      entry: MAIN,
      env: {
        ...base,
        TESTNET_SPONSOR_SECRET: sponsor.secret(),
        TESTNET_ASSETS: `${missing}:NONE:7`,
        BAZAAR_ENABLED: "false",
      },
    });
    await waiting.listening();
    const response = await fetch(`${waiting.url}/ready`);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { checks: Record<string, { ok: boolean; detail?: string }> };
    expect(body.checks["stellar:testnet:assets"]).toEqual({
      ok: false,
      detail: `NONE (${missing}) is not deployed on stellar:testnet`,
    });
    await waiting.kill("SIGTERM");
  });
});

interface Seller {
  readonly url: string;
  close(): Promise<void>;
}

/** A stock @x402/express seller of one resource with the Bazaar extension, settling through Rail402. */
async function startSeller(facilitator: string, path: string, option: object): Promise<Seller> {
  const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: facilitator }))
    .register(NETWORK, new ExactStellarServer())
    .registerExtension(bazaarResourceServerExtension);
  const app = express();
  app.use(
    paymentMiddleware(
      {
        [`GET ${path}`]: {
          accepts: option as never,
          description: "A market report priced in a SEP-41 token",
          mimeType: "application/json",
          extensions: declareDiscoveryExtension({
            output: { example: { report: "calm" } },
          }),
        },
      },
      resourceServer,
    ),
  );
  app.get(path, (_request, response) => {
    response.json({ report: "calm" });
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => listener.once("listening", resolve));
  return {
    url: `http://127.0.0.1:${String((listener.address() as AddressInfo).port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        listener.closeAllConnections();
        listener.close(() => {
          resolve();
        });
      }),
  };
}

/**
 * A stock @x402/express seller of one `upto` resource with the Bazaar extension: the price is the cap,
 * and the handler charges `actual` through the stock settlement override once it has served.
 */
async function startUptoSeller(
  facilitator: string,
  path: string,
  options: { payTo: string; price: { amount: string; asset: string }; actual: bigint },
): Promise<Seller> {
  const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: facilitator }))
    .register(NETWORK, new UptoServer())
    .registerExtension(bazaarResourceServerExtension);
  const app = express();
  app.use(
    paymentMiddleware(
      {
        [`GET ${path}`]: {
          accepts: { scheme: "upto", network: NETWORK, payTo: options.payTo, price: options.price },
          description: "A metered market report, billed by the rows returned",
          mimeType: "application/json",
          extensions: declareDiscoveryExtension({ output: { example: { rows: 40 } } }),
        },
      },
      resourceServer,
    ),
  );
  app.get(path, (_request, response) => {
    setSettlementOverrides(response, uptoSettlementOverrides(options.actual));
    response.json({ rows: 40 });
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => listener.once("listening", resolve));
  return {
    url: `http://127.0.0.1:${String((listener.address() as AddressInfo).port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        listener.closeAllConnections();
        listener.close(() => {
          resolve();
        });
      }),
  };
}

/** The settlement authority `/supported` advertises for upto on the network. */
function uptoAuthority(supported: unknown): string {
  const kinds = (supported as { kinds: { scheme: string; extra?: { facilitatorAddress?: unknown } }[] })
    .kinds;
  const address = kinds.find((kind) => kind.scheme === "upto")?.extra?.facilitatorAddress;
  if (typeof address !== "string") throw new Error("the service does not advertise upto");
  return address;
}

async function discovery(facilitator: string, payTo: string): Promise<DiscoveryItem[]> {
  const response = await fetch(`${facilitator}/discovery/resources?payTo=${payTo}`);
  return ((await response.json()) as { items: DiscoveryItem[] }).items;
}
