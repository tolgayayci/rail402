import { describe, expect, it } from "vitest";
import {
  MemorySettlementLedger,
  RESET_FRESH_MS,
  recordRestoreHold,
  restartDecision,
  restoreHoldLedgers,
  type RestartReading,
} from "@rail402.dev/facilitator";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const PUBNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";
const now = new Date("2026-10-29T12:00:00Z");
const fresh = new Date(now.getTime() - 5_000);
const holdLedgers = restoreHoldLedgers(300);

/** A settlement ledger restored to an earlier state (unless `restored` is false), with recorded ledgers. */
class Rewound extends MemorySettlementLedger {
  readonly from = new Map<string, number>();
  restored = true;

  rewindAnchor(network: string): Promise<number | null | undefined> {
    return Promise.resolve(this.restored ? (this.from.get(network) ?? null) : undefined);
  }

  rewindLedger(network: string, ledger: number, restartedBelow?: number): Promise<number | undefined> {
    if (!this.restored) return Promise.resolve(undefined);
    const recorded = this.from.get(network);
    const restarted =
      recorded !== undefined && restartedBelow !== undefined && recorded > ledger + restartedBelow;
    const from = recorded === undefined || restarted ? ledger : recorded;
    this.from.set(network, from);
    return Promise.resolve(from);
  }
}

function observe(
  ledger: Rewound,
  overrides: Partial<Parameters<typeof recordRestoreHold>[0]> = {},
  provider = TESTNET_PASSPHRASE,
) {
  let asked = 0;
  const result = recordRestoreHold({
    ledger,
    network: "stellar:testnet",
    passphrase: TESTNET_PASSPHRASE,
    timeoutMaxSeconds: 300,
    latestLedger: 1_000,
    closedAt: fresh,
    now,
    networkPassphrase: () => {
      asked += 1;
      return Promise.resolve(provider);
    },
    ...overrides,
  });
  return { result, asked: () => asked };
}

describe("recording where the restore hold counts from", () => {
  it("lasts the longest window rule 7 accepts at one second a ledger, plus a lagging reading", () => {
    expect(holdLedgers).toBe(300 + 2 + 5);
  });

  it("does nothing, and asks the provider nothing, when the ledger was never restored", async () => {
    const ledger = new Rewound();
    ledger.restored = false;
    const { result, asked } = observe(ledger);
    expect(await result).toEqual({});
    expect(asked()).toBe(0);
  });

  it("records the first ledger only from a provider of this network whose newest ledger closed just now", async () => {
    const ledger = new Rewound();
    // Until something is recorded, the hold is pending and every request holds.
    expect(await observe(ledger, {}, PUBNET_PASSPHRASE).result).toEqual({ pending: true });
    expect(ledger.from.size).toBe(0);
    const stale = new Date(now.getTime() - RESET_FRESH_MS - 1);
    expect(await observe(ledger, { closedAt: stale }).result).toEqual({ pending: true });
    expect(await observe(ledger, { closedAt: undefined }).result).toEqual({ pending: true });
    expect(ledger.from.size).toBe(0);
    // The reading's ledger closed 5 s ago: the chain may be up to 5 ledgers further by now.
    expect(await observe(ledger).result).toEqual({ recorded: 1_005 });
    expect(ledger.from.get("stellar:testnet")).toBe(1_005);
    // Once recorded, a later reading neither moves it nor asks the provider again.
    const later = observe(ledger, { latestLedger: 1_010 });
    expect(await later.result).toEqual({});
    expect(later.asked()).toBe(0);
  });

  it("counts the reading's age into the first ledger, as if a ledger had closed every second since", async () => {
    // Closed 55 s ago: as many as 55 ledgers may have closed since, and a lost zero accepted at one.
    const ledger = new Rewound();
    const closedAt = new Date(now.getTime() - 55_000);
    expect(await observe(ledger, { latestLedger: 990, closedAt }).result).toEqual({ recorded: 1_045 });
  });

  it("refuses a reading whose newest ledger closes in the future, beyond a few seconds of clock skew", async () => {
    const ledger = new Rewound();
    const ahead = new Date(now.getTime() + 3_600_000);
    expect(await observe(ledger, { closedAt: ahead }).result).toEqual({ pending: true });
    expect(ledger.from.size).toBe(0);
    const skewed = new Date(now.getTime() + 3_000);
    expect(await observe(ledger, { closedAt: skewed }).result).toEqual({ recorded: 1_000 });
  });

  it("records pubnet's first ledger under the same checks", async () => {
    const ledger = new Rewound();
    const pubnet = { network: "stellar:pubnet", passphrase: PUBNET_PASSPHRASE } as const;
    expect(await observe(ledger, pubnet, TESTNET_PASSPHRASE).result).toEqual({ pending: true });
    expect(await observe(ledger, pubnet, PUBNET_PASSPHRASE).result).toEqual({ recorded: 1_005 });
  });

  it("starts the hold again on a reset network only once a later reading sees the new chain again", async () => {
    const ledger = new Rewound();
    ledger.from.set("stellar:testnet", 2_000_000);
    const first = await observe(ledger).result;
    expect(first).toEqual({ seen: 1_000 });
    expect(ledger.from.get("stellar:testnet")).toBe(2_000_000);
    expect(await observe(ledger, { latestLedger: 1_003, seen: 1_000 }).result).toEqual({ restarted: 1_008 });
    expect(ledger.from.get("stellar:testnet")).toBe(1_008);
  });

  it("never starts pubnet's hold again", async () => {
    const ledger = new Rewound();
    ledger.from.set("stellar:pubnet", 2_000_000);
    const pubnet = { network: "stellar:pubnet", passphrase: PUBNET_PASSPHRASE, seen: 999 } as const;
    expect(await observe(ledger, pubnet, PUBNET_PASSPHRASE).result).toEqual({});
    expect(ledger.from.get("stellar:pubnet")).toBe(2_000_000);
  });
});

