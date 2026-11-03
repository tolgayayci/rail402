import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { StartupError, describeFailure, startupFailureLines } from "../src/failure.ts";

describe("describeFailure", () => {
  it("describes whatever was thrown in readable words, never [object Object]", () => {
    expect(describeFailure(new Error("socket hang up"))).toBe("socket hang up");
    // What the Stellar SDK throws for a JSON-RPC error answer.
    expect(describeFailure({ code: -32603, message: "captive core is not ready" })).toBe(
      "error -32603: captive core is not ready",
    );
    expect(describeFailure({ status: 503 })).toBe('a non-error value was thrown: {"status":503}');
    expect(describeFailure({})).toBe("a non-error object was thrown");
    expect(describeFailure("overloaded")).toBe("overloaded");
    expect(describeFailure("")).toBe("an empty error message");
    expect(describeFailure(undefined)).toBe("no error value was thrown (undefined)");
    expect(describeFailure(null)).toBe("no error value was thrown (null)");
    expect(describeFailure(42)).toBe("a non-error value was thrown: 42");
    expect(describeFailure(Symbol("x"))).toBe("a symbol was thrown");
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(describeFailure(circular)).toBe("a non-error object was thrown");
    for (const value of [{ code: 1 }, [], new Map(), circular]) {
      expect(describeFailure(value)).not.toContain("[object");
    }
  });

  it("names an Error's cause and its name when the message is empty", () => {
    expect(describeFailure(new Error("fetch failed", { cause: new Error("connect ECONNREFUSED") }))).toBe(
      "fetch failed (cause: connect ECONNREFUSED)",
    );
    expect(describeFailure(new TypeError(""))).toBe("TypeError");
  });

  it("never carries a URL or a secret seed, and stays one bounded line", () => {
    const seed = Keypair.random().secret();
    const text = describeFailure({
      code: 1,
      message: `request to https://user:pass@rpc.example/key/abc?token=x failed\nseed ${seed}`,
    });
    expect(text).toBe("error 1: request to <url> failed seed <secret>");
    expect(describeFailure(new Error(`postgres://rail402:secret@db:5432/rail402 refused`))).toBe(
      "<url> refused",
    );
    expect(describeFailure("x".repeat(1_000))).toHaveLength(300);
  });
});

describe("startupFailureLines", () => {
  it("prints one coded line, then only the stack's code locations", () => {
    const error = new Error("embedding model file /models/x.onnx is missing");
    const lines = startupFailureLines(error).trimEnd().split("\n");
    expect(lines[0]).toBe("rail402: startup_failed: embedding model file /models/x.onnx is missing");
    expect(lines.slice(1).length).toBeGreaterThan(0);
    for (const line of lines.slice(1)) expect(line).toMatch(/^\s+at /);
  });

  it("codes a thrown non-Error the same way", () => {
    expect(startupFailureLines({ code: -32603, message: "busy" })).toBe(
      "rail402: startup_failed: error -32603: busy\n",
    );
    expect(startupFailureLines(undefined)).toBe(
      "rail402: startup_failed: no error value was thrown (undefined)\n",
    );
    expect(new StartupError("x").code).toBe("startup_failed");
  });
});
