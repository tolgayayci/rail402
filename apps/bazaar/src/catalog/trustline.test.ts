import { describe, it, expect } from "vitest";
import { TrustlineChecker, trustlineTarget, type TrustlineState } from "./trustline.js";

/**
 * The trustline pre-flight (§3.5, S2). The facilitator's settle-time "missing trustline" error is a
 * post-mortem; this is the discovery-time half, so an agent can prefer a seller who can actually
 * RECEIVE the asset over one who cannot. It is advisory and must never gate cataloging, so the tests
 * that matter are: it applies to exactly the right (network, asset, payTo) triples, it maps each
 * Horizon shape to the right state, and every non-`ok` verdict carries a legible reason (§3.7).
 *
 * All Horizon access is injected — no network — and `identifyStellarAsset` derives the (code, issuer)
 * from the SAC, so the mock balance row is built from what the checker itself would look for.
 */

const NET = "stellar:testnet";
const USDC_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const XLM_SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const PAY_TO = "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO";
const CONTRACT_PAYEE = "CCMM3FMGEH7FHRYXZ3WQDQCTIWDXGZBGW7D4UT7NKH34SUQACYC3U54X";

/** The (code, issuer) the checker derives for USDC — the mock balances must match it exactly. */
const target = trustlineTarget(NET, USDC_SAC, PAY_TO)!;

type HorizonReply = { status?: number; balances?: unknown; throw?: boolean; notJson?: boolean };

/** A fetch that answers one Horizon `/accounts/:id` call however the case needs, counting calls. */
function horizon(reply: HorizonReply) {
  let calls = 0;
  const impl = (async () => {
    calls++;
    if (reply.throw) throw new Error("network down");
    const status = reply.status ?? 200;
    const body = reply.notJson ? "<!doctype html>" : JSON.stringify({ balances: reply.balances ?? [] });
    return new Response(status === 404 || status >= 500 ? "" : body, { status });
  }) as unknown as typeof fetch;
  return { impl, calls: () => calls };
}

const usdcLine = (over: Record<string, unknown> = {}) => ({
  asset_type: "credit_alphanum4",
  asset_code: target.code,
  asset_issuer: target.issuer,
  limit: "1000.0000000",
  is_authorized: true,
  ...over,
});

async function checkWith(reply: HorizonReply): Promise<TrustlineState | undefined> {
  const f = horizon(reply);
  const checker = new TrustlineChecker({ fetchImpl: f.impl, now: () => 1_000 });
  return (await checker.check(NET, USDC_SAC, PAY_TO))?.state;
}

describe("trustline pre-flight — when the question applies", () => {
  it("applies to a classic G payee paid in a derivable issued asset", () => {
    expect(trustlineTarget(NET, USDC_SAC, PAY_TO)).toMatchObject({ code: "USDC" });
    expect(new TrustlineChecker().applies(NET, USDC_SAC, PAY_TO)).toBe(true);
  });

  it("does NOT apply to a contract (C…) payee — SAC balances live in contract storage, no trustline", () => {
    expect(trustlineTarget(NET, USDC_SAC, CONTRACT_PAYEE)).toBeUndefined();
    expect(new TrustlineChecker().applies(NET, USDC_SAC, CONTRACT_PAYEE)).toBe(false);
  });

  it("does NOT apply to native XLM — it needs no trustline", () => {
    expect(trustlineTarget(NET, XLM_SAC, PAY_TO)).toBeUndefined();
  });

  it("does NOT apply on a network with no configured Horizon", () => {
    expect(trustlineTarget("stellar:unknown", USDC_SAC, PAY_TO)).toBeUndefined();
  });

  it("returns undefined from check() when the question does not apply, without touching the network", async () => {
    const f = horizon({ balances: [] });
    const verdict = await new TrustlineChecker({ fetchImpl: f.impl }).check(NET, USDC_SAC, CONTRACT_PAYEE);
    expect(verdict).toBeUndefined();
    expect(f.calls()).toBe(0);
  });
});

describe("trustline pre-flight — mapping Horizon to a state", () => {
  it("ok: an authorized trustline with a non-zero limit", async () => {
    expect(await checkWith({ balances: [usdcLine()] })).toBe("ok");
  });

  it("missing: no trustline row for the asset", async () => {
    expect(await checkWith({ balances: [{ asset_type: "native", limit: "1" }] })).toBe("missing");
  });

  it("missing: the account does not exist (404)", async () => {
    expect(await checkWith({ status: 404 })).toBe("missing");
  });

  it("unauthorized: the issuer has not authorized the trustline", async () => {
    expect(await checkWith({ balances: [usdcLine({ is_authorized: false })] })).toBe("unauthorized");
  });

  it("unauthorized: the trustline exists but its limit is zero", async () => {
    expect(await checkWith({ balances: [usdcLine({ limit: "0" })] })).toBe("unauthorized");
  });

  it("unknown: Horizon errors, is unreachable, or returns a shape we cannot read", async () => {
    expect(await checkWith({ status: 503 })).toBe("unknown");
    expect(await checkWith({ throw: true })).toBe("unknown");
    expect(await checkWith({ notJson: true })).toBe("unknown");
  });

  it("carries a non-null reason on every non-ok verdict (§3.7), and none on ok", async () => {
    const f = horizon({ balances: [usdcLine()] });
    const ok = await new TrustlineChecker({ fetchImpl: f.impl, now: () => 1 }).check(NET, USDC_SAC, PAY_TO);
    expect(ok?.reason).toBeUndefined();
    for (const reply of [{ balances: [] }, { status: 404 }, { status: 500 }, { balances: [usdcLine({ is_authorized: false })] }]) {
      const v = await new TrustlineChecker({ fetchImpl: horizon(reply).impl, now: () => 1 }).check(NET, USDC_SAC, PAY_TO);
      expect(v?.state).not.toBe("ok");
      expect(v?.reason, JSON.stringify(reply)).toBeTruthy();
    }
  });
});

describe("trustline pre-flight — caching, so a burst of settlements is not a burst at Horizon", () => {
  it("serves a fresh ok verdict from cache instead of asking Horizon again", async () => {
    const f = horizon({ balances: [usdcLine()] });
    const checker = new TrustlineChecker({ fetchImpl: f.impl, now: () => 5_000 });
    expect((await checker.check(NET, USDC_SAC, PAY_TO))?.state).toBe("ok");
    expect((await checker.check(NET, USDC_SAC, PAY_TO))?.state).toBe("ok");
    expect(f.calls()).toBe(1); // second read hit the cache
    expect(checker.cached(NET, USDC_SAC, PAY_TO)?.state).toBe("ok");
  });

  it("re-asks once the cached verdict has expired", async () => {
    const f = horizon({ balances: [usdcLine()] });
    let t = 0;
    const checker = new TrustlineChecker({ fetchImpl: f.impl, now: () => t });
    await checker.check(NET, USDC_SAC, PAY_TO);
    t += 60 * 60 * 1000; // an hour later — past the ok TTL
    await checker.check(NET, USDC_SAC, PAY_TO);
    expect(f.calls()).toBe(2);
  });
});
