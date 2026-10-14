import { describe, expect, it } from "vitest";
import { UNPAID_TIMEOUT_MAXIMA, timeoutsFor } from "../src/relay/relay.ts";
import { BodyDeadlineError, readBody, trackBody, type BodyEnd } from "../src/relay/wire.ts";

describe("relay bodies", () => {
  it("reports a request body whose read fails as aborted, not as an error", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("connection reset"));
      },
    });
    const request = new Request("http://relay.test/", {
      method: "POST",
      body,
      duplex: "half",
    });
    expect(await readBody(request, 1_024)).toEqual({ ok: false, reason: "aborted" });
  });

  it("ends a body nobody reads at its deadline and cancels the seller's stream", async () => {
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
      cancel() {
        cancelled = true;
      },
    });
    const ends: BodyEnd[] = [];
    const tracked = trackBody(
      source,
      () => undefined,
      (end) => ends.push(end),
      50,
    );
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ kind: "error" });
    expect((ends[0] as { error: unknown }).error).toBeInstanceOf(BodyDeadlineError);
    expect(cancelled).toBe(true);
    await expect(tracked.getReader().read()).rejects.toBeInstanceOf(BodyDeadlineError);
  });

  it("does not cut a body that ended before its deadline", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    const ends: BodyEnd[] = [];
    const tracked = trackBody(
      source,
      () => undefined,
      (end) => ends.push(end),
      50,
    );
    expect(await new Response(tracked).arrayBuffer()).toHaveProperty("byteLength", 1);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(ends).toEqual([{ kind: "complete" }]);
  });
});

describe("relay timeouts", () => {
  const options = { isPaid: false, isStream: false, streamMaxMs: 180_000 };

  it("holds an unpaid request to the SDK's probe timeouts", () => {
    expect(timeoutsFor({ headersMs: 120_000, idleMs: 120_000, totalMs: 150_000 }, options)).toEqual(
      UNPAID_TIMEOUT_MAXIMA,
    );
    expect(timeoutsFor(undefined, options)).toEqual(UNPAID_TIMEOUT_MAXIMA);
    expect(timeoutsFor({ headersMs: 200 }, options).headersMs).toBe(200);
  });

  it("lets a paid request or a stream wait longer, a stream at most its maximum", () => {
    expect(timeoutsFor({ headersMs: 120_000, totalMs: 150_000 }, { ...options, isPaid: true })).toEqual({
      headersMs: 120_000,
      totalMs: 150_000,
    });
    expect(timeoutsFor({ idleMs: 120_000 }, { ...options, isStream: true })).toEqual({
      idleMs: 120_000,
      totalMs: 180_000,
    });
  });
});
