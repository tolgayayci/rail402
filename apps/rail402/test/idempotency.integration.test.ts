/**
 * Settlement idempotency on the private Stellar network, with the in-memory and the Postgres
 * settlement ledgers: a repeat is answered from the ledger before anything else is decided, a
 * different request for the same authorization is refused, and funds move once. `upto` payments
 * follow the same rules with the settled amount in the fingerprint: a repeat for another amount is a
 * conflict, never a second settlement. The last section drives the whole service over HTTP with the
 * stock facilitator client.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keypair, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { sql, type Kysely } from "kysely";
import { HTTPFacilitatorClient } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import {
  MemoryChannelPool,
  MemorySettlementLedger,
  acceptedAsset,
  createStellarFacilitator,
  deriveAuthorityKeypair,
  deriveChannelKeypairs,
  fingerprintOf,
  markRepeat,
  provisionAuthority,
  provisionChannels,
  settleFailed,
  type SettlementLedger,
  type SettlementTiming,
  type SponsorGuard,
  type StellarFacilitator,
} from "@rail402.dev/facilitator";
import { inspectExactTransaction, payerAuthorization } from "@rail402.dev/stellar";
import { decodeAuthorizationEntry } from "@rail402.dev/upto";
import { UptoStellarScheme as UptoClient } from "@rail402.dev/upto/client";
import {
  PostgresSettlementLedger,
  createDatabase,
  migrate,
  type Database,
} from "@rail402.dev/store-postgres";
import {
  LocalNetwork,
  classicTestAsset,
  deployUpto,
  onChainSettlement,
  requirementsFor,
  startRpcProxy,
  uptoDriver,
  type IssuedAsset,
  type LocalUptoContract,
  type PaymentDriver,
  type RpcProxy,
} from "@rail402.dev/testkit";
import { DATABASE_URL, startService, type RunningService } from "./service-harness.ts";

const net = new LocalNetwork();
const available = await net.available();
const NETWORK = "stellar:testnet";
const CHANNELS = 12;

const REPEAT = { rail402: { settlement: { repeat: true, settledBy: "rail402" } } };

/** The response body without its server-internal extension responses. */
function bodyOf(response: SettleResponse): SettleResponse {
  const { extensionResponses: _internal, ...body } = response;
  return body;
}

