import { describe, expect, it } from "vitest";
import { publicReason } from "../src/public-reason.ts";

describe("publicReason", () => {
  it("names the kind of a failure without its text", () => {
    expect(publicReason(new Error("connect ECONNREFUSED 10.0.3.7:5432"))).toBe(
      "connection refused (details in the service log)",
    );
    expect(publicReason("getaddrinfo ENOTFOUND rpc.internal.example")).toBe(
      "host not found (details in the service log)",
    );
    expect(publicReason(new Error("Request failed with status code 503"))).toBe(
      "HTTP 503 (details in the service log)",
    );
    expect(publicReason(new Error("timeout of 30000ms exceeded"))).toBe(
      "timed out (details in the service log)",
    );
  });

  it("never repeats an unrecognised message", () => {
    const reason = publicReason(new Error('password authentication failed for user "rail402_prod"'));
    expect(reason).toBe("failed (details in the service log)");
    expect(publicReason("HostError: Error(Contract, #13) diagnostic events: [...]")).not.toContain(
      "HostError",
    );
  });
});
