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

  it("keeps a top-level transaction hash visible", () => {
    const { lines, log } = capture();
    log.info({ transaction: "82844c5c" }, "settlement finished");
    expect(lines[0]?.["transaction"]).toBe("82844c5c");
  });
});
