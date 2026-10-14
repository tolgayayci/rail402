import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { getEstimatedLedgerCloseTimeSeconds } from "@x402/stellar";
import { pinHorizon, type HorizonPin } from "@rail402.dev/testkit";

describe("Horizon ledger-time pin", () => {
  let pin: HorizonPin | undefined;

  afterEach(() => {
    pin?.restore();
    pin = undefined;
  });

  it("pins upstream's estimate on both public networks", async () => {
    pin = pinHorizon({ seconds: 5 });
    expect(await getEstimatedLedgerCloseTimeSeconds("stellar:testnet")).toBe(5);
    expect(await getEstimatedLedgerCloseTimeSeconds("stellar:pubnet")).toBe(5);
    pin.set({ seconds: 7 });
    expect(await getEstimatedLedgerCloseTimeSeconds("stellar:testnet")).toBe(7);
    expect(pin.requests).toBe(3);
  });

  it("makes upstream fall back to 5 seconds when Horizon fails", async () => {
    pin = pinHorizon({ seconds: 9 });
    expect(await getEstimatedLedgerCloseTimeSeconds("stellar:testnet")).toBe(9);
    pin.set({ status: 500 });
    expect(await getEstimatedLedgerCloseTimeSeconds("stellar:testnet")).toBe(5);
  });

  it("passes every other origin through and restores fetch", async () => {
    const original = globalThis.fetch;
    const server: Server = createServer((_request, response) => response.end("real"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      pin = pinHorizon();
      expect(globalThis.fetch).not.toBe(original);
      expect(await (await fetch(`http://127.0.0.1:${String(port)}/`)).text()).toBe("real");
      expect(pin.requests).toBe(0);
      pin.restore();
      expect(globalThis.fetch).toBe(original);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
