import { describe, it, expect } from "vitest";
import { Asset, Keypair } from "@stellar/stellar-sdk";
import { X402Error } from "@x402-stellar/errors";
import { assetCodeFor } from "./discovery-loop.js";
import { decodeExtensionResponses } from "./payment.js";
import { CanaryRun, toPayload } from "./report.js";

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64");

describe("EXTENSION-RESPONSES decoding", () => {
  it("reads the cataloging verdict a seller would see", () => {
    const header = encode({ bazaar: { status: "success" } });
    expect(decodeExtensionResponses(header)).toEqual({ status: "success" });
  });

  it("preserves a rejection's code and reason", () => {
    const header = encode({
      bazaar: {
        status: "rejected",
        rejectedReason: "Resource URL must be http(s).",
        code: "bazaar_invalid_resource_url",
      },
    });
    expect(decodeExtensionResponses(header)).toMatchObject({
      status: "rejected",
      code: "bazaar_invalid_resource_url",
    });
  });

  // Every one of these is a header that "looks present" — the canary must treat them as an absent
  // verdict rather than throwing, so the failure is reported as the missing verdict it is.
  it.each([
    ["absent", null],
    ["empty", ""],
    ["not base64 JSON", "%%%not-base64%%%"],
    ["JSON without a bazaar key", encode({ other: { status: "success" } })],
    ["bazaar that is not an object", encode({ bazaar: "success" })],
    ["bazaar without a status", encode({ bazaar: { rejectedReason: "why" } })],
    ["a bare JSON string", Buffer.from('"success"', "utf8").toString("base64")],
  ])("returns undefined for a header that is %s", (_label, header) => {
    expect(decodeExtensionResponses(header)).toBeUndefined();
  });
});

describe("asset codes derived from a run id", () => {
  it.each([
    "20260731120000",
    "nightly",
    "pr-1234",
    "a",
    "!!!",
    "1234567890123456789012345678901234567890",
  ])("produces a code the Stellar SDK accepts for run id %s", runId => {
    const code = assetCodeFor(runId);
    expect(code.length).toBeLessThanOrEqual(12);
    // The SDK is the authority here: an invalid code throws, and it would throw at fixture setup
    // pointing at the asset rather than at the run id that actually caused it.
    expect(() => new Asset(code, Keypair.random().publicKey())).not.toThrow();
  });
});

describe("a canary run always reports why it failed", () => {
  const silent = () => {};

  it("records passing steps with their detail and timing", async () => {
    const run = new CanaryRun("unit", "stellar:testnet", "http://localhost", silent);
    await run.step("first", async () => ({ detail: "did a thing" }));
    run.observe("thing", 1);

    const report = run.finish();
    expect(report.status).toBe("pass");
    expect(report.failure).toBeNull();
    expect(report.steps).toHaveLength(1);
    expect(report.steps[0]).toMatchObject({ name: "first", ok: true, detail: "did a thing" });
    expect(report.observations).toEqual({ thing: 1 });
  });

  it("carries the step's own code and reason into the report", async () => {
    const run = new CanaryRun("unit", "stellar:testnet", "http://localhost", silent);
    const thrown = new X402Error("canary_resource_not_indexed", { reason: "never showed up" });

    await expect(
      run.step("indexed", async () => {
        throw thrown;
      }),
    ).rejects.toThrow(thrown);

    const report = run.finish(thrown);
    expect(report.status).toBe("fail");
    expect(report.failure).toMatchObject({
      code: "canary_resource_not_indexed",
      reason: "never showed up",
    });
    expect(report.steps[0]).toMatchObject({ name: "indexed", ok: false, detail: "never showed up" });
  });

  // The canary polices "a non-null reason on every rejection"; it must not violate that itself when
  // something unclassified (a TypeError, a socket hang-up) escapes.
  it.each([
    ["an Error with a message", new Error("connect ECONNREFUSED")],
    ["an Error with no message", new Error()],
    ["a thrown string", "something went wrong"],
    ["a thrown empty string", ""],
    ["null", null],
    ["an object", { nope: true }],
  ])("gives a code and a non-empty reason for %s", (_label, thrown) => {
    const payload = toPayload(thrown);
    expect(payload.code).toBeTruthy();
    expect(payload.reason.trim().length).toBeGreaterThan(0);
  });
});
