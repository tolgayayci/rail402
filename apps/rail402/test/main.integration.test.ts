/**
 * The service process itself (src/main.ts): startup and SIGTERM handling, observed from outside as an
 * operator's supervisor sees them. Needs `docker compose --profile stellar up -d` for the RPC.
 */
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { deriveChannelKeypairs, provisionChannels } from "@rail402.dev/facilitator";
import {
  LocalNetwork,
  ServiceProcess,
  classicTestAsset,
  exactDriver,
  startRpcProxy,
  stopServiceProcesses,
  type IssuedAsset,
  type PaymentDriver,
  type RpcProxy,
} from "@rail402.dev/testkit";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const net = new LocalNetwork();
const available = await net.available();

/** Starts `node src/main.ts` with the in-memory store and no channel provisioning. */
function startMain(env: Record<string, string> = {}): Promise<ServiceProcess> {
  return ServiceProcess.start({
    entry: MAIN,
    env: {
      STORE: "memory",
      TESTNET_RPC_URL: net.rpcUrl,
      TESTNET_SPONSOR_SECRET: Keypair.random().secret(),
      TESTNET_AUTO_PROVISION_CHANNELS: "false",
      TESTNET_UPTO_ENABLED: "false",
      BAZAAR_ENABLED: "false",
      RATE_LIMIT_PER_MINUTE: "0",
      ...env,
    },
  });
}

/** Sends the headers and the first bytes of a request whose body never arrives unless completed. */
function partialRequest(
  port: number,
  body: string,
  sent: number,
): Promise<{ socket: Socket; response: () => string }> {
  return new Promise((resolve) => {
    let response = "";
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        `POST /verify HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n` +
          `Content-Length: ${String(Buffer.byteLength(body))}\r\n\r\n${body.slice(0, sent)}`,
      );
      resolve({ socket, response: () => response });
    });
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("utf8");
    });
    socket.on("error", () => undefined);
  });
}

