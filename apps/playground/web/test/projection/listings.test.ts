import { describe, expect, it } from "vitest";
import {
  callParams,
  callUrl,
  filterCounts,
  initialValues,
  listingCall,
  listingPrice,
  listingTitle,
  priceAboveCap,
  priceWords,
  resultHeadline,
} from "../../src/projection/listings.ts";
import { ALL_LISTINGS, LISTINGS } from "../fixtures/bazaar.ts";
import { field } from "../fixtures/views.ts";

describe("bazaar listings", () => {
  it("counts each filter over the listings it is given", () => {
    expect(filterCounts(ALL_LISTINGS)).toEqual({ all: 6, http: 4, mcp: 2, exact: 4, upto: 2, verified: 6 });
    expect(filterCounts([])).toEqual({ all: 0, http: 0, mcp: 0, exact: 0, upto: 0, verified: 0 });
  });

  it("names a tool by its tool name and an API by its description", () => {
    expect(listingTitle(LISTINGS.airQuality)).toBe("air_quality");
    expect(listingTitle(LISTINGS.weather)).toBe("Current weather for a city");
    expect(listingCall(LISTINGS.airQuality)).toBe("MCP tool air_quality · demo.rail402.dev/mcp");
    expect(listingCall(LISTINGS.translate)).toBe("POST demo.rail402.dev/translate");
  });

  it("says a price in words and compares it with the cap", () => {
    const upto = listingPrice(LISTINGS.history, "USDC");
    expect(priceWords(upto)).toBe("up to 0.01 USDC per call");
    expect(priceWords(listingPrice(LISTINGS.weather, "USDC"))).toBe("0.001 USDC per call");
    expect(priceAboveCap(upto, "0.005", 7)).toBe(true);
    expect(priceAboveCap(upto, "0.01", 7)).toBe(false);
    expect(priceAboveCap(null, "0.01", 7)).toBe(false);
  });

  it("types the form's values as the schema declares, leaving out empty optional fields", () => {
    const fields = [
      field({ name: "city", in: "argument", required: true, example: "Izmir" }),
      field({ name: "hours", in: "argument", kind: "integer", required: true, example: "6" }),
      field({ name: "detailed", in: "argument", kind: "boolean" }),
      field({ name: "note", in: "argument" }),
    ];
    const values = initialValues(fields);
    expect(values).toEqual({ city: "Izmir", hours: "6", detailed: "", note: "" });
    expect(callParams(fields, { ...values, detailed: "true" })).toEqual({
      ok: true,
      params: { city: "Izmir", hours: 6, detailed: true },
    });
    expect(callParams(fields, { ...values, hours: "1.5" })).toMatchObject({ ok: false, field: "hours" });
    expect(callParams(fields, { ...values, city: " " })).toMatchObject({ ok: false, field: "city" });
  });

  it("builds the URL an HTTP call reaches, and refuses a path value that walks the path", () => {
    expect(callUrl(LISTINGS.history, { city: "Ankara", days: "3" })).toBe(
      "https://demo.rail402.dev/history?city=Ankara&days=3",
    );
    expect(callUrl(LISTINGS.sample, { city: "New York" })).toBe(
      "https://playground.rail402.dev/lab/sell/forecast/New%20York",
    );
    expect(callUrl(LISTINGS.sample, { city: ".." })).toBeUndefined();
    expect(callUrl(LISTINGS.sample, {})).toBeUndefined();
    expect(callUrl(LISTINGS.airQuality, { city: "Izmir" })).toBeUndefined();
  });

  it("finds a headline reading in a result, and none in other results", () => {
    expect(
      resultHeadline([
        { label: "city", value: "Ankara" },
        { label: "conditions", value: "sunny" },
        { label: "temperature", value: "21" },
      ]),
    ).toEqual({
      value: "21°",
      caption: "sunny · Ankara",
      conditions: "sunny",
      used: ["temperature", "conditions", "city"],
    });
    expect(
      resultHeadline([
        { label: "aqi", value: "42" },
        { label: "category", value: "good" },
      ]),
    ).toMatchObject({
      value: "AQI 42",
      caption: "good",
      used: ["aqi", "category"],
    });
    expect(resultHeadline([{ label: "text", value: "Merhaba" }])).toBeNull();
  });
});
