import { describe, expect, it } from "vitest";
import { defineCodes, mergeCodes } from "@rail402.dev/errors";
import { uptoCodes, uptoStandardCodes, uptoStellarCodes } from "@rail402.dev/upto";

describe("upto codes", () => {
  it("register in the service code registry as they are", () => {
    const standard = defineCodes(uptoStandardCodes);
    const specific = defineCodes(uptoStellarCodes);
    expect(Object.keys(mergeCodes(standard, specific))).toEqual(Object.keys(uptoCodes));
  });
});