describe.skipIf(!available)("service process", () => {
  afterEach(stopServiceProcesses);

  const listening = (service: ServiceProcess) =>
    expect.poll(() => service.messages, { timeout: 60_000, interval: 100 }).toContain("rail402 listening");
  /**
   * The lifecycle messages in the order written. Background work (the network poll, reconciliation)
   * may log between them on a busy machine, so only these are compared.
   */
  const LIFECYCLE = [
    "rail402 listening",
    "shutting down",
    "stopped",
    "shutdown grace period elapsed; exiting",
  ];
  const lifecycle = (service: ServiceProcess) =>
    service.messages.filter((message) => LIFECYCLE.includes(message));

  it("stops on SIGTERM: stops listening, finishes, and exits 0", async () => {
    const service = await startMain();
    await listening(service);
    service.process.kill("SIGTERM");
    expect((await service.exited).code).toBe(0);
    expect(lifecycle(service)).toEqual(["rail402 listening", "shutting down", "stopped"]);
  });

  it("drops a request whose body is still arriving, and exits 0 without waiting for it", async () => {
    const service = await startMain({ SHUTDOWN_GRACE_MS: "10000" });
    await listening(service);
    const request = await partialRequest(service.port, JSON.stringify({ x402Version: 2 }), 5);
    await expect.poll(() => request.socket.bytesWritten).toBeGreaterThan(0);

    const signalled = performance.now();
    service.process.kill("SIGTERM");
    const { code, at } = await service.exited;
    expect(code).toBe(0);
    expect(at - signalled).toBeLessThan(5_000);
    expect(request.response()).toBe("");
    expect(lifecycle(service)).toEqual(["rail402 listening", "shutting down", "stopped"]);
  });

  describe("with a settlement in flight", () => {
    let usdc: IssuedAsset;
    let seller: Keypair;
    let sponsor: Keypair;
    let driver: PaymentDriver;
    let proxy: RpcProxy;

    beforeAll(async () => {
      usdc = await net.issueAsset("USDC");
      [seller] = (await net.holders(usdc, 1, "0")) as [Keypair];
      sponsor = Keypair.random();
      await net.fund(sponsor);
      await provisionChannels({
        server: net.server,
        passphrase: net.passphrase,
        sponsor,
        channels: deriveChannelKeypairs(sponsor, "stellar:testnet", 1),
      });
      driver = exactDriver(net, classicTestAsset(net, usdc));
      proxy = await startRpcProxy(net.rpcUrl);
    }, 180_000);

    afterEach(() => {
      proxy.discardHeld();
      proxy.reset();
    });

    afterAll(async () => {
      // Unset when beforeAll failed before starting it.
      await (proxy as RpcProxy | undefined)?.close();
    });

    /** The service settling through the proxy, with one settlement whose submission the proxy holds. */
    async function settling(graceMs: number) {
      const service = await startMain({
        TESTNET_RPC_URL: proxy.url,
        TESTNET_SPONSOR_SECRET: sponsor.secret(),
        TESTNET_CHANNEL_COUNT: "1",
        TESTNET_ASSETS: `${usdc.sac}:USDC:7`,
        TESTNET_MAX_TX_FEE_STROOPS: "2000000",
        TESTNET_MIN_SPONSOR_BALANCE_XLM: "1",
        SHUTDOWN_GRACE_MS: String(graceMs),
      });
      await listening(service);
      await expect
        .poll(async () => (await fetch(`${service.url}/ready/testnet`)).status, {
          timeout: 60_000,
          interval: 500,
        })
        .toBe(200);
      const [payer] = (await net.holders(usdc, 1, "10")) as [Keypair];
      const published = driver.requirements(seller.publicKey(), 1_000n, { maxTimeoutSeconds: 60 });
      const payload = await driver.pay({ kind: "G", address: payer.publicKey(), keypair: payer }, published);
      proxy.holdResponses("sendTransaction");
      const held = once(proxy.events, "held");
      const answer = fetch(`${service.url}/settle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          x402Version: 2,
          paymentPayload: payload,
          paymentRequirements: driver.settleRequirements(published, 1_000n),
        }),
      }).then(
        async (response) => ({ status: response.status, body: await response.json() }),
        () => undefined,
      );
      await held;
      return { service, answer };
    }

    it("lets it finish before exiting, refusing new connections meanwhile", async () => {
      const { service, answer } = await settling(10_000);
      service.process.kill("SIGTERM");
      await expect.poll(() => service.messages, { timeout: 10_000, interval: 50 }).toContain("shutting down");
      await expect(
        new Promise((resolve, reject) => {
          const probe = connect(service.port, "127.0.0.1", () => {
            probe.destroy();
            resolve("connected");
          });
          probe.on("error", reject);
        }),
      ).rejects.toMatchObject({ code: "ECONNREFUSED" });
      expect(service.process.exitCode).toBeNull();

      await proxy.releaseHeld();
      expect(await answer).toMatchObject({ status: 200, body: { success: true } });
      expect((await service.exited).code).toBe(0);
      expect(lifecycle(service)).toEqual(["rail402 listening", "shutting down", "stopped"]);
    });

    it("exits 1 once SHUTDOWN_GRACE_MS has passed with it still in flight", async () => {
      const { service } = await settling(1_500);
      const signalled = performance.now();
      service.process.kill("SIGTERM");
      const { code, at } = await service.exited;
      expect(code).toBe(1);
      expect(at - signalled).toBeGreaterThanOrEqual(1_400);
      expect(at - signalled).toBeLessThan(10_000);
      expect(lifecycle(service)).toEqual([
        "rail402 listening",
        "shutting down",
        "shutdown grace period elapsed; exiting",
      ]);
    });
  });

  it.each([
    ["a JSON-RPC error object", { code: -32603, message: "captive core is not ready" }],
    ["a string", "overloaded"],
    ["null", null],
  ])(
    "starts with its network held, not exiting, when the RPC makes startup throw %s",
    async (_kind, error) => {
      const proxy = await startRpcProxy(net.rpcUrl);
      try {
        proxy.answerError(error);
        const service = await startMain({
          TESTNET_RPC_URL: proxy.url,
          TESTNET_AUTO_PROVISION_CHANNELS: "true",
        });
        await listening(service);
        const ready = await fetch(`${service.url}/ready`);
        expect(ready.status).toBe(503);
        expect(await (await fetch(`${service.url}/ready/testnet`)).json()).toMatchObject({
          state: "held",
          holdReason: "rpc_unreachable",
        });
        expect(service.process.exitCode).toBeNull();
        expect(service.stderr).not.toContain("[object Object]");
        expect(service.messages).toContain(
          "a startup chain check failed; the network is held until it passes",
        );
      } finally {
        await proxy.close();
      }
    },
  );

  describe("with embeddings on", () => {
    const directories: string[] = [];
    afterAll(async () => {
      await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
    });

    it("refuses to start when the model files are missing", async () => {
      const directory = await mkdtemp(join(tmpdir(), "rail402-model-"));
      directories.push(directory);
      const service = await startMain({ BAZAAR_ENABLED: "true", SEARCH_MODEL_DIR: directory });
      expect((await service.exited).code).toBe(1);
      expect(service.stderr).toMatch(/^rail402: startup_failed: .*embedding model file .* is missing/);
      expect(service.messages).not.toContain("rail402 listening");
    });
  });
});
