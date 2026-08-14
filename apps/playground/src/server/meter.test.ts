import { describe, it, expect, beforeEach } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import type { PaymentPayload } from "@x402/core/types";
import { loadConfig, type PlaygroundConfig } from "./config.js";
import { createMeter, MeterRefusal, TAB_SECONDS } from "./meter.js";

const SECRET = Keypair.random().secret();

function config(): PlaygroundConfig {
  return loadConfig({ PLAYGROUND_DISPENSER_SECRET: SECRET } as NodeJS.ProcessEnv);
}

function payload(c: PlaygroundConfig, maxAmount: string): PaymentPayload {
  return {
    x402Version: 2,
    accepted: {
      scheme: "upto",
      network: "stellar:testnet",
      asset: c.usdc.sac,
      amount: maxAmount,
      payTo: c.payTo,
      maxTimeoutSeconds: TAB_SECONDS,
      extra: {},
    },
    payload: { transaction: "AAAA…", maxAmount, expirationLedger: 123456, nonce: "ab".repeat(32) },
  };
}

/** Records every facilitator call so tests can assert WHAT was verified/settled, not just that something was. */
function fakeFacilitator() {
  const calls: Array<{ path: string; amount: string }> = [];
  let verifyBody: unknown = { isValid: true, payer: "GPAYER" };
  let settleBody: unknown = { success: true, transaction: "txhash", payer: "GPAYER" };
  const fetchImpl = (async (url: unknown, init?: { body?: unknown }) => {
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(String(init?.body)) as { paymentRequirements: { amount: string } };
    calls.push({ path, amount: body.paymentRequirements.amount });
    const responseBody = path === "/verify" ? verifyBody : settleBody;
    return new Response(JSON.stringify(responseBody), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return {
    calls,
    fetchImpl,
    refuseVerify(code: string, message: string) {
      verifyBody = { isValid: false, invalidReason: code, invalidMessage: message };
    },
    refuseSettle(code: string, message: string) {
      settleBody = { success: false, errorReason: code, errorMessage: message };
    },
  };
}

const expectRefusal = async (p: Promise<unknown> | (() => unknown), code: string, status?: number) => {
  try {
    await (typeof p === "function" ? Promise.resolve().then(p) : p);
    throw new Error("expected a MeterRefusal");
  } catch (err) {
    expect(err).toBeInstanceOf(MeterRefusal);
    const refusal = err as MeterRefusal;
    expect(refusal.payload.code).toBe(code);
    expect(refusal.payload.reason.trim().length).toBeGreaterThan(20);
    if (status) expect(refusal.status).toBe(status);
  }
};

describe("meter", () => {
  let c: PlaygroundConfig;
  let facilitator: ReturnType<typeof fakeFacilitator>;
  let clock: number;
  let meter: ReturnType<typeof createMeter>;

  beforeEach(() => {
    c = config();
    facilitator = fakeFacilitator();
    clock = 1_000_000;
    meter = createMeter({ config: c, fetchImpl: facilitator.fetchImpl, now: () => clock });
  });

  it("serves a 402 challenge whose accepts advertises upto with the contract and sponsorship", () => {
    const challenge = meter.paymentRequired("https://play.example/demo/meter/open");
    expect(challenge.x402Version).toBe(2);
    const accepts = challenge.accepts[0]!;
    expect(accepts.scheme).toBe("upto");
    expect(accepts.maxTimeoutSeconds).toBe(TAB_SECONDS);
    expect(accepts.extra["uptoContract"]).toMatch(/^C/);
    expect(accepts.extra["areFeesSponsored"]).toBe(true);
  });

  it("verifies the ceiling the BUYER signed, not the advertised one", async () => {
    await meter.open(payload(c, "1234567"));
    expect(facilitator.calls).toEqual([{ path: "/verify", amount: "1234567" }]);
  });

  it("refuses a non-upto payload without calling the facilitator", async () => {
    const wrong = payload(c, "1000000");
    (wrong.accepted as { scheme: string }).scheme = "exact";
    await expectRefusal(meter.open(wrong), "playground_invalid_request", 400);
    expect(facilitator.calls).toHaveLength(0);
  });

  it("refuses a ceiling below one metered call", async () => {
    await expectRefusal(meter.open(payload(c, "1")), "playground_invalid_request", 400);
  });

  it("passes the facilitator's own coded verify refusal through verbatim", async () => {
    facilitator.refuseVerify("invalid_upto_stellar_payload_expired", "authorization expired");
    await expectRefusal(
      meter.open(payload(c, "1000000")),
      "invalid_upto_stellar_payload_expired",
      402,
    );
  });

  it("meters calls up to the ceiling and refuses the call that would cross it", async () => {
    const ceiling = c.meterUnitStroops * 2n;
    const { tabId } = await meter.open(payload(c, ceiling.toString()));
    const first = meter.call(tabId);
    expect(first.call).toBe(1);
    expect(BigInt(first.remaining)).toBe(c.meterUnitStroops);
    meter.call(tabId);
    await expectRefusal(() => meter.call(tabId), "playground_meter_ceiling_reached", 402);
    // The refused call must not have accrued.
    const closed = await meter.close(tabId);
    expect(closed.settled).toBe(ceiling.toString());
  });

  it("settles the ACTUAL used amount, never the ceiling", async () => {
    const { tabId } = await meter.open(payload(c, "10000000"));
    meter.call(tabId);
    meter.call(tabId);
    const used = (c.meterUnitStroops * 2n).toString();
    const closed = await meter.close(tabId);
    expect(closed.settled).toBe(used);
    expect(closed.unspent).toBe((10_000_000n - c.meterUnitStroops * 2n).toString());
    // The load-bearing assertion: what actually went to /settle.
    expect(facilitator.calls.at(-1)).toEqual({ path: "/settle", amount: used });
  });

  it("settles zero when a tab closes unused — consuming the authorization", async () => {
    const { tabId } = await meter.open(payload(c, "1000000"));
    await meter.close(tabId);
    expect(facilitator.calls.at(-1)).toEqual({ path: "/settle", amount: "0" });
  });

  it("refuses to touch a settled tab again", async () => {
    const { tabId } = await meter.open(payload(c, "1000000"));
    await meter.close(tabId);
    await expectRefusal(() => meter.call(tabId), "playground_meter_tab_closed", 400);
    await expectRefusal(meter.close(tabId), "playground_meter_tab_closed", 400);
  });

  it("expires tabs with their authorization window", async () => {
    const { tabId } = await meter.open(payload(c, "1000000"));
    clock += (TAB_SECONDS - 60) * 1000 + 1;
    await expectRefusal(() => meter.call(tabId), "playground_meter_tab_not_found", 404);
  });

  it("passes the facilitator's settle refusal through verbatim", async () => {
    facilitator.refuseSettle(
      "invalid_upto_stellar_payload_settlement_exceeds_amount",
      "actual exceeds ceiling",
    );
    const { tabId } = await meter.open(payload(c, "1000000"));
    meter.call(tabId);
    await expectRefusal(
      meter.close(tabId),
      "invalid_upto_stellar_payload_settlement_exceeds_amount",
      402,
    );
  });

  it("reports an unreachable facilitator as retryable with nothing charged", async () => {
    const dead = createMeter({
      config: c,
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as typeof fetch,
      now: () => clock,
    });
    await expectRefusal(
      dead.open(payload(c, "1000000")),
      "playground_facilitator_unreachable",
      502,
    );
  });
});
