/**
 * Two replicas of the service serving `upto` on one Postgres schema and one sponsor, started at the
 * same moment on a sponsor nothing was provisioned for, with the committed settlement contract
 * deployed per run and both replicas' RPC behind one proxy that records every broadcast:
 *
 * - startup: the replicas take turns provisioning, so the channel accounts and the settlement
 *   authority are each created by one transaction, no submission conflicts on the sponsor's
 *   sequence number, and both replicas become ready with the authority reported present;
 * - duplicates across replicas: one authorization settled concurrently through both replicas for the
 *   same amount lands one transaction, and every caller gets its answer; settled concurrently for
 *   different amounts it lands one transaction and every other request is refused as a conflict;
 * - health: both replicas warn once the authority can spend XLM or holds an accepted token.
 *
 * Needs `docker compose --profile stellar up -d` and Postgres.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Asset, Keypair, Operation } from "@stellar/stellar-sdk";
import type { PaymentRequirements } from "@x402/core/types";
import { authorityStatus, existingAccounts } from "@rail402.dev/facilitator";
import {
  LocalNetwork,
  deployUpto,
  pinHorizon,
  sequenceConflicts,
  startRpcProxy,
  type HorizonPin,
  type IssuedAsset,
  type LocalUptoContract,
  type RpcProxy,
} from "@rail402.dev/testkit";
import {
  CAP,
  LEDGER_SECONDS,
  NETWORK,
  accountPayer,
  codeOf,
  custody,
  expectSettledOnce,
  post,
  startUptoService,
  uptoPayment,
  uptoRequirements,
  withAmount,
  type UptoService,
} from "./upto-harness.ts";
import { createServiceSchema, dropServiceSchema } from "./service-harness.ts";

const net = new LocalNetwork();
const available = await net.available();
const REQUESTS = 20;

async function ready(service: UptoService): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (!(await service.runtime.readiness()).ready) {
    if (Date.now() > deadline) throw new Error("the service did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe.skipIf(!available)("two upto replicas on one Postgres", () => {
  let horizon: HorizonPin;
  let usdc: IssuedAsset;
  let contract: LocalUptoContract;
  let recipient: Keypair;
  let proxy: RpcProxy;
  let schema: string | undefined;
  let replicas: UptoService[] = [];

  beforeAll(async () => {
    horizon = pinHorizon({ seconds: LEDGER_SECONDS });
    [usdc, contract] = await Promise.all([net.issueAsset("USDC"), deployUpto(net)]);
    recipient = await net.holder(usdc, "0");
    proxy = await startRpcProxy(net.rpcUrl);
    const sponsor = Keypair.random();
    await net.fund(sponsor);
    schema = await createServiceSchema();
    const env = {
      TESTNET_RPC_URL: proxy.url,
      SETTLE_CHANNEL_WAIT_MS: "30000",
      RECONCILE_INTERVAL_MS: "1000",
    };
    const replicaOf = { sponsor, schema };
    // Both replicas start at once, as a redeploy with two replicas does.
    const started = await Promise.allSettled([
      startUptoService(net, usdc, contract, env, { replicaOf }),
      startUptoService(net, usdc, contract, env, { replicaOf }),
    ]);
    replicas = started.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    const failed = started.find((result) => result.status === "rejected");
    if (failed !== undefined) throw failed.reason;
    await Promise.all(replicas.map(ready));
  }, 240_000);

  afterAll(async () => {
    await Promise.all(replicas.map((replica) => replica.stop()));
    await proxy.close();
    if (schema !== undefined) await dropServiceSchema(schema);
    horizon.restore();
  });

  const [a, b] = [() => replicas[0] as UptoService, () => replicas[1] as UptoService];

  function requirements(): PaymentRequirements {
    return uptoRequirements({
      asset: usdc.sac,
      payTo: recipient.publicKey(),
      authority: a().authority.publicKey(),
    });
  }

  it("provisions the channels and the settlement authority once when both start together", async () => {
    // One transaction created the channel accounts and one the authority; none was refused.
    expect(new Set(proxy.sent).size).toBe(2);
    expect(sequenceConflicts(proxy.answers)).toEqual([]);
    const channels = a().channels.map((channel) => channel.publicKey());
    expect((await existingAccounts(net.server, channels)).size).toBe(channels.length);
    expect(await authorityStatus(net.server, a().authority.publicKey())).toMatchObject({
      exists: true,
      balanceStroops: 0n,
      spendableStroops: 0n,
    });
    expect(b().authority.publicKey()).toBe(a().authority.publicKey());
    for (const replica of replicas) {
      await expect
        .poll(() => replica.runtime.health().networks[NETWORK]?.upto?.authority, { timeout: 30_000 })
        .toMatchObject({ present: true, spendableStroops: "0", tokens: [] });
      expect(replica.runtime.health().warnings.filter((warning) => warning.code.startsWith("upto_"))).toEqual(
        [],
      );
    }
  });

  it(`lands one transaction for ${String(REQUESTS)} identical settlements split across the replicas`, async () => {
    const keys = await net.holder(usdc, "1");
    const payload = await uptoPayment(net, {
      contract: contract.address,
      payer: accountPayer(keys),
      accepted: requirements(),
    });
    const before = await custody(net, a(), usdc.sac, keys.publicKey(), recipient.publicKey());
    const sent = proxy.sent.length;
    const results = await Promise.all(
      Array.from({ length: REQUESTS }, (_, index) =>
        post((index % 2 === 0 ? a() : b()).url, "/settle", payload, withAmount(requirements(), 7_000n)),
      ),
    );
    expect(results.every((result) => result.body["success"] === true)).toBe(true);
    const hashes = new Set(results.map((result) => result.body["transaction"]));
    expect(hashes.size).toBe(1);
    expect(new Set(proxy.sent.slice(sent)).size).toBe(1);
    await expectSettledOnce(net, {
      service: a(),
      token: usdc.sac,
      payer: keys.publicKey(),
      recipient: recipient.publicKey(),
      amount: 7_000n,
      cap: CAP,
      transaction: String([...hashes][0]),
      before,
    });
  });

  it("lands one transaction for settlements of different amounts across the replicas and refuses the rest", async () => {
    const keys = await net.holder(usdc, "1");
    const payload = await uptoPayment(net, {
      contract: contract.address,
      payer: accountPayer(keys),
      accepted: requirements(),
    });
    const sent = proxy.sent.length;
    const results = await Promise.all(
      Array.from({ length: REQUESTS }, (_, index) =>
        post(
          (index % 2 === 0 ? a() : b()).url,
          "/settle",
          payload,
          withAmount(requirements(), BigInt(1_000 + index)),
        ),
      ),
    );
    const settled = results.filter((result) => result.body["success"] === true);
    expect(settled).toHaveLength(1);
    const winner = settled[0]?.body;
    expect(results.filter((result) => result.body["success"] !== true).map(codeOf)).toEqual(
      Array.from({ length: REQUESTS - 1 }, () => "settle_upto_stellar_idempotency_conflict"),
    );
    expect(new Set(proxy.sent.slice(sent)).size).toBe(1);
    expect(await net.tokenBalance(usdc.sac, keys.publicKey())).toBe(
      10_000_000n - BigInt(String(winner?.["amount"])),
    );
    expect(await net.tokenBalance(usdc.sac, a().authority.publicKey())).toBe(0n);

    // Either replica names the settlement and its amount once it is final.
    for (const replica of replicas) {
      const late = await post(replica.url, "/settle", payload, withAmount(requirements(), 2_000n));
      expect(late.body).toMatchObject({
        success: false,
        errorReason: "settle_upto_stellar_idempotency_conflict",
        transaction: winner?.["transaction"],
      });
      expect(late.body["errorMessage"]).toContain(String(winner?.["amount"]));
    }
    expect(sequenceConflicts(proxy.answers)).toEqual([]);
  });
  it("warns on every replica once the authority can spend XLM or holds a token", async () => {
    // Runs last: it leaves the authority holding funds.
    const authority = a().authority;
    const funder = Keypair.random();
    await net.fund(funder);
    await net.classic(funder, [
      Operation.payment({ destination: authority.publicKey(), asset: Asset.native(), amount: "10" }),
    ]);
    await net.trust(authority, usdc);
    await net.mint(usdc, authority.publicKey(), "0.5");
    for (const replica of replicas) {
      await expect
        .poll(
          () =>
            replica.runtime
              .health()
              .warnings.filter((warning) => warning.code.startsWith("upto_"))
              .map((warning) => [warning.code, warning.contract]),
          { timeout: 30_000 },
        )
        .toEqual([
          ["upto_authority_funded", undefined],
          ["upto_authority_holds_tokens", usdc.sac],
        ]);
      const reported = replica.runtime.health().networks[NETWORK]?.upto?.authority;
      expect(BigInt(reported?.spendableStroops ?? "0")).toBeGreaterThan(90_000_000n);
      expect(reported?.tokens).toEqual([{ symbol: "USDC", contract: usdc.sac, balance: "5000000" }]);
    }
  });
});