describe.skipIf(!available)("settlement idempotency on a live network", () => {
  let usdc: IssuedAsset;
  let sponsor: Keypair;
  let seller: Keypair;
  let proxy: RpcProxy;
  let contract: LocalUptoContract;
  let upto: PaymentDriver;
  const databases: Kysely<Database>[] = [];

  beforeAll(async () => {
    [usdc, contract] = await Promise.all([net.issueAsset("USDC"), deployUpto(net)]);
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
    upto = uptoDriver(net, classicTestAsset(net, usdc), {
      contract: contract.address,
      authority: authority.publicKey(),
      client: (...args: ConstructorParameters<typeof UptoClient>) => new UptoClient(...args),
    });
    [seller] = (await net.holders(usdc, 1, "0")) as [Keypair];
    proxy = await startRpcProxy(net.rpcUrl);
  }, 180_000);

  afterAll(async () => {
    // Unset when beforeAll failed before starting it.
    await (proxy as RpcProxy | undefined)?.close();
    await Promise.all(databases.map((db) => db.destroy()));
    const admin = createDatabase({ connectionString: DATABASE_URL, maxConnections: 1 });
    const rows = await sql<{ nspname: string }>`
      SELECT nspname FROM pg_namespace WHERE nspname LIKE 'idem\\_%'`.execute(admin);
    for (const { nspname } of rows.rows) await sql`DROP SCHEMA ${sql.id(nspname)} CASCADE`.execute(admin);
    await admin.destroy();
  });

  const ledgers: readonly [string, () => Promise<SettlementLedger>][] = [
    ["memory ledger", () => Promise.resolve(new MemorySettlementLedger())],
    [
      "postgres ledger",
      async () => {
        const schema = `idem_${randomBytes(6).toString("hex")}`;
        const admin = createDatabase({ connectionString: DATABASE_URL, maxConnections: 1 });
        await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
        await admin.destroy();
        const db = createDatabase({ connectionString: DATABASE_URL, schema, maxConnections: 10 });
        await migrate(db);
        databases.push(db);
        return new PostgresSettlementLedger(db);
      },
    ],
  ];

  describe.each(ledgers)("with the %s", (_name, makeLedger) => {
    let ledger: SettlementLedger;
    let channels: MemoryChannelPool;

    beforeAll(async () => {
      ledger = await makeLedger();
      channels = new MemoryChannelPool(
        deriveChannelKeypairs(sponsor, NETWORK, CHANNELS).map((keypair) => keypair.publicKey()),
      );
    });

    const setup = (
      options: { rpcUrl?: string; guard?: SponsorGuard; timing?: Partial<SettlementTiming> } = {},
    ): StellarFacilitator =>
      createStellarFacilitator({
        networks: [
          {
            network: NETWORK,
            rpcUrl: options.rpcUrl ?? net.rpcUrl,
            sponsorSecret: sponsor.secret(),
            channelCount: CHANNELS,
            assets: [acceptedAsset({ contract: usdc.sac, symbol: "USDC", decimals: 7 })],
            policy: { maxTransactionFeeStroops: 2_000_000 },
            ledger,
            channels,
            ...(options.guard === undefined ? {} : { guard: options.guard }),
            // Each test plays one process; a record it left is reconciled at once, as after a restart.
            timing: { pollIntervalMs: 250, channelWaitMs: 60_000, reconcileIdleMs: 0, ...options.timing },
            upto: { contract: contract.address, contractWasmHash: contract.wasmHash, ledgerSeconds: 5 },
          },
        ],
      });

    const pay = async (
      payer: Keypair,
      amount: bigint,
      options: { payTo?: string; expirationLedger?: number } = {},
    ) => {
      const terms = requirementsFor(usdc.sac, options.payTo ?? seller.publicKey(), amount);
      const payload = (await net.payment(payer, terms, {
        ...(options.expirationLedger === undefined ? {} : { expirationLedger: options.expirationLedger }),
      })) as PaymentPayload;
      return { payload, requirements: terms as PaymentRequirements };
    };

    const keyOf = (payload: PaymentPayload) => {
      const inspection = inspectExactTransaction(
        (payload.payload as { transaction: string }).transaction,
        net.passphrase,
      );
      if (!inspection.ok) throw new Error(inspection.code);
      const nonce = payerAuthorization(inspection.transfer)?.nonce ?? 0n;
      return { network: NETWORK, payer: inspection.transfer.from, nonce: nonce.toString() };
    };

    const START = 1_000_000_000n; // net.holders(…, "100") in base units

    it("answers a sequential repeat with the recorded response, marked as a repeat", async () => {
      const facilitator = setup();
      const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
      const { payload, requirements } = await pay(payer, 1_000_000n);

      const first = await facilitator.core.settle(payload, requirements);
      expect(first).toMatchObject({ success: true, payer: payer.publicKey() });
      expect(first.extensionResponses).toBeUndefined();
      const again = await facilitator.core.settle(payload, requirements);
      expect(again).toEqual(markRepeat(first, "rail402"));
      expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(START - 1_000_000n);
    });

    it("settles 5 concurrent repeats once: one transfer, one original, identical bodies", async () => {
      const facilitator = setup();
      const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
      const { payload, requirements } = await pay(payer, 2_000_000n);

      const results = await Promise.all(
        Array.from({ length: 5 }, () => facilitator.core.settle(payload, requirements)),
      );
      const originals = results.filter((result) => result.extensionResponses === undefined);
      expect(originals).toHaveLength(1);
      for (const result of results) {
        expect(bodyOf(result)).toEqual(originals[0]);
        if (result !== originals[0]) expect(result.extensionResponses).toEqual(REPEAT);
      }
      expect(originals[0]?.success).toBe(true);
      expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(START - 2_000_000n);
    });

    it("returns the original success after the authorization expired", async () => {
      const facilitator = setup();
      const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
      const expirationLedger = (await net.latestLedger()) + 8;
      const { payload, requirements } = await pay(payer, 1_000_000n, { expirationLedger });

      const first = await facilitator.core.settle(payload, requirements);
      expect(first.success).toBe(true);
      await expect
        .poll(() => net.latestLedger(), { timeout: 30_000, interval: 500 })
        .toBeGreaterThan(expirationLedger);
      // A fresh request with this authorization would now be refused as expired…
      expect(await facilitator.core.verify(payload, requirements)).toMatchObject({
        isValid: false,
        invalidReason: "invalid_exact_stellar_signature_expired",
      });
      // …but the repeat of a settled one gets its recorded result.
      expect(await facilitator.core.settle(payload, requirements)).toEqual(markRepeat(first, "rail402"));
      expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(START - 1_000_000n);
    });

    it("returns the stored success while the sponsor guard is closed", async () => {
      let open = true;
      const facilitator = setup({
        guard: {
          admit: () =>
            Promise.resolve(open ? { ok: true } : { ok: false, reason: "The sponsor is below its reserve." }),
        },
      });
      const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
      const { payload, requirements } = await pay(payer, 1_000_000n);
      const first = await facilitator.core.settle(payload, requirements);
      expect(first.success).toBe(true);

      open = false;
      expect(await facilitator.core.settle(payload, requirements)).toEqual(markRepeat(first, "rail402"));
      const fresh = await pay(payer, 1_000_000n);
      expect(await facilitator.core.settle(fresh.payload, fresh.requirements)).toMatchObject({
        success: false,
        errorReason: "settle_exact_stellar_sponsor_unavailable",
      });
    });

    it("returns a recorded failure to a repeat, without settling again", async () => {
      const facilitator = setup();
      const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
      const { payload, requirements } = await pay(payer, 1_000_000n);
      // The original was submitted and failed on-chain (for example a balance race at apply time).
      const failure = settleFailed({
        code: "insufficient_funds",
        network: NETWORK,
        payer: payer.publicKey(),
        transaction: randomBytes(32).toString("hex"),
      });
      const { record } = await ledger.claim(
        keyOf(payload),
        fingerprintOf(payload, requirements),
        "w",
        60_000,
      );
      await ledger.recordEnvelope(record.id, "w", {
        channel: "GFAILED",
        transactionHash: failure.transaction,
        innerTransactionHash: randomBytes(32).toString("hex"),
        envelopeXdr: "AAAA",
        validUntil: 1,
        maxFeeStroops: "100",
      });
      await ledger.finish(record.id, "failed", failure);

      expect(await facilitator.core.settle(payload, requirements)).toEqual(markRepeat(failure, "rail402"));
      expect(await facilitator.core.verify(payload, requirements)).toMatchObject({
        isValid: false,
        invalidReason: "insufficient_funds",
      });
      expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(START);
    });

    it("returns a recorded expiry to a repeat, and a new authorization from the payer settles", async () => {
      const facilitator = setup();
      const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
      const { payload, requirements } = await pay(payer, 1_000_000n);
      // Recorded, never included, and its time bound passed while the service was down.
      const { record } = await ledger.claim(
        keyOf(payload),
        fingerprintOf(payload, requirements),
        "w",
        60_000,
      );
      const hash = randomBytes(32).toString("hex");
      await ledger.recordEnvelope(record.id, "w", {
        channel: deriveChannelKeypairs(sponsor, NETWORK, CHANNELS)[CHANNELS - 1]?.publicKey() ?? "",
        transactionHash: hash,
        innerTransactionHash: hash,
        envelopeXdr: "AAAA",
        validUntil: 1,
        maxFeeStroops: "100",
      });
      await facilitator.reconcile();
      expect(await ledger.get(record.id)).toMatchObject({ state: "expired" });

      const repeat = await facilitator.core.settle(payload, requirements);
      expect(repeat).toMatchObject({
        success: false,
        errorReason: "settle_exact_stellar_transaction_expired",
        transaction: hash,
        extensionResponses: REPEAT,
      });
      expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(START);
      const fresh = await pay(payer, 1_000_000n);
      expect(await facilitator.core.settle(fresh.payload, fresh.requirements)).toMatchObject({
        success: true,
      });
    });

    it("answers a repeat while the original is pending, then with its success", async () => {
      const facilitator = setup({ rpcUrl: proxy.url, timing: { confirmTimeoutMs: 1_000 } });
      const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
      const { payload, requirements } = await pay(payer, 3_000_000n);

      proxy.hideTransactions = true;
      let pending: SettleResponse;
      let repeat: SettleResponse;
      try {
        pending = await facilitator.core.settle(payload, requirements);
        expect(pending).toMatchObject({ success: false, errorReason: "settlement_pending" });
        repeat = await setup({ timing: { duplicateWaitMs: 200 } }).core.settle(payload, requirements);
      } finally {
        proxy.hideTransactions = false;
      }
      expect(repeat).toEqual(markRepeat(pending, "rail402"));

      await expect.poll(async () => (await facilitator.reconcile()) > 0, { timeout: 30_000 }).toBe(true);
      expect(await facilitator.core.settle(payload, requirements)).toMatchObject({
        success: true,
        transaction: pending.transaction,
        extensionResponses: REPEAT,
      });
      expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(START - 3_000_000n);
    });

    it("refuses the same authorization in another envelope, naming the recorded transaction", async () => {
      const facilitator = setup();
      const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
      const { payload, requirements } = await pay(payer, 1_500_000n);
      const first = await facilitator.core.settle(payload, requirements);
      expect(first.success).toBe(true);

      const original = TransactionBuilder.fromXDR(
        (payload.payload as { transaction: string }).transaction,
        net.passphrase,
      ) as Transaction;
      const envelope = original.toEnvelope();
      envelope
        .v1()
        .tx()
        .fee(original.operations.length * 999);
      const repackaged = { ...payload, payload: { transaction: envelope.toXDR("base64") } };

      const conflict = await facilitator.core.settle(repackaged, requirements);
      expect(conflict).toMatchObject({
        success: false,
        errorReason: "settle_exact_stellar_idempotency_conflict",
        transaction: "",
      });
      expect(conflict.errorMessage).toContain(first.transaction);
      expect(conflict.extensionResponses).toBeUndefined();
    });

    it("never answers a request for different terms with the stored success", async () => {
      const facilitator = setup();
      const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
      const { payload, requirements } = await pay(payer, 1_000_000n);
      expect((await facilitator.core.settle(payload, requirements)).success).toBe(true);

      const elsewhere = { ...requirements, payTo: Keypair.random().publicKey() };
      for (const different of [elsewhere, { ...requirements, amount: "999999" }]) {
        expect(await facilitator.core.settle({ ...payload, accepted: different }, different)).toMatchObject({
          success: false,
          errorReason: "settle_exact_stellar_idempotency_conflict",
        });
      }
      expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(START - 1_000_000n);
    });

    it("reports a settlement in progress to verify, then the used authorization", async () => {
      const facilitator = setup({ rpcUrl: proxy.url, timing: { confirmTimeoutMs: 60_000 } });
      const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
      const { payload, requirements } = await pay(payer, 1_000_000n);
      const key = keyOf(payload);

      proxy.hideTransactions = true;
      let settling: Promise<SettleResponse> | undefined;
      try {
        settling = facilitator.core.settle(payload, requirements);
        await expect.poll(async () => (await ledger.find(key))?.state, { timeout: 30_000 }).toBe("submitted");
        expect(await facilitator.core.verify(payload, requirements)).toMatchObject({
          isValid: false,
          invalidReason: "settle_exact_stellar_settlement_in_progress",
          payer: payer.publicKey(),
        });
      } finally {
        proxy.hideTransactions = false;
      }
      const settled = await settling;
      expect(settled.success).toBe(true);
      const replay = await facilitator.core.verify(payload, requirements);
      expect(replay).toMatchObject({
        isValid: false,
        invalidReason: "invalid_exact_stellar_payload_nonce_already_used",
      });
      expect(replay.invalidMessage).toContain(settled.transaction);
    });

    it("keeps verify available when the ledger cannot be read", async () => {
      const facilitator = setup();
      const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
      const { payload, requirements } = await pay(payer, 1_000_000n);
      const find = ledger.find.bind(ledger);
      ledger.find = () => Promise.reject(new Error("ledger unavailable"));
      try {
        expect(await facilitator.core.verify(payload, requirements)).toMatchObject({
          isValid: true,
          payer: payer.publicKey(),
        });
      } finally {
        ledger.find = find;
      }
    });

    describe("upto", () => {
      const CAP = 1_000_000n;

      const payUpto = async (payer: Keypair, options: { expirationLedger?: number } = {}) => {
        const published = upto.requirements(seller.publicKey(), CAP);
        const payload = (await upto.pay(
          { kind: "G", address: payer.publicKey(), keypair: payer },
          published,
          options,
        )) as unknown as PaymentPayload;
        const at = (amount: bigint) => upto.settleRequirements(published, amount) as PaymentRequirements;
        return { payload, requirements: published as PaymentRequirements, at };
      };

      const uptoKeyOf = (payload: PaymentPayload, payer: Keypair) => ({
        network: NETWORK,
        payer: payer.publicKey(),
        nonce: decodeAuthorizationEntry((payload.payload as { authorization: string }).authorization)
          .credentials()
          .address()
          .nonce()
          .toString(),
      });

      it("answers a repeat for the same amount from the ledger and refuses another amount", async () => {
        const facilitator = setup({ rpcUrl: proxy.url });
        const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
        const { payload, at } = await payUpto(payer);

        const first = await facilitator.core.settle(payload, at(300_000n));
        expect(first).toMatchObject({ success: true, amount: "300000", payer: payer.publicKey() });
        const sent = proxy.sent.length;
        expect(await facilitator.core.settle(payload, at(300_000n))).toEqual(markRepeat(first, "rail402"));
        const conflict = await facilitator.core.settle(payload, at(500_000n));
        expect(conflict).toMatchObject({
          success: false,
          errorReason: "settle_upto_stellar_idempotency_conflict",
          transaction: first.transaction,
          amount: "500000",
        });
        expect(conflict.errorMessage).toContain(first.transaction);
        expect(proxy.sent.length).toBe(sent);
        expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(START - 300_000n);
      });

      it("settles 5 concurrent requests for different amounts once: one success, four conflicts", async () => {
        const facilitator = setup();
        const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
        const { payload, at } = await payUpto(payer);
        const amounts = [100_000n, 200_000n, 300_000n, 400_000n, 500_000n];

        const results = await Promise.all(
          amounts.map((amount) => facilitator.core.settle(payload, at(amount))),
        );
        const successes = results.filter((result) => result.success);
        expect(successes).toHaveLength(1);
        const [settled] = successes as [SettleResponse];
        const conflicts = results.filter((result) => !result.success);
        expect(conflicts.map((result) => result.errorReason)).toEqual(
          Array.from({ length: 4 }, () => "settle_upto_stellar_idempotency_conflict"),
        );
        // A conflict decided before the original was signed has no transaction to name yet.
        for (const conflict of conflicts) expect(["", settled.transaction]).toContain(conflict.transaction);

        const amount = BigInt(settled.amount ?? "0");
        expect(amounts).toContain(amount);
        const onChain = await onChainSettlement(net.server, net.passphrase, settled.transaction);
        expect(onChain.transfers).toEqual(
          upto.expectedTransfers(payer.publicKey(), seller.publicKey(), CAP, amount),
        );
        expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(START - amount);
        expect(await ledger.find(uptoKeyOf(payload, payer))).toMatchObject({
          scheme: "upto",
          state: "succeeded",
          amount: amount.toString(),
        });
      });

      it("returns the original success after the authorization expired", async () => {
        const facilitator = setup();
        const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
        const expirationLedger = (await net.latestLedger()) + 8;
        const { payload, requirements, at } = await payUpto(payer, { expirationLedger });

        const first = await facilitator.core.settle(payload, at(250_000n));
        expect(first.success).toBe(true);
        await expect
          .poll(() => net.latestLedger(), { timeout: 30_000, interval: 500 })
          .toBeGreaterThan(expirationLedger);
        expect(await facilitator.core.verify(payload, requirements)).toMatchObject({
          isValid: false,
          invalidReason: "invalid_upto_stellar_signature_expired",
        });
        expect(await facilitator.core.settle(payload, at(250_000n))).toEqual(markRepeat(first, "rail402"));
        expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(START - 250_000n);
      });

      it("reports a settlement in progress to verify, then the used authorization", async () => {
        const facilitator = setup({ rpcUrl: proxy.url, timing: { confirmTimeoutMs: 60_000 } });
        const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
        const { payload, requirements, at } = await payUpto(payer);
        const key = uptoKeyOf(payload, payer);

        proxy.hideTransactions = true;
        let settling: Promise<SettleResponse> | undefined;
        try {
          settling = facilitator.core.settle(payload, at(CAP));
          await expect
            .poll(async () => (await ledger.find(key))?.state, { timeout: 30_000 })
            .toBe("submitted");
          expect(await facilitator.core.verify(payload, requirements)).toMatchObject({
            isValid: false,
            invalidReason: "settle_upto_stellar_settlement_in_progress",
            payer: payer.publicKey(),
          });
        } finally {
          proxy.hideTransactions = false;
        }
        const settled = await settling;
        expect(settled).toMatchObject({ success: true, amount: CAP.toString() });
        const replay = await facilitator.core.verify(payload, requirements);
        expect(replay).toMatchObject({
          isValid: false,
          invalidReason: "invalid_upto_stellar_payload_nonce_already_used",
        });
        expect(replay.invalidMessage).toContain(settled.transaction);
      });
    });
  });

  describe("over HTTP with the stock facilitator client", () => {
    let service: RunningService;
    let client: HTTPFacilitatorClient;

    beforeAll(async () => {
      service = await startService(net, usdc, { BAZAAR_ENABLED: "false" });
      client = new HTTPFacilitatorClient({ url: service.url });
      const deadline = Date.now() + 60_000;
      while (!(await service.runtime.readiness()).ready) {
        if (Date.now() > deadline) throw new Error("the service did not become ready");
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    });

    afterAll(async () => {
      await service.stop();
    });

    it("marks the repeat in extension responses, and counts and meters it once", async () => {
      const [payer] = (await net.holders(usdc, 1, "10")) as [Keypair];
      const requirements = requirementsFor(usdc.sac, seller.publicKey(), 1_000_000n) as PaymentRequirements;
      const payload = (await net.payment(
        payer,
        requirementsFor(usdc.sac, seller.publicKey(), 1_000_000n),
      )) as PaymentPayload;

      const first = await client.settle(payload, requirements);
      expect(first).toMatchObject({ success: true });
      expect(first.extensionResponses).toBeUndefined();
      const again = await client.settle(payload, requirements);
      expect(again.extensionResponses).toEqual(REPEAT);
      expect(bodyOf(again)).toEqual(first);

      const exposition = await service.metrics.registry.metrics();
      expect(exposition).toContain(
        'rail402_settlements_total{network="stellar:testnet",scheme="exact",outcome="success",reason=""} 1',
      );
      expect(exposition).toContain(
        'rail402_settlement_repeats_total{network="stellar:testnet",scheme="exact"} 1',
      );
      expect(exposition).toMatch(
        /rail402_settlements_finalized_total\{network="stellar:testnet",scheme="exact",state="succeeded",reason="",settled_by="rail402"\} 1/,
      );
      expect(exposition).toMatch(
        /rail402_sponsor_fees_stroops_total\{network="stellar:testnet",outcome="charged"\} [1-9]/,
      );

      const usage = await service.runtime.access?.meter.usage("public", 1);
      const settles = (usage ?? []).filter((row) => row.operation === "settle");
      expect(settles.map((row) => [row.outcome, row.requests, row.settledAmount]).sort()).toEqual([
        ["repeat", 1, "0"],
        ["success", 1, "1000000"],
      ]);
    });
  });
});
