/**
 * The upto TTL keeper's spend accounting, on the private Stellar network.
 *
 * Every extension reserves its fee ceiling as sponsor spend before it is submitted, within the daily
 * cap and the network's hourly budget, and is corrected to the fee charged once that is known. A
 * transaction whose outcome is unknown (the RPC connection failed after broadcast) may still land, so
 * its ceiling stays counted: the keeper can never spend past its caps, whatever the network does.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keypair, rpc } from "@stellar/stellar-sdk";
import { MemorySettlementLedger, MemoryTaskLock, silentLogger } from "@rail402.dev/facilitator";
import { Metrics, UPTO_TTL_SPEND, UptoTtlKeeper, type UptoTtlConfig } from "@rail402.dev/service";
import {
  LocalNetwork,
  deployUpto,
  startRpcProxy,
  type LocalUptoContract,
  type RpcProxy,
} from "@rail402.dev/testkit";

const net = new LocalNetwork();
const available = await net.available();
const NETWORK = "stellar:testnet";
const CEILING = 100_000_000;

describe.skipIf(!available)("upto TTL keeper spend", () => {
  let contract: LocalUptoContract;
  let proxy: RpcProxy;

  beforeAll(async () => {
    contract = await deployUpto(net);
    proxy = await startRpcProxy(net.rpcUrl);
  });

  afterAll(async () => {
    await proxy.close();
  });

  const keeperWith = async (ttl: Partial<UptoTtlConfig>, hourlyBudgetStroops?: bigint) => {
    const sponsor = Keypair.random();
    await net.fund(sponsor);
    const ledger = new MemorySettlementLedger();
    const keeper = new UptoTtlKeeper({
      network: NETWORK,
      server: new rpc.Server(proxy.url, { allowHttp: true }),
      passphrase: net.passphrase,
      sponsor,
      contract: contract.address,
      wasmHash: contract.wasmHash,
      ttl: {
        keeper: true,
        extendBelowLedgers: 5,
        extendToLedgers: 10_000,
        autoRestore: false,
        maxFeeStroops: CEILING,
        ...ttl,
      },
      inclusionFeeStroops: 100,
      sponsorReserveStroops: 0n,
      lock: new MemoryTaskLock(),
      metrics: new Metrics(),
      log: silentLogger,
      spend: {
        reserve: (fee, limits) => ledger.reserveSponsorSpend(NETWORK, UPTO_TTL_SPEND, fee, limits),
        settle: (id, fee) => ledger.settleSponsorSpend(id, fee),
      },
      ...(hourlyBudgetStroops === undefined ? {} : { hourlyBudgetStroops }),
    });
    const spent = () => ledger.sponsorSpendSince(NETWORK, new Date(Date.now() - 86_400_000), UPTO_TTL_SPEND);
    return { keeper, ledger, sponsor, spent };
  };

  it("records the fee charged once an extension lands, not its ceiling", async () => {
    const { keeper, spent } = await keeperWith({});
    const round = await keeper.maintain("extend");
    const fee = round.transactions[0]?.feeChargedStroops;
    expect(fee).toBeGreaterThan(0n);
    expect(fee).toBeLessThan(BigInt(CEILING));
    expect(await spent()).toBe(fee);
  }, 60_000);

  it("keeps the ceiling counted when an extension's outcome is unknown, so the daily cap holds", async () => {
    const { keeper, sponsor, spent } = await keeperWith({ dailyMaxFeeStroops: CEILING });
    proxy.loseSendResponses = true;
    try {
      // Broadcast, but the answer is lost: the transaction may land at any time within its bounds.
      await expect(keeper.maintain("extend")).rejects.toThrow(/unknown outcome/);
    } finally {
      proxy.loseSendResponses = false;
    }
    const counted = await spent();
    // The ceiling, or the fee charged if the transaction was already found: never less.
    expect(counted).toBeGreaterThan(0n);
    expect(counted).toBeLessThanOrEqual(BigInt(CEILING));

    const sent = proxy.sent.length;
    const before = await net.nativeBalance(sponsor.publicKey());
    await expect(keeper.maintain("extend")).rejects.toThrow(/daily cap of 100000000/);
    expect(proxy.sent.length).toBe(sent);
    expect(await net.nativeBalance(sponsor.publicKey())).toBe(before);
  }, 60_000);

  it("waits when its ceiling would pass the network's hourly fee budget", async () => {
    const { keeper, ledger, spent } = await keeperWith({}, BigInt(CEILING) + 1_000n);
    // Settlement claims already committed most of the hour's budget.
    await ledger.claim(
      { network: NETWORK, payer: "GPAYER", nonce: "1" },
      { payloadHash: "p", requestHash: "r" },
      "o",
      60_000,
      {
        reserveFeeStroops: 2_000n,
        limits: [{ scope: "network", capStroops: 1_000_000_000n, since: new Date(0) }],
      },
    );
    const sent = proxy.sent.length;
    await expect(keeper.maintain("extend")).rejects.toThrow(/hourly budget of 100001000/);
    expect(proxy.sent.length).toBe(sent);
    expect(await spent()).toBe(0n);
  }, 60_000);
});
