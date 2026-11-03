import { describe, expect, it } from "vitest";
import {
  LUMEUS_HOSTS,
  Limiter,
  LumeusActivity,
  LumeusError,
  checkLumeusKey,
  isPublishableLumeusKey,
  lumeusCodeLabel,
  lumeusEndpoint,
  lumeusHostNetwork,
  type WalkStep,
} from "../src/index.ts";
import {
  BETA_APPROVALS,
  BETA_CONTRACT,
  RECORDING,
  SPONSOR,
  TEST_KEY,
  UPTO_CONTRACT,
  fakeActivity,
  lumeusError,
} from "./lumeus-fixture.ts";

const { since: SINCE, until: UNTIL } = RECORDING;
const noSleep = () => Promise.resolve();

function activity(
  fake: ReturnType<typeof fakeActivity>,
  extra: Partial<ConstructorParameters<typeof LumeusActivity>[0]> = {},
) {
  return new LumeusActivity({
    network: "stellar:testnet",
    apiKey: TEST_KEY,
    fetch: fake.fetch,
    sleep: noSleep,
    random: () => 0,
    ...extra,
  });
}

describe("Lumeus Activity walks", () => {
  it("follows the recorded pages of an account, pinned to one read view, to scanned_through_ledger", async () => {
    const fake = fakeActivity();
    const result = await activity(fake).walk({ kind: "account", address: SPONSOR }, SINCE, UNTIL);
    expect(result.pages).toBe(3);
    expect(result.scannedThrough).toBe(5_330_320);
    expect(result.readView).toMatchObject({ generation: "testnet-2025-12-18-v3", snapshotLedger: 5_347_677 });
    expect([...new Set(result.records.map((record) => record.ledger))]).toEqual([
      5_330_305, 5_330_311, 5_330_316,
    ]);
    expect(result.records.map((record) => record.txHash.slice(0, 8))).toContain("2cc59d87");
    // Every request carried the key, to the Activity host only; later pages keep the pinned view.
    expect(fake.calls.every((call) => call.authorization === `Bearer ${TEST_KEY}`)).toBe(true);
    expect(fake.calls.every((call) => call.url.host === LUMEUS_HOSTS["stellar:testnet"].activity)).toBe(true);
    expect(fake.calls[0]?.url.searchParams.get("order")).toBe("asc");
    expect(fake.calls[0]?.url.searchParams.get("generation")).toBeNull();
    expect(fake.calls[2]?.url.searchParams.get("snapshot_ledger")).toBe("5347677");
  });

  it("reads a contract's upto_settled event and an empty route's completed scan", async () => {
    const fake = fakeActivity();
    const client = activity(fake);
    const upto = await client.walk({ kind: "contract", address: UPTO_CONTRACT }, SINCE, UNTIL);
    expect(upto.records).toEqual([
      expect.objectContaining({ type: "upto_settled", ledger: 5_330_316, kind: "contract_event" }),
    ]);
    const empty = await client.walk(
      { kind: "account", address: "GC5OLUZ4WANPN6VT7YGTK2SRMZG762KOVKJXHWIO4K57UBASO2FMNRET" },
      SINCE,
      UNTIL,
    );
    expect(empty.records).toEqual([]);
    expect(empty.scannedThrough).toBe(5_330_320);
  });

  it("walks a range in windows and stops at the published tip", async () => {
    const fake = fakeActivity({ head: 5_330_330 });
    const windows = [];
    for await (const window of activity(fake).walkRange(
      { kind: "account", address: SPONSOR },
      SINCE,
      undefined,
      {
        windowLedgers: 16,
      },
    ))
      if (window.complete) windows.push([window.since, window.until, window.scannedThrough]);
    expect(windows).toEqual([
      [5_330_305, 5_330_321, 5_330_320],
      [5_330_321, 5_330_337, 5_330_330],
    ]);
  });

  it("retries busy answers after Retry-After, and stops instead of waiting more than 60 s", async () => {
    const waits: number[] = [];
    const busy = fakeActivity({
      override: (_call, index) => (index < 2 ? lumeusError(503, "busy", 2) : undefined),
    });
    const client = activity(busy, { sleep: (ms) => (waits.push(ms), Promise.resolve()) });
    await expect(
      client.walk({ kind: "contract", address: UPTO_CONTRACT }, SINCE, UNTIL),
    ).resolves.toMatchObject({
      scannedThrough: 5_330_320,
    });
    expect(waits).toEqual([2_000, 2_000]);

    const capped = fakeActivity({ override: () => lumeusError(429, "rate_limited", 3_600) });
    const error = await activity(capped)
      .walk({ kind: "contract", address: UPTO_CONTRACT }, SINCE, UNTIL)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LumeusError);
    expect(error).toMatchObject({ code: "lumeus_rate_limited", retryAfterSeconds: 3_600, retryable: true });
    expect(capped.calls).toHaveLength(1);

    const down = fakeActivity({ override: () => lumeusError(502, "unavailable") });
    await expect(
      activity(down, { attempts: 3 }).walk({ kind: "contract", address: UPTO_CONTRACT }, SINCE, UNTIL),
    ).rejects.toMatchObject({ code: "lumeus_unavailable", retryable: true });
    expect(down.calls).toHaveLength(3);
  });

  it("never repeats a query_timeout request: the window is halved instead", async () => {
    const fake = fakeActivity({
      override: (call) =>
        call.url.searchParams.get("since_ledger") === String(SINCE) &&
        call.url.searchParams.get("until_ledger") === String(UNTIL)
          ? lumeusError(503, "query_timeout", 30)
          : undefined,
    });
    const windows: string[] = [];
    for await (const window of activity(fake).walkRange(
      { kind: "contract", address: UPTO_CONTRACT },
      SINCE,
      UNTIL,
      {
        windowLedgers: 16,
      },
    ))
      windows.push(`${String(window.since)}-${String(window.until)}`);
    expect(windows).toEqual(["5330305-5330313", "5330313-5330321"]);
    const asked = fake.calls.map((call) => call.url.searchParams.get("until_ledger"));
    expect(asked.filter((until) => until === String(UNTIL))).toHaveLength(2);
    // The second time the full window's end is asked it is a narrower window that starts later.
    expect(
      fake.calls.filter((call) => call.url.searchParams.get("since_ledger") === String(SINCE)).length,
    ).toBe(2);
  });

  it("restarts a window without the old read view after generation_changed", async () => {
    const recorded = RECORDING.errors["generation"];
    let failed = false;
    const fake = fakeActivity({
      override: (call) => {
        if (failed || call.url.searchParams.get("generation") === null) return undefined;
        failed = true;
        return Response.json(recorded?.body, { status: recorded?.status ?? 409 });
      },
    });
    const steps: WalkStep[] = [];
    for await (const step of activity(fake).walkRange({ kind: "account", address: SPONSOR }, SINCE, UNTIL, {
      windowLedgers: 16,
    }))
      steps.push(step);
    // The first page moved no checkpoint, so the window starts again from its first ledger.
    expect(steps.filter((step) => step.complete).map((step) => step.scannedThrough)).toEqual([5_330_320]);
    expect([...new Set(steps.flatMap((step) => step.records.map((record) => record.ledger)))]).toEqual([
      5_330_305, 5_330_311, 5_330_316,
    ]);
    expect(fake.calls.filter((call) => call.url.searchParams.get("generation") === null)).toHaveLength(2);
  });

  it("hands over each page as it is read, so a failure later in the window loses at most that page", async () => {
    const steps = async (fake: ReturnType<typeof fakeActivity>, extra = {}) => {
      const seen: WalkStep[] = [];
      const error = await (async () => {
        for await (const step of activity(fake, extra).walkRange(
          { kind: "account", address: SPONSOR },
          SINCE,
          UNTIL,
          { windowLedgers: 16 },
        ))
          seen.push(step);
      })().catch((caught: unknown) => caught);
      return { seen, error };
    };
    // Each page vouches for the ledgers before its last record: records come in ascending order.
    const whole = await steps(fakeActivity());
    expect(whole.seen.map((step) => [step.records.length, step.scannedThrough, step.complete])).toEqual([
      [2, null, false],
      [2, 5_330_310, false],
      [2, 5_330_320, true],
    ]);
    // The third page never comes: the first two are already handed over with their checkpoint.
    const broken = await steps(
      fakeActivity({
        override: (_call, index) => (index >= 2 ? lumeusError(502, "unavailable") : undefined),
      }),
      { attempts: 1 },
    );
    expect(broken.error).toMatchObject({ code: "lumeus_unavailable", retryable: true });
    expect(broken.seen.map((step) => step.scannedThrough)).toEqual([null, 5_330_310]);
    expect(broken.seen.flatMap((step) => step.records.map((record) => record.ledger))).toEqual([
      5_330_305, 5_330_305, 5_330_311, 5_330_311,
    ]);
  });

  it("refuses records that go back in the ledger order, since a page's checkpoint relies on it", async () => {
    const first = RECORDING.pages[
      `/accounts/${SPONSOR}/activity?order=asc&since_ledger=${String(SINCE)}&until_ledger=${String(UNTIL)}`
    ] as { _embedded: { records: Record<string, unknown>[] } };
    const [a, b] = first._embedded.records;
    const fake = fakeActivity({
      override: (_call, index) =>
        index === 0
          ? Response.json({
              ...first,
              _embedded: {
                records: [
                  { ...a, ledger: 5_330_309 },
                  { ...b, ledger: 5_330_306 },
                ],
              },
            })
          : undefined,
    });
    await expect(
      activity(fake).walk({ kind: "account", address: SPONSOR }, SINCE, UNTIL),
    ).rejects.toMatchObject({ code: "lumeus_response_invalid" });
  });

  it("walks the approve events that name a beta upto contract, through topic search", async () => {
    const fake = fakeActivity({ head: 5_348_000 });
    const result = await activity(fake).walk(
      { kind: "approvals", address: BETA_CONTRACT },
      BETA_APPROVALS.since,
      BETA_APPROVALS.until,
    );
    expect(result.records).toEqual([
      expect.objectContaining({ kind: "contract_event", type: "approve", ledger: 3_953_878 }),
    ]);
    expect(result.records[0]?.txHash.slice(0, 8)).toBe("b38c1add");
    expect(result.scannedThrough).toBe(BETA_APPROVALS.until - 1);
    const [call] = fake.calls;
    expect(call?.url.pathname).toBe(`/accounts/${BETA_CONTRACT}/contract-events`);
    expect(call?.url.searchParams.get("name")).toBe("approve");
    expect(call?.url.searchParams.get("limit")).toBe("1000");

    // A topic-search answer holding anything but approve events is refused.
    const page = Object.values(BETA_APPROVALS.pages)[0] as {
      _embedded: { records: Record<string, unknown>[] };
    };
    const forged = fakeActivity({
      override: () => Response.json(_embedded(page, { type: "transfer" })),
    });
    await expect(
      activity(forged).walk(
        { kind: "approvals", address: BETA_CONTRACT },
        BETA_APPROVALS.since,
        BETA_APPROVALS.until,
      ),
    ).rejects.toMatchObject({ code: "lumeus_response_invalid" });
  });

  it("refuses a next link to another origin or route, and never sends the key there", async () => {
    const first = RECORDING.pages[
      `/accounts/${SPONSOR}/activity?order=asc&since_ledger=${String(SINCE)}&until_ledger=${String(UNTIL)}`
    ] as { _links: { next: { href: string } } };
    for (const href of [
      "https://evil.example/accounts/x/activity?cursor=1",
      `/accounts/${UPTO_CONTRACT}/activity?cursor=1`,
    ]) {
      const fake = fakeActivity({
        override: (_call, index) =>
          index === 0 ? Response.json({ ...first, _links: { next: { href } } }) : undefined,
      });
      await expect(
        activity(fake).walk({ kind: "account", address: SPONSOR }, SINCE, UNTIL),
      ).rejects.toMatchObject({
        code: "lumeus_request_refused",
      });
      expect(fake.calls).toHaveLength(1);
    }
  });

  it("refuses pages that leave the window, the read view or the network", async () => {
    const page = RECORDING.pages[
      `/contracts/${UPTO_CONTRACT}/activity?order=asc&since_ledger=${String(SINCE)}&until_ledger=${String(UNTIL)}`
    ] as { read_view: Record<string, unknown>; _embedded: { records: Record<string, unknown>[] } };
    const variants = [
      { ..._embedded(page, { ledger: 5_330_400 }) },
      { ...page, read_view: { ...page.read_view, network: "pubnet" } },
      { ...page, scanned_through_ledger: 5_330_500 },
      { ...page, range_complete: false, _links: {} },
    ];
    for (const body of variants) {
      const fake = fakeActivity({ override: () => Response.json(body) });
      await expect(
        activity(fake).walk({ kind: "contract", address: UPTO_CONTRACT }, SINCE, UNTIL),
      ).rejects.toMatchObject({ code: "lumeus_response_invalid" });
    }
  });

  it("maps the recorded 401 and 400 answers to coded, final errors without the key", async () => {
    for (const [name, code] of [
      ["unauthorized", "lumeus_unauthorized"],
      ["bad-request", "lumeus_request_refused"],
    ] as const) {
      const recorded = RECORDING.errors[name];
      const fake = fakeActivity({
        override: () => Response.json(recorded?.body, { status: recorded?.status }),
      });
      const error = (await activity(fake)
        .walk({ kind: "account", address: SPONSOR }, SINCE, UNTIL)
        .catch((caught: unknown) => caught)) as LumeusError;
      expect(error).toMatchObject({ code, retryable: false });
      expect(fake.calls).toHaveLength(1);
      expect(`${error.message} ${JSON.stringify(error)}`).not.toContain(TEST_KEY);
    }
  });
});