/** A testnet reading 1,000 ledgers in after a reset, far below a hold recorded at 2,000,000. */
function reading(overrides: Partial<RestartReading> = {}): RestartReading {
  return {
    network: "stellar:testnet",
    latestLedger: 1_000,
    closedAt: fresh,
    now,
    anchor: 2_000_000,
    holdLedgers,
    sameNetwork: true,
    seen: undefined,
    ...overrides,
  };
}

describe("the restore hold after a network reset", () => {
  it("starts again only once a later poll sees the new chain again, still moving on", () => {
    expect(restartDecision(reading())).toEqual({ restart: false, seen: 1_000 });
    expect(restartDecision(reading({ latestLedger: 1_003, seen: 1_000 }))).toEqual({ restart: true });
    // A second reading lower than the first is no chain moving on: start watching again from it.
    expect(restartDecision(reading({ latestLedger: 990, seen: 1_000 }))).toEqual({
      restart: false,
      seen: 990,
    });
  });

  it("never starts again on pubnet, whose ledgers never count from the start again", () => {
    expect(restartDecision(reading({ network: "stellar:pubnet" }))).toEqual({ restart: false });
    expect(restartDecision(reading({ network: "stellar:pubnet", seen: 999 }))).toEqual({ restart: false });
  });

  it("ignores a reading whose newest ledger closed long ago, as a lagging provider's did", () => {
    const stale = new Date(now.getTime() - RESET_FRESH_MS - 1);
    expect(restartDecision(reading({ closedAt: stale, seen: 999 }))).toEqual({ restart: false });
    expect(restartDecision(reading({ closedAt: undefined, seen: 999 }))).toEqual({ restart: false });
  });

  it("ignores a provider that serves another network", () => {
    expect(restartDecision(reading({ sameNetwork: false, seen: 999 }))).toEqual({ restart: false });
  });

  it("ignores a reading within one hold of the recorded ledger", () => {
    expect(restartDecision(reading({ latestLedger: 2_000_000 - holdLedgers, seen: 999 }))).toEqual({
      restart: false,
    });
  });
});
