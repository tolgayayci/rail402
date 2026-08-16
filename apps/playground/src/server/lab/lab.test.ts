import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { loadConfig } from "../config.js";
import { createApp } from "../app.js";

/**
 * Route-level validation for the Policy Lab. The full deploy→pay→refuse→raise→retry flow needs a
 * ledger and is proven by `scripts/lab-e2e.ts`; these tests cover the guards that must reject bad
 * input BEFORE any smart-account work starts (so they never touch the network).
 */

const SECRET = Keypair.random().secret();
const makeApp = () => {
  const config = loadConfig({ PLAYGROUND_DISPENSER_SECRET: SECRET } as NodeJS.ProcessEnv);
  return createApp({ config }).app;
};

const post = (app: ReturnType<typeof makeApp>, path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("policy lab routes", () => {
  it("exposes the lab surface in /session/config", async () => {
    const cfg = (await (await makeApp().request("/session/config")).json()) as { demo: { lab?: unknown } };
    expect(cfg.demo.lab).toBeTruthy();
  });

  it("rejects a budget outside the allowed range with a coded reason", async () => {
    const app = makeApp();
    for (const limit of ["0.001", "5", "not-a-number"]) {
      const res = await post(app, "/lab/session", { limit });
      expect(res.status, limit).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe("playground_invalid_request");
    }
  });

  it("rejects an out-of-range rolling window", async () => {
    const res = await post(makeApp(), "/lab/session", { limit: "0.2", periodLedgers: 5 });
    expect(res.status).toBe(400);
  });

  it("404s an unknown lab session", async () => {
    const res = await makeApp().request("/lab/session/nope");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("playground_share_not_found");
  });

  it("rejects a pay with an unknown scheme before touching the ledger", async () => {
    const res = await post(makeApp(), "/lab/session/anything/pay", { scheme: "wire", amount: "0.1" });
    expect(res.status).toBe(400);
  });

  it("rejects an upto pay whose actual exceeds the ceiling", async () => {
    // A real lab id is not needed: this validation runs before the lab is consulted.
    const res = await post(makeApp(), "/lab/session/anything/pay", { scheme: "upto", ceiling: "0.1", actual: "0.2" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { reason: string }).reason).toContain("exceed the ceiling");
  });

  it("404s a pay against a session that does not exist (coded, not a crash)", async () => {
    const res = await post(makeApp(), "/lab/session/missing/pay", { scheme: "exact", amount: "0.1" });
    expect(res.status).toBe(404);
  });

  it("rejects a limit change with a bad scheme", async () => {
    const res = await post(makeApp(), "/lab/session/x/limit", { scheme: "nope", limit: "0.2" });
    expect(res.status).toBe(400);
  });
});
