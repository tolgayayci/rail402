/**
 * How the service settles `upto` payments on the private Stellar network (1 s ledgers, the service's
 * ledger-time estimate pinned to 5 s), with the committed settlement contract deployed per run and the
 * service's RPC behind a proxy that can pin the latest ledger:
 *
 * - duplicates: 20 concurrent identical settlements land one transaction; 20 concurrent settlements of
 *   different amounts land one and refuse the rest as conflicts; the first request fixes the amount, so a
 *   payload holder's zero turns the seller's settle into a conflict; a replica without the record
 *   refuses a used authorization as `nonce_already_used`;
 * - funds: /verify simulates the cap, so the payer must hold it; /settle simulates the amount; missing
 *   trustlines and a missing payer account are named;
 * - time: the expiration ledger comes from `maxTimeoutSeconds`; an authorization is accepted up to its
 *   last ledger minus the margin and refused after it; one signed with a start ledger is refused until
 *   the network reaches it — off-chain first, then by the contract;
 * - the fee ceiling refuses a settlement whose simulated fee exceeds it.
 *
 * Needs `docker compose --profile stellar up -d` and Postgres.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import type { PaymentRequirements } from "@x402/core/types";
import {
  LocalNetwork,
  deployUpto,
  pinHorizon,
  startRpcProxy,
  type HorizonPin,
  type IssuedAsset,
  type LocalUptoContract,
  type RpcProxy,
} from "@rail402.dev/testkit";
import {
  LEDGER_SECONDS,
  accountPayer,
  codeOf,
  post,
  signedPayment,
  startUptoService,
  termsOf,
  uptoPayment,
  uptoRequirements,
  withAmount,
  type Payer,
  type UptoService,
} from "./upto-harness.ts";
import { createServiceSchema, dropServiceSchema } from "./service-harness.ts";

const net = new LocalNetwork();
const available = await net.available();

describe.skipIf(!available)("upto settlement through the Rail402 service", () => {
  let horizon: HorizonPin;
  let usdc: IssuedAsset;
  let contract: LocalUptoContract;
  let proxy: RpcProxy;
  let service: UptoService;
  let recipient: Keypair;

  beforeAll(async () => {
    horizon = pinHorizon({ seconds: LEDGER_SECONDS });
    [usdc, contract] = await Promise.all([net.issueAsset("USDC"), deployUpto(net)]);
    recipient = await net.holder(usdc, "0");
    proxy = await startRpcProxy(net.rpcUrl);
    service = await startUptoService(net, usdc, contract, { TESTNET_RPC_URL: proxy.url });
  }, 240_000);

  afterAll(async () => {
    // Unset when beforeAll failed before starting them.
    await (service as UptoService | undefined)?.stop();
    await (proxy as RpcProxy | undefined)?.close();
    horizon.restore();
  });

  function requirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
    return {
      ...uptoRequirements({
        asset: usdc.sac,
        payTo: recipient.publicKey(),
        authority: service.authority.publicKey(),
      }),
      ...overrides,
    };
  }

  const pay = (payer: Payer, accepted = requirements()) =>
    uptoPayment(net, { contract: contract.address, payer, accepted });

  /** Distinct transactions the service broadcast since `from` (an index into `proxy.sent`). */
  const broadcastSince = (from: number) => new Set(proxy.sent.slice(from)).size;

  describe("duplicates", () => {
    it("lands one transaction for 20 concurrent identical settlements", async () => {
      const keys = await net.holder(usdc, "1");
      const payload = await pay(accountPayer(keys));
      const sent = proxy.sent.length;
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          post(service.url, "/settle", payload, withAmount(requirements(), 7_000n)),
        ),
      );
      expect(results.every((result) => result.body["success"] === true)).toBe(true);
      expect(new Set(results.map((result) => result.body["transaction"])).size).toBe(1);
      expect(broadcastSince(sent)).toBe(1);
      expect(await net.tokenBalance(usdc.sac, keys.publicKey())).toBe(10_000_000n - 7_000n);
    });

    it("lands one transaction for 20 concurrent settlements of different amounts and refuses the rest", async () => {
      const keys = await net.holder(usdc, "1");
      const payload = await pay(accountPayer(keys));
      const sent = proxy.sent.length;
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          post(service.url, "/settle", payload, withAmount(requirements(), BigInt(1_000 + index))),
        ),
      );
      const settled = results.filter((result) => result.body["success"] === true);
      expect(settled).toHaveLength(1);
      const winner = settled[0]?.body;
      const refused = results.filter((result) => result.body["success"] !== true);
      expect(refused.map(codeOf)).toEqual(
        Array.from({ length: 19 }, () => "settle_upto_stellar_idempotency_conflict"),
      );
      expect(broadcastSince(sent)).toBe(1);
      expect(await net.tokenBalance(usdc.sac, keys.publicKey())).toBe(
        10_000_000n - BigInt(String(winner?.["amount"])),
      );

      // Once the settlement is final every conflict names it and the amount it settled.
      const late = await post(service.url, "/settle", payload, withAmount(requirements(), 2_000n));
      expect(late.body).toMatchObject({
        success: false,
        errorReason: "settle_upto_stellar_idempotency_conflict",
        transaction: winner?.["transaction"],
        amount: "2000",
      });
      expect(late.body["errorMessage"]).toContain(String(winner?.["amount"]));
    });

    it("lets the first settle request fix the amount: a payload holder's zero turns the seller's settle into a conflict", async () => {
      // The authority settles whatever the first accepted /settle names, within the cap: anyone holding
      // the payload (here the buyer itself) can settle it before the seller does.
      const keys = await net.holder(usdc, "1");
      const payload = await pay(accountPayer(keys));
      const first = await post(service.url, "/settle", payload, withAmount(requirements(), 0n));
      expect(first.body).toMatchObject({ success: true, amount: "0" });
      const seller = await post(service.url, "/settle", payload, withAmount(requirements(), 5_000n));
      expect(seller.body).toMatchObject({
        success: false,
        errorReason: "settle_upto_stellar_idempotency_conflict",
        transaction: first.body["transaction"],
        amount: "5000",
      });
      expect(seller.body["errorMessage"]).toContain("for 0");
      // Nothing moved: the seller was not paid, and the buyer was charged nothing.
      expect(await net.tokenBalance(usdc.sac, keys.publicKey())).toBe(10_000_000n);
    });

    it("refuses a used authorization at a replica without its record: the network holds the nonce", async () => {
      const keys = await net.holder(usdc, "1");
      const payload = await pay(accountPayer(keys));
      expect(
        (await post(service.url, "/settle", payload, withAmount(requirements(), 5n))).body,
      ).toMatchObject({
        success: true,
      });
      const schema = await createServiceSchema();
      const replica = await startUptoService(
        net,
        usdc,
        contract,
        { TESTNET_RPC_URL: proxy.url },
        { replicaOf: { sponsor: service.sponsor, schema } },
      );
      try {
        const sent = proxy.sent.length;
        const verified = await post(replica.url, "/verify", payload, requirements());
        expect(codeOf(verified)).toBe("invalid_upto_stellar_payload_nonce_already_used");
        const settled = await post(replica.url, "/settle", payload, withAmount(requirements(), 5n));
        expect(codeOf(settled)).toBe("invalid_upto_stellar_payload_nonce_already_used");
        expect(proxy.sent.length).toBe(sent);
        expect(await net.tokenBalance(usdc.sac, keys.publicKey())).toBe(10_000_000n - 5n);
      } finally {
        await replica.stop();
        await dropServiceSchema(schema);
      }
    });
  });

  describe("funds", () => {
    it("verifies against the cap and settles against the amount", async () => {
      // 0.05 USDC = 500,000 base units: less than the cap, more than the amount settled.
      const keys = await net.holder(usdc, "0.05");
      const payload = await pay(accountPayer(keys));
      const verified = await post(service.url, "/verify", payload, requirements());
      expect(codeOf(verified)).toBe("insufficient_funds");
      const settled = await post(service.url, "/settle", payload, withAmount(requirements(), 400_000n));
      expect(settled.body).toMatchObject({ success: true, amount: "400000" });
      expect(await net.tokenBalance(usdc.sac, keys.publicKey())).toBe(100_000n);
    });

    it("refuses a settlement the payer cannot cover", async () => {
      const keys = await net.holder(usdc, "0.01");
      const payload = await pay(accountPayer(keys));
      const settled = await post(service.url, "/settle", payload, withAmount(requirements(), 200_000n));
      expect(codeOf(settled)).toBe("insufficient_funds");
      expect(settled.body["transaction"]).toBe("");
    });

    it("names a missing trustline on either side and a payer account that does not exist", async () => {
      const untrusting = Keypair.random();
      await net.fund(untrusting);
      const payerTrustline = await post(
        service.url,
        "/verify",
        await pay(accountPayer(untrusting)),
        requirements(),
      );
      expect(codeOf(payerTrustline)).toBe("invalid_upto_stellar_payload_payer_trustline_missing");

      const toStranger = requirements({ payTo: untrusting.publicKey() });
      const keys = await net.holder(usdc, "1");
      const recipientTrustline = await post(
        service.url,
        "/verify",
        await pay(accountPayer(keys), toStranger),
        toStranger,
      );
      expect(codeOf(recipientTrustline)).toBe("invalid_upto_stellar_payload_recipient_trustline_missing");

      const missing = await post(
        service.url,
        "/verify",
        await pay(accountPayer(Keypair.random())),
        requirements(),
      );
      expect(codeOf(missing)).toBe("invalid_upto_stellar_payload_account_missing");
    });
  });

  describe("time", () => {
    /**
     * Pins the latest ledger the service sees, and waits until its ledger reading has aged past the
     * one second a settlement may reuse it, so the next settlement reads the pinned ledger.
     */
    async function pin(ledger: number | undefined) {
      proxy.pinLedger(ledger);
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    }

    it("derives the expiration from maxTimeoutSeconds, accepts it until the margin and refuses it after", async () => {
      const keys = await net.holder(usdc, "1");
      const accepted = requirements({ maxTimeoutSeconds: 60 });
      const signedAt = await net.latestLedger();
      const payload = await pay(accountPayer(keys), accepted);
      const expiration = termsOf(payload).expirationLedger;
      // ceil(60 s / 5 s) ledgers after the ledger the client read.
      expect(expiration - signedAt).toBeGreaterThanOrEqual(12);
      expect(expiration - signedAt).toBeLessThanOrEqual(13);

      const sent = proxy.sent.length;
      try {
        // The margin is one ledger: the last ledger it is accepted at is the one before its expiration.
        await pin(expiration - 1);
        expect((await post(service.url, "/verify", payload, accepted)).body).toMatchObject({ isValid: true });
        await pin(expiration);
        expect(codeOf(await post(service.url, "/settle", payload, withAmount(accepted, 10n)))).toBe(
          "invalid_upto_stellar_signature_expiration_too_soon",
        );
        await pin(expiration + 1);
        expect(codeOf(await post(service.url, "/settle", payload, withAmount(accepted, 10n)))).toBe(
          "invalid_upto_stellar_signature_expired",
        );
      } finally {
        await pin(undefined);
      }
      expect(proxy.sent.length).toBe(sent);

      // Before its expiration on the network it settles.
      expect(await net.latestLedger()).toBeLessThan(expiration - 1);
      const settled = await post(service.url, "/settle", payload, withAmount(accepted, 10n));
      expect(settled.body).toMatchObject({ success: true });

      // After it, the same window is refused without a transaction.
      const short = requirements({ maxTimeoutSeconds: 30 });
      const late = await pay(accountPayer(keys), short);
      const lateExpiration = termsOf(late).expirationLedger;
      await expect
        .poll(() => net.latestLedger(), { timeout: 30_000, interval: 250 })
        .toBeGreaterThan(lateExpiration);
      const before = proxy.sent.length;
      const refused = await post(service.url, "/settle", late, withAmount(short, 10n));
      expect(codeOf(refused)).toBe("invalid_upto_stellar_signature_expired");
      expect(proxy.sent.length).toBe(before);
      expect(await net.tokenBalance(usdc.sac, keys.publicKey())).toBe(10_000_000n - 10n);
    });

    it("holds the upper edge at the window from maxTimeoutSeconds plus 2 ledgers", async () => {
      const payer = accountPayer(await net.holder(usdc, "1"));
      const accepted = requirements({ maxTimeoutSeconds: 30 });
      const current = await net.latestLedger();
      const expiring = (expirationLedger: number) =>
        signedPayment(net, { contract: contract.address, payer, accepted, terms: { expirationLedger } });
      // ceil(30 s / 5 s) = 6 ledgers, tolerated up to 2 more.
      const [edge, beyond] = await Promise.all([expiring(current + 8), expiring(current + 9)]);
      try {
        await pin(current);
        expect((await post(service.url, "/verify", edge, accepted)).body).toMatchObject({ isValid: true });
        expect(codeOf(await post(service.url, "/verify", beyond, accepted))).toBe(
          "invalid_upto_stellar_signature_expiration_too_far",
        );
      } finally {
        await pin(undefined);
      }
    });

    it("refuses an authorization before its start ledger, off-chain and in the contract, then settles it", async () => {
      const keys = await net.holder(usdc, "1");
      const accepted = requirements({ maxTimeoutSeconds: 60 });
      const current = await net.latestLedger();
      const validAfter = current + 8;
      const payload = await signedPayment(net, {
        contract: contract.address,
        payer: accountPayer(keys),
        accepted,
        terms: { validAfterLedger: validAfter, expirationLedger: current + 12 },
      });
      try {
        await pin(current);
        const offchain = await post(service.url, "/verify", payload, accepted);
        expect(codeOf(offchain)).toBe("invalid_upto_stellar_payload_not_yet_valid");
        expect(offchain.body["invalidMessage"]).toMatch(/valid from ledger/);
        // One ledger before the start the static rule lets it through; the contract still refuses it
        // while the network has not reached the start ledger.
        await pin(validAfter - 1);
        const onchain = await post(service.url, "/verify", payload, accepted);
        expect(codeOf(onchain)).toBe("invalid_upto_stellar_payload_not_yet_valid");
        expect(onchain.body["invalidMessage"]).toMatch(/contract error #4/);
      } finally {
        await pin(undefined);
      }
      await expect
        .poll(() => net.latestLedger(), { timeout: 30_000, interval: 250 })
        .toBeGreaterThanOrEqual(validAfter);
      const settled = await post(service.url, "/settle", payload, withAmount(accepted, 42n));
      expect(settled.body).toMatchObject({ success: true, amount: "42" });
    });
  });

  it("refuses a settlement whose simulated fee exceeds the ceiling", async () => {
    const capped = await startUptoService(net, usdc, contract, { TESTNET_UPTO_MAX_TX_FEE_STROOPS: "20000" });
    try {
      const payload = await uptoPayment(net, {
        contract: contract.address,
        payer: accountPayer(await net.holder(usdc, "1")),
        accepted: uptoRequirements({
          asset: usdc.sac,
          payTo: recipient.publicKey(),
          authority: capped.authority.publicKey(),
        }),
      });
      const accepted = payload.accepted;
      const verified = await post(capped.url, "/verify", payload, accepted);
      expect(codeOf(verified)).toBe("invalid_upto_stellar_payload_fee_exceeds_maximum");
      expect(verified.body["invalidMessage"]).toMatch(/the ceiling on stellar:testnet is 20000/);
      const sponsor = await net.nativeBalance(capped.sponsor.publicKey());
      const settled = await post(capped.url, "/settle", payload, withAmount(accepted, 10n));
      expect(codeOf(settled)).toBe("invalid_upto_stellar_payload_fee_exceeds_maximum");
      expect(await net.nativeBalance(capped.sponsor.publicKey())).toBe(sponsor);
    } finally {
      await capped.stop();
    }
  });
});
