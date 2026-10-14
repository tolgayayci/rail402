import { describe, expect, it } from "vitest";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import { x402Client } from "@x402/core/client";
import type { PaymentRequirements } from "@x402/core/types";
import { TESTNET } from "@rail402.dev/stellar";
import { randomContractId } from "@rail402.dev/testkit";
import {
  KeyHolder,
  MemorySpendLedger,
  checkGuardedPayload,
  createGuardedSigner,
  effectiveCap,
  exactScheme,
  isPaymentError,
  selectOption,
  type GuardDeps,
  type LedgerClock,
  type PaymentEvent,
  type ResolvedPolicy,
  type Sep43AuthSigner,
  type SpendLedger,
  type StellarSchemeAdapter,
} from "@rail402.dev/sdk";
import {
  LATEST,
  clock,
  requirements,
  spec,
  tamperingAdapter,
  testPolicy,
  type Tampering,
} from "./helpers.ts";

interface Setup {
  readonly key?: Sep43AuthSigner;
  readonly policy?: ResolvedPolicy;
  readonly ledger?: SpendLedger;
  readonly option?: PaymentRequirements;
  readonly cap?: string;
  readonly clock?: LedgerClock;
  readonly tampering?: Tampering;
  readonly armed?: boolean;
  readonly idempotencyKey?: string;
}

/** Selects the option, arms a guard with it and runs the (possibly tampering) scheme client. */
async function pay(setup: Setup = {}) {
  const key = setup.key ?? KeyHolder.random();
  const policy = setup.policy ?? (await testPolicy());
  const ledger = setup.ledger ?? new MemorySpendLedger();
  const option = setup.option ?? requirements();
  const adapter: StellarSchemeAdapter = tamperingAdapter(setup.tampering);
  const cap = effectiveCap(policy, { amount: setup.cap ?? "0.05" });
  const { chosen } = selectOption([option], {
    network: TESTNET,
    policy,
    adapters: [adapter],
    payer: key.address,
    cap,
  });
  const events: PaymentEvent[] = [];
  const deps: GuardDeps = {
    network: TESTNET,
    policy,
    adapters: [exactScheme()],
    ledger,
    window: spec(policy, key.address),
    clock: setup.clock ?? clock(),
    expectation:
      setup.armed === false
        ? undefined
        : {
            scheme: "exact",
            network: TESTNET,
            asset: chosen.option.asset,
            payTo: chosen.option.payTo,
            amount: chosen.reserve,
            maxTimeoutSeconds: chosen.option.maxTimeoutSeconds,
            effectiveCap: cap.cap,
          },
    callId: "call-1",
    resource: "https://seller.example/weather",
    idempotencyKey: setup.idempotencyKey,
    onEvent: (event) => events.push(event),
  };
  const guard = createGuardedSigner(key, deps);
  const client = adapter.createClient(guard, { url: "https://rpc.invalid" });
  let error: unknown;
  let payload: Record<string, unknown> | undefined;
  try {
    payload = (await client.createPaymentPayload(2, chosen.option)).payload;
  } catch (caught) {
    error = caught;
  }
  const window = ledger.window(spec(policy, key.address));
  return {
    key,
    policy,
    ledger,
    guard,
    payload,
    error,
    events,
    usage: ledger.usage(window.id),
    option: chosen.option,
  };
}

function codeOf(error: unknown): string | undefined {
  return isPaymentError(error) ? error.code : undefined;
}