function _embedded(
  page: { _embedded: { records: Record<string, unknown>[] } },
  change: Record<string, unknown>,
): object {
  return {
    ...page,
    _embedded: { records: page._embedded.records.map((record) => ({ ...record, ...change })) },
  };
}

describe("Lumeus keys and hosts", () => {
  it("accepts a publishable key only where asked, for its own network", () => {
    const publishable = `lum_pub_test_${"1".repeat(32)}`;
    expect(isPublishableLumeusKey(publishable)).toBe(true);
    expect(isPublishableLumeusKey(TEST_KEY)).toBe(false);
    expect(() => {
      checkLumeusKey(publishable, "stellar:testnet");
    }).toThrow(/not a server key/);
    expect(() => {
      checkLumeusKey(publishable, "stellar:testnet", { publishable: true });
    }).not.toThrow();
    expect(() => {
      checkLumeusKey(publishable, "stellar:pubnet", { publishable: true });
    }).toThrow(/belongs to stellar:testnet/);
    expect(() => {
      checkLumeusKey(`whk_${"2".repeat(40)}`, "stellar:testnet", { publishable: true });
    }).toThrow(/not a server or publishable key/);
  });

  it("labels failed requests with a bounded set of codes, whatever the body says", () => {
    expect(lumeusCodeLabel("busy", 503)).toBe("busy");
    expect(lumeusCodeLabel("transport", 0)).toBe("transport");
    expect(lumeusCodeLabel(undefined, 502)).toBe("http_502");
    expect(lumeusCodeLabel(undefined, 418)).toBe("other");
    expect(lumeusCodeLabel("x".repeat(64), 400)).toBe("other");
    expect(lumeusCodeLabel(`made_up_${String(Math.random())}`, 500)).toBe("other");
  });

  it("pairs a lum_test_ key with testnet and a lum_live_ key with mainnet only", () => {
    expect(() => {
      checkLumeusKey(TEST_KEY, "stellar:testnet");
    }).not.toThrow();
    expect(() => {
      checkLumeusKey(TEST_KEY, "stellar:pubnet");
    }).toThrow(/belongs to stellar:testnet/);
    expect(() => {
      checkLumeusKey(`lum_live_${"1".repeat(32)}`, "stellar:testnet");
    }).toThrow(/belongs to stellar:pubnet/);
    for (const bad of [
      `lum_pub_${"2".repeat(32)}`,
      `whk_${"3".repeat(32)}`,
      "",
      `lum_test_${"4".repeat(32)}\n`,
    ]) {
      let message = "";
      try {
        checkLumeusKey(bad, "stellar:testnet");
      } catch (error) {
        message = (error as Error).message;
        expect(error).toMatchObject({ code: "lumeus_key_invalid" });
      }
      expect(message).not.toBe("");
      if (bad !== "") expect(message).not.toContain(bad.trim());
    }
  });

  it("sends a key only to the network's Lumeus host of that product", () => {
    expect(lumeusEndpoint("https://api-testnet.lumeus.dev", "stellar:testnet", "activity").host).toBe(
      "api-testnet.lumeus.dev",
    );
    for (const [url, network, product] of [
      ["https://api.lumeus.dev", "stellar:testnet", "activity"],
      ["https://rpc-testnet.lumeus.dev", "stellar:testnet", "activity"],
      ["http://api-testnet.lumeus.dev", "stellar:testnet", "activity"],
      ["https://api-testnet.lumeus.dev.evil.example", "stellar:testnet", "activity"],
      ["https://user:pw@rpc.lumeus.dev", "stellar:pubnet", "rpc"],
    ] as const) {
      expect(() => lumeusEndpoint(url, network, product)).toThrow(/must be https:\/\//);
    }
    expect(lumeusHostNetwork("rpc.lumeus.dev")).toBe("stellar:pubnet");
    expect(lumeusHostNetwork("soroban-testnet.stellar.org")).toBeUndefined();
    expect(
      () =>
        new LumeusActivity({ network: "stellar:pubnet", apiKey: TEST_KEY, url: "https://api.lumeus.dev" }),
    ).toThrow(/belongs to stellar:testnet/);
  });
});

describe("Limiter", () => {
  it("keeps at most its number of tasks in flight", async () => {
    const limiter = new Limiter(3);
    let active = 0;
    let most = 0;
    const task = async () => {
      active++;
      most = Math.max(most, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
    };
    await Promise.all(Array.from({ length: 20 }, () => limiter.run(task)));
    expect(most).toBe(3);
    expect(limiter.active).toBe(0);
  });
});
