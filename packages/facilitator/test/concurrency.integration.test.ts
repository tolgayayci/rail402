/**
 * Concurrent settlement on the private Stellar network: 3 batches of 20 payments over 8 channel
 * accounts, so settlements queue for channels, with 2 payments of each batch sent twice at once.
 * Every submission passes through the RPC proxy, which counts what the network answered. The same
 * run is made with `exact` payments, with `upto` payments settling part of their cap, and with the
 * two mixed in every batch, all on one facilitator and one channel pool.
 *
 * Invariants: every payment settles once, in its own transaction, from a distinct (channel, sequence)
 * pair; the duplicates receive the original's response and move nothing; no submission meets a
 * sequence conflict (`txBadSeq`, `TRY_AGAIN_LATER`); every channel is released after each batch.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { UptoStellarScheme as UptoClient } from "@rail402.dev/upto/client";
import {
  acceptedAsset,
  createStellarFacilitator,
  deriveAuthorityKeypair,
  deriveChannelKeypairs,
  provisionAuthority,
  provisionChannels,
  silentObserver,
  type StellarFacilitator,
  type SubmissionEvent,
} from "@rail402.dev/facilitator";
import {
  LocalNetwork,
  classicTestAsset,
  deployUpto,
  exactDriver,
  onChainSettlement,
  sequenceConflicts,
  startRpcProxy,
  uptoDriver,
  type IssuedAsset,
  type PaymentDriver,
  type RpcProxy,
} from "@rail402.dev/testkit";

const net = new LocalNetwork();
const available = await net.available();
const NETWORK = "stellar:testnet";
const CHANNELS = 8;
const BATCHES = 3;
const SIZE = 20;
const DUPLICATES = 2;
const AMOUNT = 3_000_000n;
const START = 100_000_000n; // net.holders(…, "10") in base units

/** The response body without its server-internal extension responses (the repeat marker). */
function bodyOf(response: SettleResponse): SettleResponse {
  const { extensionResponses: _internal, ...body } = response;
  return body;
}

type Mix = "exact" | "upto" | "mixed";

