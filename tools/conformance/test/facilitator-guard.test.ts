import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  checkFacilitatorAccess,
  guardedFetch,
  installFacilitatorGuard,
  readApiKey,
} from "../src/facilitator-guard.ts";
import { startForwarder } from "../src/forwarder.ts";
import { ProfileError, SpendMeter } from "../src/network.ts";

const dir = mkdtempSync(join(tmpdir(), "rail402-guard-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const caps = { maxXlmStroops: 1_000_000n, maxUsdcBaseUnits: 0n, maxSettlements: 2, maxNewAccounts: 0 };
const ceilings = (scheme: "exact" | "upto") => (scheme === "exact" ? 300_000n : 500_000n);
const settle = (scheme: string) =>
  JSON.stringify({
    x402Version: 2,
    paymentPayload: {},
    paymentRequirements: { scheme, network: "stellar:pubnet" },
  });

/** A fake network: records every request it receives. */
function recording() {
  const seen: { url: string; method: string; headers: Headers }[] = [];
  const inner = ((input: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
    });
    return Promise.resolve(Response.json({ success: false }));
  }) as typeof fetch;
  return { seen, inner };
}

const code = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return "";
  } catch (error) {
    return error instanceof ProfileError ? error.code : String(error);
  }
};

describe("the facilitator guard", () => {
  it("debits every /settle at its scheme's fee ceiling before sending it, and sends none past a cap", async () => {
    const meter = new SpendMeter(caps);
    const { seen, inner } = recording();
    const guarded = guardedFetch({ urls: ["https://pubnet.example/"], meter, feeCeiling: ceilings }, inner);
    await guarded("https://pubnet.example/settle", { method: "POST", body: settle("exact") });
    await guarded("https://pubnet.example/settle", { method: "POST", body: Buffer.from(settle("upto")) });
    expect(meter.spent).toMatchObject({ settlements: 2, xlmStroops: 800_000n });
    // A third is over the settlement cap: refused, and never sent.
    expect(
      await code(() => guarded("https://pubnet.example/settle", { method: "POST", body: settle("exact") })),
    ).toBe("spend_cap_exceeded");
    expect(seen).toHaveLength(2);
    // /verify, other paths and other hosts are not settlements.
    await guarded("https://pubnet.example/verify", { method: "POST", body: settle("exact") });
    await guarded("https://pubnet.example/supported");
    await guarded("https://other.example/settle", { method: "POST", body: settle("exact") });
    await guarded("https://pubnet.example.evil/settle", { method: "POST", body: settle("exact") });
    expect(meter.spent.settlements).toBe(2);
    expect(seen).toHaveLength(6);
  });

  it("counts a body it cannot read at the higher ceiling", async () => {
    const meter = new SpendMeter(undefined);
    const { inner } = recording();
    const guarded = guardedFetch({ urls: ["https://pubnet.example"], meter, feeCeiling: ceilings }, inner);
    await guarded("https://pubnet.example/settle", { method: "POST", body: "not json" });
    expect(meter.spent.xlmStroops).toBe(500_000n);
  });

  it("sends the API key as a bearer token to the facilitator only", async () => {
    const { seen, inner } = recording();
    const guarded = guardedFetch(
      {
        urls: ["https://pubnet.example"],
        meter: new SpendMeter(undefined),
        feeCeiling: ceilings,
        apiKey: "k-123",
      },
      inner,
    );
    await guarded("https://pubnet.example/supported");
    await guarded("https://x402.org/facilitator/supported");
    await guarded("https://pubnet.example/verify", {
      method: "POST",
      headers: { authorization: "Bearer mine" },
    });
    expect(seen.map((entry) => entry.headers.get("authorization"))).toEqual([
      "Bearer k-123",
      null,
      "Bearer mine",
    ]);
  });

  it("reads the key from an owner-only file and refuses a loose one", () => {
    const file = join(dir, "key.txt");
    writeFileSync(file, "k-123\n");
    chmodSync(file, 0o600);
    expect(readApiKey(file)).toBe("k-123");
    chmodSync(file, 0o640);
    expect(() => readApiKey(file)).toThrow(/pubnet_api_key_unsafe/);
    expect(() => readApiKey(join(dir, "missing.txt"))).toThrow(/pubnet_api_key_missing/);
  });

  it("refuses a run before spending when the facilitator wants a key it does not have or refuses", async () => {
    const answer =
      (status: number, body: unknown): typeof fetch =>
      () =>
        Promise.resolve(Response.json(body, { status }));
    const unauthorized = answer(401, {
      error: "unauthorized",
      reason: "A valid API key is required on this network.",
    });
    expect(
      await code(() =>
        checkFacilitatorAccess("https://pubnet.example", "stellar:pubnet", undefined, unauthorized),
      ),
    ).toBe("pubnet_api_key_missing");
    expect(
      await code(() => checkFacilitatorAccess("https://pubnet.example", "stellar:pubnet", "k", unauthorized)),
    ).toBe("pubnet_api_key_refused");
    const otherNetwork = answer(403, {});
    expect(
      await code(() => checkFacilitatorAccess("https://pubnet.example", "stellar:pubnet", "k", otherNetwork)),
    ).toBe("pubnet_api_key_refused");
    // The probe's empty payment refused as invalid: the caller is served.
    const served = answer(400, {
      isValid: false,
      invalidReason: "invalid_payload",
      invalidMessage: "no transaction",
    });
    expect(
      await code(() => checkFacilitatorAccess("https://pubnet.example", "stellar:pubnet", "k", served)),
    ).toBe("");
  });

  it("counts the settlements of a third-party suite that reaches the facilitator through the forwarder", async () => {
    let settles = 0;
    const facilitator = createServer((request, response) => {
      if (request.url === "/settle") settles++;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ success: false, errorReason: "invalid_payload", errorMessage: "test" }));
    });
    await new Promise<void>((resolve) => facilitator.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${String((facilitator.address() as AddressInfo).port)}`;
    const meter = new SpendMeter({ ...caps, maxSettlements: 1 });
    const guard = installFacilitatorGuard({ urls: [url], meter, feeCeiling: ceilings });
    const forwarder = await startForwarder({ target: url });
    try {
      const post = () =>
        fetch(`${forwarder.url}/settle`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: settle("exact"),
        });
      expect((await post()).status).toBe(200);
      // The second is over the cap: the forwarder answers an error and the facilitator never sees it.
      expect((await post()).status).toBe(502);
      expect(settles).toBe(1);
      expect(meter.spent.settlements).toBe(1);
    } finally {
      await forwarder.close();
      guard.restore();
      await new Promise((resolve) => facilitator.close(resolve));
    }
  });
});
