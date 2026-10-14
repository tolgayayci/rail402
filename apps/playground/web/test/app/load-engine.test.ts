import { afterEach, describe, expect, it, vi } from "vitest";
import { loadEngine } from "../../src/app/load-engine.ts";

describe("loading the engine", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the configuration once for concurrent callers, and again after a failure", async () => {
    const send = vi.fn(() => Promise.resolve(new Response("{}", { status: 503 })));
    vi.stubGlobal("fetch", send);
    const first = loadEngine();
    expect(loadEngine()).toBe(first);
    await expect(first).rejects.toMatchObject({ code: "playground_config_unavailable" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(String((send.mock.calls[0] as unknown[])[0])).toBe(`${window.location.origin}/api/config`);

    const second = loadEngine();
    expect(second).not.toBe(first);
    await expect(second).rejects.toMatchObject({ code: "playground_config_unavailable" });
    expect(send).toHaveBeenCalledTimes(2);
  });
});
