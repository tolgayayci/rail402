/**
 * Sponsor rotation and the `upto` settlement authority: payloads signed for the previous authority
 * settle until its grace ends, then are refused; `/supported` names only the new authority.
 */
import { describe, expect, it } from "vitest";
import { FeeBumpTransaction, Keypair } from "@stellar/stellar-sdk";
import {
  MemoryChannelPool,
  MemorySettlementLedger,
  SettlementEngine,
  StellarUptoScheme,
  keypairSigner,
} from "@rail402.dev/facilitator";
import {
  FakeServer,
  NETWORK,
  PASSPHRASE,
  authority as previous,
  channel,
  payment,
  policy,
  requirements,
  sponsor,
  uptoPolicy,
} from "./upto-helpers.ts";

function setup(now: () => number, validUntil: Date) {
  const server = new FakeServer();
  const current = Keypair.random();
  const engine = new SettlementEngine({
    network: NETWORK,
    passphrase: PASSPHRASE,
    rpcUrl: "http://127.0.0.1:1/rpc",
    server: server.asServer(),
    policy,
    ledger: new MemorySettlementLedger(),
    channels: new MemoryChannelPool([channel.publicKey()]),
    channelKeys: new Map([[channel.publicKey(), channel]]),
    sponsor,
    authority: current,
    timing: { pollIntervalMs: 5, duplicateWaitMs: 100, channelWaitMs: 20, confirmTimeoutMs: 1_000 },
  });
  const scheme = new StellarUptoScheme({
    network: NETWORK,
    passphrase: PASSPHRASE,
    server: server.asServer(),
    policy,
    upto: uptoPolicy,
    engine,
    previousAuthority: { signer: keypairSigner(previous, PASSPHRASE), validUntil },
    now,
  });
  return { server, scheme, current };
}

describe("the previous upto authority", () => {
  it("settles a payload naming the previous authority within the grace and refuses it after", async () => {
    const clock = { now: Date.parse("2026-10-22T12:00:00Z") };
    const { scheme, server, current } = setup(() => clock.now, new Date("2026-10-22T12:05:00Z"));
    // /supported names only the current authority.
    expect(scheme.getExtra(NETWORK)).toEqual({
      areFeesSponsored: true,
      facilitatorAddress: current.publicKey(),
    });

    const within = await scheme.settle(payment(), requirements({ amount: "250000" }));
    expect(within).toMatchObject({ success: true, amount: "250000" });
    const sent = server.sent[0];
    expect(sent).toBeInstanceOf(FeeBumpTransaction);
    if (sent instanceof FeeBumpTransaction)
      expect(sent.innerTransaction.operations[0]?.source).toBe(previous.publicKey());

    clock.now = Date.parse("2026-10-22T12:05:01Z");
    expect(await scheme.verify(payment(), requirements())).toMatchObject({
      isValid: false,
      invalidReason: "invalid_upto_stellar_requirements_facilitator_mismatch",
    });
    const after = await scheme.settle(payment(), requirements({ amount: "250000" }));
    expect(after).toMatchObject({
      success: false,
      errorReason: "invalid_upto_stellar_requirements_facilitator_mismatch",
    });
    expect(server.sent).toHaveLength(1);
  });

  it("refuses the previous authority as a party to the payment", async () => {
    const { scheme } = setup(() => Date.parse("2026-10-22T12:00:00Z"), new Date("2026-10-22T12:05:00Z"));
    const result = await scheme.verify(payment(), requirements({ payTo: previous.publicKey() }));
    expect(result.isValid).toBe(false);
  });
});
