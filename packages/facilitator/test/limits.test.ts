import { describe, expect, it } from "vitest";
import { SettleLimits, type AdmissionContext, type SponsorGuard } from "@rail402.dev/facilitator";

const NETWORK = "stellar:pubnet";
const context = (payer: string, payTo = "GPAYTO"): AdmissionContext => ({
  network: NETWORK,
  scheme: "exact",
  payer,
  payTo,
});

/** A per-minute counter like the service's limiter, without a clock. */
function counter() {
  const counts = new Map<string, number>();
  return (key: string, perMinute: number) => {
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    return next > perMinute ? 30 : 0;
  };
}

describe("SettleLimits", () => {
  it("refuses a payer past its settlement limit once its payments are proven", async () => {
    const refusals: string[] = [];
    const limits = new SettleLimits({
      network: NETWORK,
      take: counter(),
      payerPerMinute: 2,
      failClosed: true,
      onRefusal: (limit) => refusals.push(limit),
    });
    expect(await limits.admitVerified(context("GA"))).toEqual({ ok: true });
    expect(await limits.admitVerified(context("GA"))).toEqual({ ok: true });
    expect(await limits.admitVerified(context("GA"))).toMatchObject({
      ok: false,
      limit: "payer_rate",
      reason: expect.stringMatching(/payer/) as string,
    });
    expect(await limits.admitVerified(context("GB"))).toEqual({ ok: true });
    expect(refusals).toEqual(["payer_rate"]);
  });

  it("refuses a payTo past its limit, whoever pays it", async () => {
    const limits = new SettleLimits({
      network: NETWORK,
      take: counter(),
      payToPerMinute: 2,
      failClosed: true,
    });
    expect((await limits.admitVerified(context("GA", "GSELF"))).ok).toBe(true);
    expect((await limits.admitVerified(context("GB", "GSELF"))).ok).toBe(true);
    expect(await limits.admitVerified(context("GC", "GSELF"))).toMatchObject({
      ok: false,
      limit: "payto_rate",
    });
  });

  it("puts a payer whose settlements fail on chain into a cooldown", async () => {
    const failures = new Map([["GBAD", 3]]);
    const limits = new SettleLimits({
      network: NETWORK,
      take: counter(),
      failuresPerHour: 3,
      ledger: { failuresSince: (_network, payer) => Promise.resolve(failures.get(payer) ?? 0) },
      failClosed: true,
    });
    expect(await limits.admit(context("GBAD"))).toMatchObject({
      ok: false,
      limit: "payer_cooldown",
      reason: expect.stringMatching(/failed on-chain 3 times/) as string,
    });
    expect((await limits.admit(context("GOOD"))).ok).toBe(true);
  });

  it("fails closed on pubnet and open elsewhere when the counter cannot answer", async () => {
    const broken = () => Promise.reject(new Error("database down"));
    const closed = new SettleLimits({ network: NETWORK, take: broken, payerPerMinute: 5, failClosed: true });
    const refused = await closed.admitVerified(context("GA"));
    expect(refused).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/cannot be checked/) as string,
    });
    expect("limit" in refused && refused.limit !== undefined).toBe(false);
    const open = new SettleLimits({
      network: "stellar:testnet",
      take: broken,
      payerPerMinute: 5,
      failClosed: false,
    });
    expect(await open.admitVerified(context("GA"))).toEqual({ ok: true });
  });

  it("takes no payer or payTo quota at admission, before the payment proved its signature", async () => {
    const taken: string[] = [];
    const limits = new SettleLimits({
      network: NETWORK,
      take: (key) => {
        taken.push(key);
        return 0;
      },
      payerPerMinute: 1,
      payToPerMinute: 1,
      failClosed: true,
    });
    for (let i = 0; i < 5; i++)
      expect(await limits.admit(context("GFORGED", "GVICTIM"))).toEqual({ ok: true });
    expect(taken).toEqual([]);
    expect(await limits.admitVerified(context("GREAL", "GVICTIM"))).toEqual({ ok: true });
    expect(taken).toEqual([`n:${NETWORK}|payer:GREAL`, `n:${NETWORK}|public|payto:GVICTIM`]);
  });

  it("keeps a keyed seller's payTo quota apart from keyless traffic to the same payTo", async () => {
    const limits = new SettleLimits({
      network: NETWORK,
      take: counter(),
      payToPerMinute: 2,
      failClosed: true,
    });
    const keyless = (payer: string) => context(payer, "GSELLER");
    const keyed = (payer: string): AdmissionContext => ({
      ...context(payer, "GSELLER"),
      caller: { subject: "key:seller" },
    });
    // Keyless dust uses up the keyless bucket of this payTo...
    expect(await limits.admitVerified(keyless("GDUST1"))).toEqual({ ok: true });
    expect(await limits.admitVerified(keyless("GDUST2"))).toEqual({ ok: true });
    expect(await limits.admitVerified(keyless("GDUST3"))).toMatchObject({ ok: false, limit: "payto_rate" });
    // ...while the seller's own keyed settlements keep their quota.
    expect(await limits.admitVerified(keyed("GBUYER1"))).toEqual({ ok: true });
    expect(await limits.admitVerified(keyed("GBUYER2"))).toEqual({ ok: true });
    expect(await limits.admitVerified(keyed("GBUYER3"))).toMatchObject({ ok: false, limit: "payto_rate" });
    // Another key has a bucket of its own too.
    expect(
      await limits.admitVerified({ ...context("GBUYER4", "GSELLER"), caller: { subject: "key:other" } }),
    ).toEqual({ ok: true });
  });

  it("asks the wrapped guard first and passes its budgets through", async () => {
    const inner: SponsorGuard = {
      admit: () => Promise.resolve({ ok: false, reason: "below reserve" }),
      limits: () => [{ scope: "network", capStroops: 5n, since: new Date(0) }],
    };
    const limits = new SettleLimits({
      network: NETWORK,
      inner,
      take: counter(),
      payerPerMinute: 1,
      failClosed: true,
    });
    expect(await limits.admit(context("GA"))).toEqual({ ok: false, reason: "below reserve" });
    expect(limits.limits(context("GA"))).toHaveLength(1);
  });
});