describe("guarded signer", () => {
  it("signs exactly the selected payment and holds its budget as pending", async () => {
    const { guard, payload, error, ledger, usage, option, events } = await pay();
    expect(error).toBeUndefined();
    expect(payload).toBeDefined();
    const authorization = checkGuardedPayload(guard, payload ?? {});
    expect(authorization.intent).toMatchObject({
      recipient: option.payTo,
      maxAmount: 10_000n,
      scheme: "exact",
    });
    expect(ledger.get(authorization.reservationId)?.state).toBe("signed");
    expect(ledger.get(authorization.reservationId)?.signedAtLedger).toBe(LATEST);
    expect(usage.assets.get(option.asset)).toEqual({ spent: 0n, pending: 10_000n });
    expect(events.map((event) => event.type)).toEqual(["reserved", "signed"]);
  });

  it.each<[string, Tampering, string]>([
    ["a different recipient", { to: Keypair.random().publicKey() }, "payment_authorization_rejected"],
    ["a higher amount", { amount: 10_001n }, "payment_authorization_rejected"],
    ["a lower amount", { amount: 9_999n }, "payment_authorization_rejected"],
    ["another network", { passphrase: Networks.PUBLIC }, "payment_network_not_permitted"],
    ["an asset outside the policy", { asset: randomContractId() }, "payment_authorization_rejected"],
    ["another function", { fn: "approve" }, "payment_authorization_rejected"],
    ["a sub-invocation", { subInvocation: true }, "payment_authorization_rejected"],
    [
      "an expiry beyond the option's window",
      { expiration: LATEST + 60 },
      "payment_authorization_window_not_permitted",
    ],
    [
      "an already expired authorization",
      { expiration: LATEST },
      "payment_authorization_window_not_permitted",
    ],
    [
      "a signature for another address",
      { requestAddress: Keypair.random().publicKey() },
      "payment_authorization_rejected",
    ],
  ])("refuses a scheme that signs %s, before reserving anything", async (_name, tampering, code) => {
    const { error, guard, usage, option, events } = await pay({ tampering });
    expect(codeOf(error)).toBe(code);
    expect(guard.failure?.code).toBe(code);
    expect(guard.authorizations).toHaveLength(0);
    expect(usage.assets.get(option.asset)).toBeUndefined();
    expect(events).toEqual([{ type: "refused", callId: "call-1", code }]);
  });

  it("refuses a second signature within one call and keeps the first one's budget pending", async () => {
    const { error, guard, usage, option } = await pay({ tampering: { signTwice: true } });
    expect(codeOf(error)).toBe("payment_authorization_rejected");
    expect(guard.failure?.reason).toMatch(/second signature/);
    expect(guard.authorizations).toHaveLength(1);
    expect(usage.assets.get(option.asset)).toEqual({ spent: 0n, pending: 10_000n });
  });

  it("accepts a CAP-71 V2 authorization for the signer", async () => {
    const { error, guard } = await pay({ tampering: { credential: "address_v2" } });
    expect(error).toBeUndefined();
    expect(guard.authorizations[0]?.intent.credential).toBe("address_v2");
  });

  it("refuses a payload whose transaction differs from the signed authorization; the budget stays pending", async () => {
    const tampered = await pay({ tampering: { transactionTo: Keypair.random().publicKey() } });
    expect(tampered.error).toBeUndefined();
    expect(() => checkGuardedPayload(tampered.guard, tampered.payload ?? {})).toThrow(/different recipient/);
    expect(tampered.usage.assets.get(tampered.option.asset)?.pending).toBe(10_000n);

    const unsigned = await pay({ tampering: { dropSignature: true } });
    expect(() => checkGuardedPayload(unsigned.guard, unsigned.payload ?? {})).toThrow(/signed authorization/);
  });

  it("fails closed when the latest ledger cannot be read", async () => {
    const failing: LedgerClock = { read: () => Promise.reject(new Error("rpc down")) };
    const { error, usage, option } = await pay({ clock: failing });
    expect(codeOf(error)).toBe("rpc_unavailable");
    expect(usage.assets.get(option.asset)).toBeUndefined();
  });

  it.each<[string, Sep43AuthSigner["signAuthEntry"]]>([
    ["throws", () => Promise.reject(new Error("device unplugged"))],
    [
      "returns a SEP-43 error",
      () => Promise.resolve({ signedAuthEntry: "", error: { code: -4, message: "rejected" } }),
    ],
    [
      "returns a signature over other bytes",
      () => Promise.resolve({ signedAuthEntry: Buffer.alloc(64, 1).toString("base64") }),
    ],
  ])("releases the reservation when the wallet %s, and never retries", async (_name, signAuthEntry) => {
    const holder = KeyHolder.random();
    let calls = 0;
    const wallet: Sep43AuthSigner = {
      address: holder.address,
      signAuthEntry: (entry, opts) => {
        calls++;
        return signAuthEntry(entry, opts);
      },
    };
    const { error, ledger, usage, option, events } = await pay({ key: wallet });
    expect(codeOf(error)).toBe("payment_signing_failed");
    expect(calls).toBe(1);
    expect(usage.assets.get(option.asset)).toBeUndefined();
    const released = events.find((event) => event.type === "released");
    expect(released).toMatchObject({ reason: "not_signed", amount: "10000" });
    expect(ledger.get(released?.type === "released" ? released.reservation : "")?.state).toBe("released");
  });

  it("refuses when the session budget cannot hold the payment", async () => {
    const policy = await testPolicy({
      assets: [{ asset: "USDC", perCall: "0.0015", sessionTotal: "0.0015" }],
    });
    const ledger = new MemorySpendLedger();
    const key = KeyHolder.random();
    const first = await pay({ key, policy, ledger });
    expect(first.error).toBeUndefined();
    const second = await pay({ key, policy, ledger });
    expect(codeOf(second.error)).toBe("payment_session_cap_exceeded");
    expect(second.guard.failure?.code).toBe("payment_session_cap_exceeded");
  });

  it("reserves once per idempotency key within a window", async () => {
    const ledger = new MemorySpendLedger();
    const key = KeyHolder.random();
    const policy = await testPolicy();
    const first = await pay({ key, policy, ledger, idempotencyKey: "order-12345" });
    expect(first.error).toBeUndefined();
    const again = await pay({ key, policy, ledger, idempotencyKey: "order-12345" });
    expect(codeOf(again.error)).toBe("payment_in_progress");
    expect(again.usage.assets.get(again.option.asset)?.pending).toBe(10_000n);
  });

  it("never lets 20 concurrent payments exceed the session budget", async () => {
    const policy = await testPolicy({ assets: [{ asset: "USDC", perCall: "0.10", sessionTotal: "1.00" }] });
    const ledger = new MemorySpendLedger();
    const key = KeyHolder.random();
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        pay({ key, policy, ledger, cap: "0.10", option: requirements({ amount: "1000000" }) }),
      ),
    );
    const paid = results.filter((result) => result.error === undefined);
    const refused = results.filter((result) => codeOf(result.error) === "payment_session_cap_exceeded");
    expect(paid).toHaveLength(10);
    expect(refused).toHaveLength(10);
    const window = ledger.window(spec(policy, key.address));
    expect(ledger.usage(window.id).assets.get(results[0]?.option.asset ?? "")?.pending).toBe(10_000_000n);
  });

  it("in policy-only mode signs every authorization the policy allows, each with its own reservation", async () => {
    const key = KeyHolder.random();
    const ledger = new MemorySpendLedger();
    const policy = await testPolicy();
    const guard = createGuardedSigner(key, {
      network: TESTNET,
      policy,
      adapters: [exactScheme()],
      ledger,
      window: spec(policy, key.address),
      clock: clock(),
    });
    const client = tamperingAdapter().createClient(guard, { url: "https://rpc.invalid" });
    await client.createPaymentPayload(2, requirements());
    await client.createPaymentPayload(2, requirements());
    expect(guard.authorizations).toHaveLength(2);
    expect(new Set(guard.authorizations.map((entry) => entry.callId)).size).toBe(2);
    // The operator ceiling (0.10 USDC) is the per-call cap without an armed expectation.
    await expect(client.createPaymentPayload(2, requirements({ amount: "1000001" }))).rejects.toMatchObject({
      code: "payment_per_call_cap_exceeded",
    });
  });

  it("keeps its refusal available when the upstream x402 client is used end to end", async () => {
    const key = KeyHolder.random();
    const policy = await testPolicy();
    const ledger = new MemorySpendLedger();
    const option = requirements();
    const guard = createGuardedSigner(key, {
      network: TESTNET,
      policy,
      adapters: [exactScheme()],
      ledger,
      window: spec(policy, key.address),
      clock: clock(),
      expectation: {
        scheme: "exact",
        network: TESTNET,
        asset: option.asset,
        payTo: option.payTo,
        amount: 10_000n,
        maxTimeoutSeconds: 60,
        effectiveCap: 500_000n,
      },
      callId: "call-2",
    });
    const client = new x402Client()
      .register(
        TESTNET,
        tamperingAdapter({ to: Keypair.random().publicKey() }).createClient(guard, {
          url: "https://rpc.invalid",
        }),
      )
      .setSpendControls(false);
    await expect(
      client.createPaymentPayload({
        x402Version: 2,
        resource: { url: "https://seller.example/weather" },
        accepts: [option],
      }),
    ).rejects.toThrow();
    expect(guard.failure?.code).toBe("payment_authorization_rejected");
    expect(guard.failure?.callId).toBe("call-2");
  });
});
