/**
 * A network whose ledgers this SDK cannot decode, as after a protocol upgrade that brings new XDR, is
 * reported: the network poll decodes a ledger header whenever the protocol version changes, so /ready answers 503 with the RPC check
 * failed and /health shows it, before payments fail one by one with an unexpected error.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalNetwork, startRpcProxy, type IssuedAsset, type RpcProxy } from "@rail402.dev/testkit";
import { startService, type RunningService } from "./service-harness.ts";

const net = new LocalNetwork();
const available = await net.available();
const NETWORK = "stellar:testnet";

async function until(done: () => boolean, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("condition not met");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe.skipIf(!available)("a network on a protocol this SDK cannot read", () => {
  let usdc: IssuedAsset;
  let proxy: RpcProxy;
  let service: RunningService;

  beforeAll(async () => {
    usdc = await net.issueAsset("USDC");
    proxy = await startRpcProxy(net.rpcUrl);
    service = await startService(net, usdc, { TESTNET_RPC_URL: proxy.url, SEARCH_EMBEDDINGS: "false" });
    await until(() => service.runtime.networkReadiness(NETWORK)?.ready === true);
  }, 120_000);

  afterAll(async () => {
    await service.stop();
    await proxy.close().catch(() => undefined);
  });

  it("fails readiness while the newest ledger header cannot be decoded, and passes again after", async () => {
    // The network's own answer with a header this SDK cannot read, as protocol 30's were to 16.3.0.
    const answer = (await (
      await fetch(net.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestLedger" }),
      })
    ).json()) as { result: Record<string, unknown> };
    const unreadable = {
      ...answer.result,
      headerXdr: Buffer.from(new Uint8Array(200).fill(0xff)).toString("base64"),
    };
    const network = (await (
      await fetch(net.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getNetwork" }),
      })
    ).json()) as { result: { protocolVersion: number } };
    const upgraded = { ...network.result, protocolVersion: network.result.protocolVersion + 1 };
    const decodes = () => proxy.statuses.get("getLatestLedger")?.get("RESULT_INJECTED") ?? 0;
    proxy.answerResult("getLatestLedger", () => unreadable);
    // The same protocol is not decoded again, however many polls pass.
    await new Promise((resolve) => setTimeout(resolve, 20_000));
    expect(decodes()).toBe(0);
    proxy.answerResult("getNetwork", () => upgraded);
    await until(() => service.runtime.networkReadiness(NETWORK)?.checks["rpc"]?.ok === false, 60_000);
    expect(service.runtime.networkReadiness(NETWORK)?.ready).toBe(false);
    expect((await service.runtime.readiness()).ready).toBe(false);
    await until(() => service.runtime.health().networks[NETWORK]?.rpc.ok === false, 60_000);

    proxy.answerResult("getLatestLedger", undefined);
    proxy.answerResult("getNetwork", undefined);
    await until(() => service.runtime.networkReadiness(NETWORK)?.ready === true, 60_000);
  }, 180_000);
});
