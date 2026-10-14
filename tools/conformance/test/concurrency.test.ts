import { describe, expect, it } from "vitest";
import { histogramQuantile, isRepeat, parseExposition } from "../src/concurrency-run.ts";

describe("metrics helpers", () => {
  it("parses an exposition and takes a histogram quantile between scrapes", () => {
    const before = parseExposition(
      [
        "# HELP h x",
        'h_bucket{network="n",le="0.1"} 1',
        'h_bucket{network="n",le="1"} 1',
        'h_bucket{network="n",le="+Inf"} 1',
      ].join("\n"),
    );
    const after = parseExposition(
      [
        'h_bucket{network="n",le="0.1"} 10',
        'h_bucket{network="n",le="1"} 20',
        'h_bucket{network="n",le="+Inf"} 21',
      ].join("\n"),
    );
    expect(after[0]).toEqual({ name: "h_bucket", labels: { network: "n", le: "0.1" }, value: 10 });
    // 20 observations between the scrapes: 9 ≤ 0.1 s, 19 ≤ 1 s, 20 in all; the 95th is the 19th.
    expect(histogramQuantile([before], [after], "h", 0.95)).toBe(1);
    expect(histogramQuantile([before], [after], "h", 0.99)).toBe("+Inf");
    expect(histogramQuantile([after], [after], "h", 0.95)).toBe(0);
  });

  it("reads the repeat marker from EXTENSION-RESPONSES", () => {
    const header = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
    expect(isRepeat(header({ rail402: { settlement: { repeat: true, settledBy: "rail402" } } }))).toBe(true);
    expect(isRepeat(header({ bazaar: { status: "success" } }))).toBe(false);
    expect(isRepeat(null)).toBe(false);
    expect(isRepeat("not base64 json")).toBe(false);
  });
});
