/**
 * The byte helpers on the buyer's path give Node's results with the npm `buffer` package too, which
 * browser bundles use in place of Node's Buffer and which has no `base64url` encoding.
 */
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { paymentIdentifier } from "@rail402.dev/sdk";
import {
  base64ToBase64Url,
  concatBytes,
  fromBase64,
  fromUtf8,
  toBase64,
  toBase64Url,
  toHex,
  utf8Decode,
  utf8Length,
} from "../src/bytes.ts";

// The npm package, not Node's built-in module that the bare name `buffer` resolves to in Node.
const { Buffer: NpmBuffer } = createRequire(import.meta.url)("buffer/index.js") as {
  Buffer: typeof Buffer;
};

describe("byte helpers", () => {
  it("documents why: the npm Buffer has no base64url encoding", () => {
    expect(() => NpmBuffer.from("x").toString("base64url")).toThrow(/base64url/);
  });

  it("encode as Node does, for Node and npm buffers and plain arrays alike", () => {
    for (let round = 0; round < 50; round++) {
      const bytes = randomBytes(round);
      for (const input of [bytes, NpmBuffer.from(bytes), new Uint8Array(bytes)]) {
        expect(toBase64(input)).toBe(bytes.toString("base64"));
        expect(toBase64Url(input)).toBe(bytes.toString("base64url"));
        expect(toHex(input)).toBe(bytes.toString("hex"));
      }
      expect(base64ToBase64Url(bytes.toString("base64"))).toBe(bytes.toString("base64url"));
    }
  });

  it("respect views into a larger buffer", () => {
    const whole = Uint8Array.from([1, 2, 3, 4, 5, 6]);
    const view = whole.subarray(2, 5);
    expect(toHex(view)).toBe("030405");
    expect(toBase64(view)).toBe(Buffer.from([3, 4, 5]).toString("base64"));
  });

  it("count, join and decode UTF-8", () => {
    for (const text of ["", "plain", "çğüşöı", "€ and 𝄞", "lone \ud800 surrogate"]) {
      expect(utf8Length(text)).toBe(Buffer.byteLength(text, "utf8"));
      expect(utf8Decode(fromUtf8(text))).toBe(Buffer.from(text, "utf8").toString("utf8"));
    }
    const joined = concatBytes([Uint8Array.from([1]), new Uint8Array(), Uint8Array.from([2, 3])]);
    expect([...joined]).toEqual([1, 2, 3]);
    expect(concatBytes([]).byteLength).toBe(0);
    expect(toHex(fromBase64("AQID"))).toBe("010203");
  });
});

describe("paymentIdentifier", () => {
  it("is unchanged: SHA-256 of window and key, base64url, 32 characters", () => {
    expect(paymentIdentifier("window-1", "order_12345678")).toBe("rail402_QbqP6lQxkEkcKMt5psdKUOw3n2QxI74z");
    for (let round = 0; round < 20; round++) {
      const window = crypto.randomUUID();
      const key = randomBytes(12).toString("hex");
      const node = createHash("sha256").update(`${window}:${key}`).digest("base64url").slice(0, 32);
      expect(paymentIdentifier(window, key)).toBe(`rail402_${node}`);
    }
  });
});
