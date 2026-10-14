import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logger.ts";

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      done();
    },
  });
  return { lines, log: createLogger({ level: "info", version: "test" }, stream) };
}

describe("logger", () => {
  it("redacts secret fields at the top level and one level down", () => {
    const { lines, log } = capture();
    const secrets = { sponsorSecret: "SSECRET", secret: "s", envelopeXdr: "AAAA", authorization: "Bearer k" };
    log.info(secrets, "top level");
    log.info({ config: secrets, payload: { transaction: "AAAAsigned" } }, "nested");
    log.info({ req: { headers: { authorization: "Bearer k" } } }, "request");

    const [top, nested, request] = lines;
    for (const field of Object.keys(secrets)) {
      expect(top?.[field], field).toBe("[redacted]");
      expect((nested?.["config"] as Record<string, unknown>)[field], field).toBe("[redacted]");
    }
    expect(nested?.["payload"]).toEqual({ transaction: "[redacted]" });
    expect(request?.["req"]).toEqual({ headers: { authorization: "[redacted]" } });
    expect(JSON.stringify(lines)).not.toMatch(/SSECRET|Bearer k|AAAAsigned/);
  });

  it("logs an HTTP client error without its URL, body or headers", async () => {
    const { lines, log } = capture();
    const { rpc } = await import("@stellar/stellar-sdk");
    // Port 9 refuses at once; the path carries a provider-style key, as a keyed RPC URL does.
    const failure = await new rpc.Server("http://127.0.0.1:9/v1/APIKEY_SECRET_1234567890", {
      allowHttp: true,
    })
      .getHealth()
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(Error);
    log.warn({ err: failure }, "rpc poll failed");
    log.warn({ error: failure }, "under another key");
    const text = JSON.stringify(lines);
    expect(text).not.toContain("APIKEY_SECRET");
    expect(text).not.toContain("getHealth");
    expect((lines[0]?.["err"] as Record<string, unknown>)["message"]).toEqual(expect.any(String));
  });

  it("keeps a top-level transaction hash visible", () => {
    const { lines, log } = capture();
    log.info({ transaction: "82844c5c" }, "settlement finished");
    expect(lines[0]?.["transaction"]).toBe("82844c5c");
  });
});
