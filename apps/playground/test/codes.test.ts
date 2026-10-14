import { describe, expect, it } from "vitest";
import { Rail402Error } from "@rail402.dev/errors";
import {
  isPlaygroundCode,
  playgroundClientCodes,
  playgroundCodes,
  playgroundError,
  playgroundServerCodes,
} from "@rail402.dev/playground/codes";

describe("playground codes", () => {
  it("prefixes every code and gives each a reason", () => {
    for (const [code, spec] of Object.entries(playgroundCodes)) {
      expect(code).toMatch(/^playground_[a-z0-9_]+$/);
      expect(spec.reason.trim(), code).not.toBe("");
    }
  });

  it("splits server and client codes without overlap", () => {
    const server = Object.keys(playgroundServerCodes);
    const client = Object.keys(playgroundClientCodes);
    expect(server.filter((code) => client.includes(code))).toEqual([]);
    expect(Object.keys(playgroundCodes).sort()).toEqual([...server, ...client].sort());
    expect(server).toHaveLength(17);
    expect(client).toHaveLength(7);
  });

  it("raises coded errors with the registered status", () => {
    const error = playgroundError("playground_rate_limited", { details: { retryAfter: 3 } });
    expect(error).toBeInstanceOf(Rail402Error);
    expect(error).toMatchObject({ code: "playground_rate_limited", status: 429, retryable: true });
    expect(isPlaygroundCode("playground_relay_loop")).toBe(true);
    expect(isPlaygroundCode("egress_dns_failed")).toBe(false);
  });
});
