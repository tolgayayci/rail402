import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { X402Error } from "@rail402/errors";
import { loadConfig, describeConfig } from "./config.js";

const SECRET = Keypair.random().secret();
const env = (o: Record<string, string | undefined> = {}) =>
  ({ PLAYGROUND_DISPENSER_SECRET: SECRET, ...o }) as NodeJS.ProcessEnv;

const expectCode = (e: Record<string, string | undefined>, code: string) => {
  try {
    loadConfig(env(e));
    throw new Error("expected loadConfig to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(X402Error);
    expect((err as X402Error).code).toBe(code);
    expect((err as X402Error).reason.trim().length).toBeGreaterThan(20);
  }
};

describe("playground config", () => {
  it("needs nothing but the dispenser secret", () => {
    const c = loadConfig(env());
    expect(c.facilitatorUrl).toBe("https://facilitator.rail402.dev");
    expect(c.dripStroops).toBe(5_000_000n);
    expect(c.corsOrigins).toEqual(["*"]);
  });

  it("refuses to start without the dispenser secret, with a coded reason", () => {
    expectCode({ PLAYGROUND_DISPENSER_SECRET: undefined }, "config_missing_required");
  });

  it("refuses a malformed secret", () => {
    expectCode({ PLAYGROUND_DISPENSER_SECRET: "not-a-secret" }, "config_invalid_value");
  });

  it("verifies the USDC issuer by SAC derivation rather than trusting it", () => {
    // A checksummed, real-looking issuer that is NOT the canonical one derives a different
    // contract id — the lookalike-asset control.
    expectCode({ PLAYGROUND_USDC_ISSUER: Keypair.random().publicKey() }, "config_invalid_value");
  });

  it("defaults payTo to the dispenser account, closing the USDC loop", () => {
    const c = loadConfig(env());
    expect(c.payTo).toBe(Keypair.fromSecret(SECRET).publicKey());
  });

  it("never leaks the secret through describeConfig", () => {
    const described = JSON.stringify(describeConfig(loadConfig(env())));
    expect(described).not.toContain(SECRET);
  });
});
