import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { Horizon, type rpc } from "@stellar/stellar-sdk";
import {
  LEDGER_SECONDS_REFRESH_MS,
  RpcLedgerSeconds,
  createStellarFacilitator,
} from "@rail402.dev/facilitator";
import { CONTRACT, LEDGER, NETWORK, payment, requirements, sponsor } from "./upto-helpers.ts";

/** A getTransaction answer for a hash the network does not know, carrying the RPC's ledger window. */
function window(oldest: number, latest: number, secondsPerLedger: number) {
  return {
    status: "NOT_FOUND",
    txHash: "0".repeat(64),
    oldestLedger: oldest,
    latestLedger: latest,
    oldestLedgerCloseTime: String(1_700_000_000),
    latestLedgerCloseTime: String(1_700_000_000 + (latest - oldest) * secondsPerLedger),
  } as unknown as rpc.Api.GetTransactionResponse;
}

describe("the ledger close time from the network's RPC", () => {
  it("averages the ledgers the RPC retains, reading it once per refresh for every caller", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const getTransaction = vi.fn(() => Promise.resolve(window(1_000, 121_000, 5.02)));
      const estimate = new RpcLedgerSeconds({ getTransaction });
      const readings = await Promise.all(Array.from({ length: 50 }, () => estimate.seconds()));
      expect(new Set(readings)).toEqual(new Set([5.02]));
      expect(await estimate.seconds()).toBeCloseTo(5.02);
      expect(getTransaction).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(LEDGER_SECONDS_REFRESH_MS);
      getTransaction.mockResolvedValue(window(1_000, 121_000, 1));
      expect(await estimate.seconds()).toBe(1);
      expect(getTransaction).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the last estimate when the RPC fails, and assumes 5 s before the first", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const getTransaction = vi.fn((): Promise<rpc.Api.GetTransactionResponse> =>
        Promise.reject(new Error("rpc down")),
      );
      const estimate = new RpcLedgerSeconds({ getTransaction });
      expect(await estimate.seconds()).toBe(5);

      vi.advanceTimersByTime(LEDGER_SECONDS_REFRESH_MS);
      getTransaction.mockResolvedValue(window(1_000, 2_000, 6));
      expect(await estimate.seconds()).toBe(6);

      vi.advanceTimersByTime(LEDGER_SECONDS_REFRESH_MS);
      getTransaction.mockRejectedValue(new Error("rpc down"));
      expect(await estimate.seconds()).toBe(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not estimate from a window of a few ledgers", async () => {
    const estimate = new RpcLedgerSeconds({
      getTransaction: () => Promise.resolve(window(1_000, 1_005, 1)),
    });
    expect(await estimate.seconds()).toBe(5);
  });
});

describe("an in-process upto facilitator", () => {
  it("reads the ledger close time from its own RPC, never from Horizon", async () => {
    const horizon = vi.spyOn(Horizon.Server.prototype, "ledgers");
    const methods: string[] = [];
    const rpcServer = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString()));
      request.on("end", () => {
        const { id, method } = JSON.parse(body) as { id: number; method: string };
        methods.push(method);
        const result =
          method === "getLatestLedger"
            ? { id: "x", sequence: LEDGER, protocolVersion: 23 }
            : method === "getTransaction"
              ? window(1, LEDGER, 5)
              : undefined;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify(
            result === undefined
              ? { jsonrpc: "2.0", id, error: { code: -32601, message: "not served here" } }
              : { jsonrpc: "2.0", id, result },
          ),
        );
      });
    });
    await new Promise<void>((listening) => rpcServer.listen(0, "127.0.0.1", listening));
    try {
      const { port } = rpcServer.address() as AddressInfo;
      const facilitator = createStellarFacilitator({
        networks: [
          {
            network: NETWORK,
            rpcUrl: `http://127.0.0.1:${port}/`,
            sponsorSecret: sponsor.secret(),
            channelCount: 1,
            upto: { contract: CONTRACT, contractWasmHash: "ab".repeat(32) },
          },
        ],
      });
      await facilitator.core.verify(payment(), requirements());
      await facilitator.core.verify(payment(), requirements());
      expect(horizon).not.toHaveBeenCalled();
      // One estimate from the RPC's retained window serves both requests.
      expect(methods.filter((method) => method === "getTransaction")).toHaveLength(1);
    } finally {
      horizon.mockRestore();
      await new Promise((closed) => rpcServer.close(closed));
    }
  });
});
