import { describe, expect, it } from "vitest";
import {
  refusalFor,
  refusalTarget,
  refusalsAfterSigning,
  refusalsBeforeSigning,
} from "../../src/app/lab/refusals.ts";
import {
  defaultTarget,
  defaultTargetText,
  labRequest,
  normalizeTarget,
  sellerLaneFor,
} from "../../src/projection/targets.ts";
import { CHECK_IDS } from "../../../src/shared/lab.ts";
import { CONFIG } from "../fixtures/config.ts";
import { URLS } from "../fixtures/ids.ts";

describe("what the Lab pays", () => {
  it("starts each mode on the demo seller's route", () => {
    expect(defaultTarget("exact", CONFIG)).toBe(`${URLS.demoSeller}/weather?city=Ankara`);
    expect(defaultTargetText("upto", CONFIG)).toBe("demo.rail402.dev/history?city=Berlin&days=7");
  });

  it("keeps the scheme of a local http demo seller, so the field pays exactly that URL", () => {
    const local = { ...CONFIG, urls: { ...CONFIG.urls, demoSeller: "http://127.0.0.1:4021" } };
    const text = defaultTargetText("exact", local);
    expect(text).toBe("http://127.0.0.1:4021/weather?city=Ankara");
    expect(normalizeTarget(text)).toBe(defaultTarget("exact", local));
  });

  it("reads a typed URL as https unless it says otherwise, and refuses anything else", () => {
    expect(normalizeTarget("demo.rail402.dev/weather?city=Izmir")).toBe(
      "https://demo.rail402.dev/weather?city=Izmir",
    );
    expect(normalizeTarget(" http://localhost:4021/paid ")).toBe("http://localhost:4021/paid");
    expect(normalizeTarget("")).toBeUndefined();
    expect(normalizeTarget("ftp://example.org/file")).toBeUndefined();
    expect(normalizeTarget("javascript:alert(1)")).toBeUndefined();
    expect(normalizeTarget("https://user:secret@example.org/")).toBeUndefined();
  });

  it("runs the demo seller's own routes as the lab scenario, with the URL's parameters", () => {
    expect(labRequest("exact", "https://demo.rail402.dev/weather?city=Izmir", "0.01", CONFIG)).toEqual({
      kind: "scenario",
      request: { scenario: "pay", experiment: "normal", cap: "0.01", params: { city: "Izmir" } },
    });
    expect(labRequest("upto", "https://demo.rail402.dev/history?city=Rome&days=2", "0.02", CONFIG)).toEqual({
      kind: "scenario",
      request: { scenario: "upto", experiment: "normal", cap: "0.02", params: { city: "Rome", days: "2" } },
    });
  });

  it("pays any other URL exactly as typed", () => {
    for (const url of [
      // Another seller.
      "https://api.example.org/weather?city=Izmir",
      // A parameter the scenario does not know would be dropped: pay the URL as typed instead.
      "https://demo.rail402.dev/weather?city=Izmir&units=metric",
      // The same name twice.
      "https://demo.rail402.dev/weather?city=Izmir&city=Rome",
      // The upto route from the exact tile.
      "https://demo.rail402.dev/history?city=Rome",
    ]) {
      expect(labRequest("exact", url, "0.01", CONFIG)).toEqual({
        kind: "pay",
        request: { target: url, cap: "0.01" },
      });
    }
  });

  it("names the seller's lane after the route it serves", () => {
    expect(sellerLaneFor(`${URLS.demoSeller}/history?days=2`, CONFIG)).toEqual({
      label: "History API",
      role: "demo seller",
      ours: true,
    });
    expect(sellerLaneFor(`${URLS.public}${CONFIG.lab.paths.greedy}`, CONFIG).label).toBe("Greedy API");
    expect(sellerLaneFor("https://api.example.org/x", CONFIG)).toEqual({
      label: "API",
      role: "api.example.org",
      ours: false,
    });
  });
});

describe("refusals to try", () => {
  it("offers every check this Playground runs, then the refusals after signing", () => {
    expect(
      refusalsBeforeSigning(CONFIG)
        .map((entry) => entry.key)
        .sort(),
    ).toEqual([...CHECK_IDS].sort());
    expect(refusalsAfterSigning(CONFIG).map((entry) => entry.key)).toEqual(["replay", "overcharge"]);
    const off = {
      ...CONFIG,
      lab: { ...CONFIG.lab, checks: ["network" as const], experiments: ["normal" as const] },
    };
    expect(refusalsBeforeSigning(off).map((entry) => entry.key)).toEqual(["network"]);
    expect(refusalsAfterSigning(off)).toEqual([]);
    expect(refusalFor("asset", off)).toBeUndefined();
  });

  it("shows what each refusal calls", () => {
    const entry = (key: string) => {
      const found = refusalFor(key, CONFIG);
      if (found === undefined) throw new Error(`no refusal ${key}`);
      return found;
    };
    expect(refusalTarget(entry("network"), CONFIG).url).toBe(
      `${URLS.public}${CONFIG.lab.paths.offers.pubnet}`,
    );
    expect(refusalTarget(entry("per-call-cap"), CONFIG).text).toBe("demo.rail402.dev/weather?city=Ankara");
    expect(refusalTarget(entry("private-address"), CONFIG)).toEqual({
      text: "127.0.0.1/ · 169.254.169.254/",
    });
    expect(refusalTarget(entry("overcharge"), CONFIG).url).toContain(CONFIG.lab.paths.greedy);
  });
});
