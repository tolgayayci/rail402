import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { startExplorerAnnounce } from "./announce.js";
import { loadConfig } from "./config/env.js";
import { X402Error } from "@rail402/errors";

const silent = { info: () => {}, debug: () => {} };

const baseEnv = {
  FACILITATOR_STELLAR_SECRET: Keypair.random().secret(),
} as NodeJS.ProcessEnv;

describe("announce config", () => {
  it("is ON by default, pointing at the Rail402 explorer", () => {
    const config = loadConfig(baseEnv);
    expect(config.explorerAnnounceUrl).toBe("https://explorer-api.rail402.dev/announce");
    expect(config.publicUrl).toBeUndefined();
  });

  it("EXPLORER_ANNOUNCE_URL empty string disables announcing", () => {
    const config = loadConfig({ ...baseEnv, EXPLORER_ANNOUNCE_URL: "" });
    expect(config.explorerAnnounceUrl).toBeUndefined();
  });

  it("normalizes FACILITATOR_PUBLIC_URL and refuses garbage with a coded reason", () => {
    const config = loadConfig({
      ...baseEnv,
      FACILITATOR_PUBLIC_URL: "https://facilitator.example.org/",
    });
    expect(config.publicUrl).toBe("https://facilitator.example.org");
    expect.assertions(3);
    try {
      loadConfig({ ...baseEnv, FACILITATOR_PUBLIC_URL: "not a url" });
    } catch (error) {
      expect(error).toBeInstanceOf(X402Error);
      expect((error as X402Error).payload.code).toBe("config_invalid_value");
    }
  });
});

describe("startExplorerAnnounce", () => {
  it("POSTs only the public base URL, immediately and on the interval", async () => {
    vi.useFakeTimers();
    const calls: { url: string; body: unknown }[] = [];
    const stop = startExplorerAnnounce({
      config: {
        publicUrl: "https://facilitator.example.org",
        explorerAnnounceUrl: "https://explorer-api.rail402.dev/announce",
      },
      logger: silent,
      fetchImpl: (url, init) => {
        calls.push({ url, body: JSON.parse(String(init?.body)) });
        return Promise.resolve(new Response("{}", { status: 200 }));
      },
      intervalMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://explorer-api.rail402.dev/announce");
    expect(calls[0]!.body).toEqual({ baseUrl: "https://facilitator.example.org" });
    await vi.advanceTimersByTimeAsync(2100);
    expect(calls.length).toBe(3);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls.length).toBe(3);
    vi.useRealTimers();
  });

  it("does nothing without a public URL, and nothing when disabled", async () => {
    let requests = 0;
    const fetchImpl = (): Promise<Response> => {
      requests += 1;
      return Promise.resolve(new Response("{}"));
    };
    startExplorerAnnounce({
      config: { explorerAnnounceUrl: "https://explorer-api.rail402.dev/announce" },
      logger: silent,
      fetchImpl,
    })();
    startExplorerAnnounce({
      config: { publicUrl: "https://facilitator.example.org" },
      logger: silent,
      fetchImpl,
    })();
    await Promise.resolve();
    expect(requests).toBe(0);
  });

  it("swallows announce failures — an explorer outage never propagates", async () => {
    vi.useFakeTimers();
    const stop = startExplorerAnnounce({
      config: {
        publicUrl: "https://facilitator.example.org",
        explorerAnnounceUrl: "https://explorer-api.rail402.dev/announce",
      },
      logger: silent,
      fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")),
      intervalMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(2500);
    stop();
    vi.useRealTimers();
    // Reaching here without an unhandled rejection IS the assertion.
    expect(true).toBe(true);
  });
});
