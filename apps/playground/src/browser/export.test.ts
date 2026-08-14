import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { buildTerminalExport } from "./export.js";
import { createSession, type SessionConfig } from "./session.js";

const config: SessionConfig = {
  network: "stellar:testnet",
  facilitatorUrl: "https://facilitator.rail402.dev",
  horizonUrl: "https://horizon-testnet.stellar.org",
  friendbotUrl: "https://friendbot.stellar.org",
  usdc: {
    code: "USDC",
    issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    sac: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  },
  playgroundUrl: "https://playground.rail402.dev",
};

describe("buildTerminalExport", () => {
  it("produces a runnable .env carrying the session key and facilitator", () => {
    const session = createSession();
    const { env, warning } = buildTerminalExport(session, config);
    expect(env).toContain(`STELLAR_SECRET=${session.secret}`);
    expect(env).toContain(`STELLAR_ADDRESS=${session.address}`);
    expect(env).toContain("FACILITATOR_URL=https://facilitator.rail402.dev");
    expect(env).toContain("stellar:testnet");
    // The custody warning must travel with the key.
    expect(warning.toLowerCase()).toContain("testnet");
    expect(env).toContain("TEST NETWORK ONLY");
  });

  it("exports a key that reconstructs the same account", () => {
    const session = createSession();
    const { env } = buildTerminalExport(session, config);
    const secret = env.match(/STELLAR_SECRET=(\S+)/)![1]!;
    expect(Keypair.fromSecret(secret).publicKey()).toBe(session.address);
  });
});