describe.skipIf(!available)("concurrent settlements on a live network", () => {
  let usdc: IssuedAsset;
  let sponsor: Keypair;
  let seller: Keypair;
  let proxy: RpcProxy;
  let facilitator: StellarFacilitator;
  let drivers: { exact: PaymentDriver; upto: PaymentDriver };
  const submissions: SubmissionEvent[] = [];
  const leaseWaits: number[] = [];

  beforeAll(async () => {
    const [issued, contract] = await Promise.all([net.issueAsset("USDC"), deployUpto(net)]);
    usdc = issued;
    sponsor = Keypair.random();
    await net.fund(sponsor);
    await provisionChannels({
      server: net.server,
      passphrase: net.passphrase,
      sponsor,
      channels: deriveChannelKeypairs(sponsor, NETWORK, CHANNELS),
    });
    const authority = deriveAuthorityKeypair(sponsor, NETWORK);
    await provisionAuthority({ server: net.server, passphrase: net.passphrase, sponsor, authority });
    const asset = classicTestAsset(net, usdc);
    drivers = {
      exact: exactDriver(net, asset),
      upto: uptoDriver(net, asset, {
        contract: contract.address,
        authority: authority.publicKey(),
        client: (...args: ConstructorParameters<typeof UptoClient>) => new UptoClient(...args),
      }),
    };
    [seller] = (await net.holders(usdc, 1, "0")) as [Keypair];
    proxy = await startRpcProxy(net.rpcUrl);
    facilitator = createStellarFacilitator({
      networks: [
        {
          network: NETWORK,
          rpcUrl: proxy.url,
          sponsorSecret: sponsor.secret(),
          channelCount: CHANNELS,
          assets: [acceptedAsset({ contract: usdc.sac, symbol: "USDC", decimals: 7 })],
          policy: { maxTransactionFeeStroops: 2_000_000 },
          timing: { pollIntervalMs: 250, channelWaitMs: 30_000 },
          upto: { contract: contract.address, contractWasmHash: contract.wasmHash, ledgerSeconds: 5 },
        },
      ],
      observer: {
        ...silentObserver,
        submission: (_network, event) => submissions.push(event),
        leaseWait: (_network, ms) => leaseWaits.push(ms),
      },
    });
  });

  afterAll(async () => {
    // Unset when beforeAll failed before starting it.
    await (proxy as RpcProxy | undefined)?.close();
  });

  /**
   * One payment of AMOUNT to the seller: `exact` for the price, `upto` authorizing twice AMOUNT and
   * settling AMOUNT.
   */
  const pay = async (payer: Keypair, scheme: "exact" | "upto") => {
    const driver = drivers[scheme];
    const published = driver.requirements(seller.publicKey(), scheme === "exact" ? AMOUNT : AMOUNT * 2n);
    const payload = (await driver.pay(
      { kind: "G", address: payer.publicKey(), keypair: payer },
      published,
    )) as unknown as PaymentPayload;
    return { payload, requirements: driver.settleRequirements(published, AMOUNT) as PaymentRequirements };
  };

  const schemeOf = (mix: Mix, index: number): "exact" | "upto" =>
    mix === "mixed" ? (index % 2 === 0 ? "exact" : "upto") : mix;

  it.each<Mix>(["exact", "upto", "mixed"])(
    `settles ${BATCHES} batches of ${SIZE} %s payments over ${CHANNELS} channels with injected duplicates, without a collision`,
    async (mix) => {
      const pairs = new Set<string>();
      const hashes = new Set<string>();
      proxy.reset();
      submissions.length = 0;
      leaseWaits.length = 0;
      const sellerBefore = await net.tokenBalance(usdc.sac, seller.publicKey());

      for (let batch = 0; batch < BATCHES; batch++) {
        const payers = await net.holders(usdc, SIZE, "10");
        const payments = await Promise.all(payers.map((payer, index) => pay(payer, schemeOf(mix, index))));
        // Each duplicate is sent at the same time as its original.
        const requests = [...payments, ...payments.slice(0, DUPLICATES)];
        const results = await Promise.all(
          requests.map(({ payload, requirements }) => facilitator.core.settle(payload, requirements)),
        );
        const originals = results.slice(0, SIZE);
        const failures = originals.filter((result) => !result.success);
        expect(failures, JSON.stringify(failures)).toEqual([]);

        // A duplicate and its original answer the same body; exactly one of the two is marked a repeat.
        for (let index = 0; index < DUPLICATES; index++) {
          const first = results[index] as SettleResponse;
          const second = results[SIZE + index] as SettleResponse;
          expect(bodyOf(second)).toEqual(bodyOf(first));
          const marked = [first, second].filter((result) => result.extensionResponses !== undefined);
          expect(marked).toHaveLength(1);
        }

        // One transaction per payment, each from its own (channel, sequence), moving the amount once.
        const settled = await Promise.all(
          originals.map((result) => onChainSettlement(net.server, net.passphrase, result.transaction)),
        );
        for (const [index, onChain] of settled.entries()) {
          hashes.add(onChain.hash);
          pairs.add(`${onChain.innerSource}:${onChain.innerSequence}`);
          expect(onChain.feeSource).toBe(sponsor.publicKey());
          expect(onChain.transfers).toEqual([
            {
              contract: usdc.sac,
              from: payers[index]?.publicKey(),
              to: seller.publicKey(),
              amount: AMOUNT,
            },
          ]);
        }
        const balances = await Promise.all(
          payers.map((payer) => net.tokenBalance(usdc.sac, payer.publicKey())),
        );
        expect(balances.every((balance) => balance === START - AMOUNT)).toBe(true);
        expect(await facilitator.networks.get(NETWORK)?.channels.inUse()).toBe(0);
      }

      expect(hashes.size).toBe(BATCHES * SIZE);
      expect(pairs.size).toBe(BATCHES * SIZE);
      expect(await net.tokenBalance(usdc.sac, seller.publicKey())).toBe(
        sellerBefore + BigInt(BATCHES * SIZE) * AMOUNT,
      );

      // Every submission the network saw was accepted the first time: no sequence conflict, upstream's
      // included, and no rebroadcast was needed.
      expect(sequenceConflicts(proxy.answers)).toEqual([]);
      expect(Object.fromEntries(proxy.statuses.get("sendTransaction") ?? [])).toEqual({
        PENDING: BATCHES * SIZE,
      });
      const conflicts = submissions.filter(
        (event) => event.status === "TRY_AGAIN_LATER" || event.resultCode?.includes("txBadSeq") === true,
      );
      expect(conflicts).toEqual([]);
      // Fewer channels than payments: settlements waited for a lease, and every wait was granted.
      expect(leaseWaits).toHaveLength(BATCHES * SIZE);
      expect(Math.max(...leaseWaits)).toBeGreaterThan(0);
    },
    600_000,
  );
});
