/**
 * Two replicas of the service on one Postgres schema and one sponsor, so both lease the same 12
 * derived channel accounts and share one settlement ledger. 3 batches of 20 payments: each payment
 * goes to replica A and, at the same time, its duplicate to replica B.
 *
 * Invariants: 20 transactions per batch from distinct (channel, sequence) pairs, one transfer per
 * payment, the two responses of every pair identical with exactly one marked as a repeat, every
 * envelope sent once (no reconciler rebroadcasts the other replica's in-flight settlements), no
 * sequence conflict at the network or in either replica's metrics, and every channel released after
 * each batch.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { HTTPFacilitatorClient } from "@x402/core/http";
import type { SettleResponse } from "@x402/core/types";
import {
  LocalNetwork,
  onChainSettlement,
  requirementsFor,
  sequenceConflicts,
  startRpcProxy,
  type IssuedAsset,
  type RpcProxy,
} from "@rail402.dev/testkit";
import {
  createServiceSchema,
  dropServiceSchema,
  startService,
  type RunningService,
} from "./service-harness.ts";

const net = new LocalNetwork();
const available = await net.available();
const NETWORK = "stellar:testnet";
const BATCHES = 3;
const SIZE = 20;
const AMOUNT = 1_000_000n;
const START = 100_000_000n; // net.holders(…, "10") in base units

function bodyOf(response: SettleResponse): SettleResponse {
  const { extensionResponses: _internal, ...body } = response;
  return body;
}

async function ready(service: RunningService): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (!(await service.runtime.readiness()).ready) {
    if (Date.now() > deadline) throw new Error("the service did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Sum of every sample of a counter in a Prometheus exposition, or of those carrying `label`. */
function total(exposition: string, name: string, label = ""): number {
  return exposition
    .split("\n")
    .filter((line) => line.startsWith(`${name}{`) || line.startsWith(`${name} `))
    .filter((line) => line.includes(label))
    .reduce((sum, line) => sum + Number(line.slice(line.lastIndexOf(" ") + 1)), 0);
}

describe.skipIf(!available)("two service replicas on one Postgres", () => {
  let usdc: IssuedAsset;
  let seller: Keypair;
  let proxy: RpcProxy;
  let schema: string | undefined;
  let a: RunningService | undefined;
  let b: RunningService | undefined;

  beforeAll(async () => {
    usdc = await net.issueAsset("USDC");
    [seller] = (await net.holders(usdc, 1, "0")) as [Keypair];
    proxy = await startRpcProxy(net.rpcUrl);
    const sponsor = Keypair.random();
    await net.fund(sponsor);
    schema = await createServiceSchema();
    const env = {
      TESTNET_RPC_URL: proxy.url,
      TESTNET_CHANNEL_COUNT: "12",
      SETTLE_CHANNEL_WAIT_MS: "30000",
      RECONCILE_INTERVAL_MS: "1000",
      BAZAAR_ENABLED: "false",
    };
    const replicaOf = { sponsor, schema };
    // A migrates and provisions the channels; B starts on what A left.
    const first = await startService(net, usdc, env, { replicaOf });
    a = first;
    await ready(first);
    const second = await startService(net, usdc, env, { replicaOf });
    b = second;
    await ready(second);
  });

  afterAll(async () => {
    await Promise.all([a?.stop(), b?.stop()]);
    // Unset when beforeAll failed before starting it.
    await (proxy as RpcProxy | undefined)?.close();
    if (schema !== undefined) await dropServiceSchema(schema);
  });

  it(`settles ${BATCHES} batches of ${SIZE} with every duplicate sent to the other replica`, async () => {
    if (a === undefined || b === undefined) throw new Error("replicas not started");
    const toA = new HTTPFacilitatorClient({ url: a.url });
    const toB = new HTTPFacilitatorClient({ url: b.url });
    const pairs = new Set<string>();
    // Count settlements only, not the channel provisioning replica A submitted at startup.
    proxy.reset();

    for (let batch = 0; batch < BATCHES; batch++) {
      const payers = await net.holders(usdc, SIZE, "10");
      const payments = await Promise.all(
        payers.map(async (payer) => {
          const terms = requirementsFor(usdc.sac, seller.publicKey(), AMOUNT);
          const payload = await net.payment(payer, terms);
          return { payload, requirements: terms };
        }),
      );
      const answered = await Promise.all(
        payments.map(({ payload, requirements }) =>
          Promise.all([toA.settle(payload, requirements), toB.settle(payload, requirements)]),
        ),
      );

      // 40 responses, identical per pair; one of each pair settled it, the other is the repeat.
      for (const [fromA, fromB] of answered) {
        expect(fromA).toMatchObject({ success: true, network: NETWORK });
        expect(bodyOf(fromB)).toEqual(bodyOf(fromA));
        const marked = [fromA, fromB].filter((result) => result.extensionResponses !== undefined);
        expect(marked).toHaveLength(1);
      }
      const hashes = new Set(answered.map(([fromA]) => fromA.transaction));
      expect(hashes.size).toBe(SIZE);

      for (const [index, [fromA]] of answered.entries()) {
        const onChain = await onChainSettlement(net.server, net.passphrase, fromA.transaction);
        pairs.add(`${onChain.innerSource}:${onChain.innerSequence}`);
        expect(onChain.transfers).toEqual([
          { contract: usdc.sac, from: payers[index]?.publicKey(), to: seller.publicKey(), amount: AMOUNT },
        ]);
      }
      const balances = await Promise.all(
        payers.map((payer) => net.tokenBalance(usdc.sac, payer.publicKey())),
      );
      expect(balances.every((balance) => balance === START - AMOUNT)).toBe(true);
      expect(await a.runtime.facilitator.networks.get(NETWORK)?.channels.inUse()).toBe(0);
    }

    expect(pairs.size).toBe(BATCHES * SIZE);
    // One envelope per payment, each sent once and accepted on its first submission: neither
    // replica's reconciler rebroadcasts a settlement whose request, on either replica, is confirming it.
    expect(new Set(proxy.answers.map((answer) => answer.transaction)).size).toBe(BATCHES * SIZE);
    expect(proxy.answers).toHaveLength(BATCHES * SIZE);
    expect(sequenceConflicts(proxy.answers)).toEqual([]);

    // Across both replicas: 60 settlements counted and 60 repeats. Sequence conflicts are judged by the
    // network's answers above: the conflict counter also counts a full queue (try_again_later) on a
    // busy network, which delays a submission without changing it.
    const [metricsA, metricsB] = await Promise.all([
      a.metrics.registry.metrics(),
      b.metrics.registry.metrics(),
    ]);
    const sum = (name: string, label?: string) => total(metricsA, name, label) + total(metricsB, name, label);
    expect(sum("rail402_settlements_total")).toBe(BATCHES * SIZE);
    expect(sum("rail402_settlement_repeats_total")).toBe(BATCHES * SIZE);
    expect(sum("rail402_sequence_conflicts_total", 'kind="bad_seq"')).toBe(0);
  }, 600_000);
});
