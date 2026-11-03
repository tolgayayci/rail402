import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { destination as fileDestination } from "pino";
import { describe, expect, it } from "vitest";
import { afterLogsWritten, createLogger } from "../src/logger.ts";

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

  it("redacts X-API-Key and Authorization headers", () => {
    const { lines, log } = capture();
    log.info(
      { req: { headers: { "x-api-key": "r402_acme_SECRETKEY", authorization: "Bearer r402_acme_OTHER" } } },
      "request",
    );
    log.info(
      { request: { headers: { "x-api-key": "r402_acme_NESTED", authorization: "Bearer NESTED2" } } },
      "nested",
    );
    expect(JSON.stringify(lines)).not.toMatch(/SECRETKEY|OTHER|NESTED/);
    expect(lines[0]?.["req"]).toEqual({
      headers: { "x-api-key": "[redacted]", authorization: "[redacted]" },
    });
  });

  it("keeps a top-level transaction hash visible", () => {
    const { lines, log } = capture();
    log.info({ transaction: "82844c5c" }, "settlement finished");
    expect(lines[0]?.["transaction"]).toBe("82844c5c");
  });
});

describe("afterLogsWritten", () => {
  it("calls back once every line logged so far has been written out, in order", async () => {
    const directory = mkdtempSync(join(tmpdir(), "rail402-log-"));
    try {
      const file = join(directory, "out.log");
      const destination = fileDestination({ dest: file, sync: false });
      await new Promise((resolve) => destination.once("ready", resolve));
      const log = createLogger({ level: "info", version: "test" }, destination);
      for (let i = 0; i < 200; i++) log.info({ i }, "line");
      log.info({}, "last");
      const started = performance.now();
      await new Promise<void>((resolve) => {
        afterLogsWritten(log, resolve);
      });
      // The destination drained: no need to wait for the fallback.
      expect(performance.now() - started).toBeLessThan(900);
      const messages = readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => (JSON.parse(line) as { msg: string; i?: number }).i ?? "last");
      expect(messages).toEqual([...Array.from({ length: 200 }, (_, i) => i), "last"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
