import { describe, expect, it } from "vitest";
import { READINESS_DATABASE_TTL_MS, cachedProbe } from "@rail402.dev/service";

describe("the readiness database probe", () => {
  it("runs once for any number of concurrent requests and answers from its result for the TTL", async () => {
    let clock = 0;
    let calls = 0;
    let finish: (value: string) => void = () => undefined;
    const probe = cachedProbe(
      () =>
        new Promise<string>((resolve) => {
          calls++;
          finish = resolve;
        }),
      READINESS_DATABASE_TTL_MS,
      () => clock,
    );
    // A flood of readiness requests while the database is slow: one query, shared by all.
    const flood = Array.from({ length: 500 }, () => probe());
    expect(calls).toBe(1);
    finish("ok");
    expect(new Set(await Promise.all(flood))).toEqual(new Set(["ok"]));
    // Within the TTL the result is reused; after it, the probe runs again.
    clock += READINESS_DATABASE_TTL_MS - 1;
    await probe();
    expect(calls).toBe(1);
    clock += 1;
    const again = probe();
    expect(calls).toBe(2);
    finish("down");
    expect(await again).toBe("down");
  });

  it("is bounded to a couple of seconds, so readiness follows the database closely", () => {
    expect(READINESS_DATABASE_TTL_MS).toBeGreaterThan(0);
    expect(READINESS_DATABASE_TTL_MS).toBeLessThanOrEqual(2_000);
  });
});
