import { describe, expect, it } from "vitest";
import {
  FLOW_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MIN_PAGE_SIZE,
  pageCount,
  pageOf,
  pageRange,
  rowsThatFit,
} from "../../src/app/bazaar/pages.ts";

describe("Bazaar pages", () => {
  it("fits as many rows as the list's height holds, within the limits", () => {
    expect(rowsThatFit(57 * 7 + 10, 57)).toBe(7);
    expect(rowsThatFit(100, 57)).toBe(MIN_PAGE_SIZE);
    expect(rowsThatFit(57 * 60, 57)).toBe(MAX_PAGE_SIZE);
    expect(rowsThatFit(0, 57)).toBe(MIN_PAGE_SIZE);
    expect(rowsThatFit(500, 0)).toBe(MIN_PAGE_SIZE);
    expect(FLOW_PAGE_SIZE).toBeGreaterThanOrEqual(MIN_PAGE_SIZE);
  });

  it("counts pages so that every listing is on one", () => {
    expect(pageCount(0, 7)).toBe(1);
    expect(pageCount(7, 7)).toBe(1);
    expect(pageCount(8, 7)).toBe(2);
    expect(pageCount(15, 7)).toBe(3);
    for (let count = 1; count < 40; count += 1) {
      const last = pageCount(count, 6) - 1;
      expect(pageRange(last, 6, count).to).toBe(count);
      expect(pageOf(count - 1, 6)).toBe(last);
    }
  });

  it("names the range a page shows", () => {
    expect(pageRange(0, 7, 12)).toEqual({ from: 1, to: 7 });
    expect(pageRange(1, 7, 12)).toEqual({ from: 8, to: 12 });
    expect(pageRange(0, 7, 0)).toEqual({ from: 0, to: 0 });
    expect(pageOf(-1, 7)).toBe(0);
    expect(pageOf(13, 7)).toBe(1);
  });
});
