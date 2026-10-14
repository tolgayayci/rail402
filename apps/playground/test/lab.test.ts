import { describe, expect, it } from "vitest";
import { egressCodes } from "@rail402.dev/safe-fetch/codes";
import { paymentCodes } from "@rail402.dev/sdk";
import {
  CHECK_EXPECTED_CODES,
  CHECK_IDS,
  DEFAULT_CAPS,
  EXPERIMENT_IDS,
  LAB_PATHS,
  LAB_PREFIX,
  LAB_PRICES,
  SCENARIO_EXPERIMENTS,
  SCENARIO_IDS,
  STEP_IDS,
  runIdempotencyKey,
  sellPath,
} from "../src/shared/lab.ts";

describe("lab vocabulary", () => {
  it("offers each scenario's experiments from the known set, normal first", () => {
    expect(Object.keys(SCENARIO_EXPERIMENTS).sort()).toEqual([...SCENARIO_IDS].sort());
    for (const experiments of Object.values(SCENARIO_EXPERIMENTS)) {
      expect(experiments[0]).toBe("normal");
      for (const experiment of experiments) expect(EXPERIMENT_IDS).toContain(experiment);
    }
  });

  it("expects a registered refusal code for every check", () => {
    expect(Object.keys(CHECK_EXPECTED_CODES).sort()).toEqual([...CHECK_IDS].sort());
    const registered = { ...paymentCodes, ...egressCodes };
    for (const code of Object.values(CHECK_EXPECTED_CODES))
      expect(Object.hasOwn(registered, code), code).toBe(true);
  });

  it("keeps every lab route under the lab prefix", () => {
    const paths = [LAB_PATHS.sell, LAB_PATHS.greedy, ...Object.values(LAB_PATHS.offers)];
    for (const path of paths) expect(path.startsWith(LAB_PREFIX), path).toBe(true);
    expect(sellPath("São Paulo/x")).toBe("/lab/sell/forecast/S%C3%A3o%20Paulo%2Fx");
  });

  it("states prices in whole units and in 7-decimal base units consistently", () => {
    for (const price of Object.values(LAB_PRICES)) {
      expect(BigInt(price.atomic)).toBe(BigInt(Math.round(Number(price.decimal) * 10_000_000)));
    }
    expect(BigInt(LAB_PRICES.greedyCharge.atomic)).toBe(2n * BigInt(LAB_PRICES.greedyCap.atomic));
    expect(Number(DEFAULT_CAPS.lowCap)).toBeLessThan(0.001);
    expect(Number(DEFAULT_CAPS.perCall)).toBeLessThanOrEqual(Number(DEFAULT_CAPS.perCallCeiling));
  });

  it("has unique step ids and prefixes idempotency keys", () => {
    expect(new Set(STEP_IDS).size).toBe(STEP_IDS.length);
    expect(runIdempotencyKey("r1")).toBe("pg_r1");
  });
});
