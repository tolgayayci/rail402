import { describe, expect, it } from "vitest";
import { MemoryCatalogStore } from "@rail402.dev/bazaar";
import { staleFiles } from "../src/index.ts";
import { interopSuite } from "./suite.ts";

describe("committed interop fixtures", () => {
  it("are exactly what upstream @x402/extensions generates", async () => {
    expect(await staleFiles()).toEqual([]);
  });
});

interopSuite("memory", () => Promise.resolve(new MemoryCatalogStore()));
