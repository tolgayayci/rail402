/**
 * The service process itself (src/main.ts): startup and SIGTERM handling, observed from outside as an
 * operator's supervisor sees them. Needs `docker compose --profile stellar up -d` for the RPC.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { LocalNetwork } from "@rail402.dev/testkit";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const net = new LocalNetwork();
const available = await net.available();

interface Service {
  readonly process: ChildProcess;
  readonly port: number;
  /** Log messages (`msg`) in the order they were written. */
  readonly messages: string[];
  readonly stderr: () => string;
  /** Resolves with the exit code and the time of exit. */
  readonly exited: Promise<{ code: number | null; at: number }>;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Service processes started by a test; any still alive afterwards are killed. */
const running: ChildProcess[] = [];

/** Starts `node src/main.ts` with the in-memory store and no channel provisioning. */
async function startMain(env: Record<string, string> = {}): Promise<Service> {
  const port = await freePort();
  const child = spawn(process.execPath, ["--conditions=@rail402/source", MAIN], {
    env: {
      PATH: process.env["PATH"] ?? "",
      STORE: "memory",
      HOST: "127.0.0.1",
      PORT: String(port),
      TESTNET_RPC_URL: net.rpcUrl,
      TESTNET_SPONSOR_SECRET: Keypair.random().secret(),
      TESTNET_AUTO_PROVISION_CHANNELS: "false",
      BAZAAR_ENABLED: "false",
      RATE_LIMIT_PER_MINUTE: "0",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const messages: string[] = [];
  let buffered = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("{")) messages.push((JSON.parse(line) as { msg: string }).msg);
    }
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const exited = new Promise<{ code: number | null; at: number }>((resolve) => {
    child.once("exit", (code) => {
      resolve({ code, at: performance.now() });
    });
  });
  running.push(child);
  return { process: child, port, messages, stderr: () => stderr, exited };
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
  afterEach(() => {
    for (const child of running.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
  });

  const listening = (service: Service) =>
    expect.poll(() => service.messages, { timeout: 60_000, interval: 100 }).toContain("rail402 listening");

  it("stops on SIGTERM: stops listening, finishes, and exits 0", async () => {
    const service = await startMain();
    await listening(service);
    service.process.kill("SIGTERM");
    expect((await service.exited).code).toBe(0);
    expect(service.messages.slice(-2)).toEqual(["shutting down", "stopped"]);
  });

  it("lets an in-flight request finish before exiting", async () => {
    const service = await startMain({ SHUTDOWN_GRACE_MS: "10000" });
    await listening(service);
    const body = JSON.stringify({ x402Version: 2 });
    const request = await partialRequest(service.port, body, 5);
    await expect.poll(() => request.socket.bytesWritten).toBeGreaterThan(0);

    service.process.kill("SIGTERM");
    await expect.poll(() => service.messages).toContain("shutting down");
    // New connections are refused while the in-flight request is still open.
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

    request.socket.write(body.slice(5));
    const { code } = await service.exited;
    expect(request.response()).toMatch(/^HTTP\/1\.1 400 /);
    expect(request.response()).toContain('"invalidReason":"invalid_payload"');
    expect(code).toBe(0);
    expect(service.messages.slice(-2)).toEqual(["shutting down", "stopped"]);
  });

  it("exits 1 once SHUTDOWN_GRACE_MS has passed with a request still in flight", async () => {
    const service = await startMain({ SHUTDOWN_GRACE_MS: "1500" });
    await listening(service);
    await partialRequest(service.port, JSON.stringify({ x402Version: 2 }), 5);

    const signalled = performance.now();
    service.process.kill("SIGTERM");
    const { code, at } = await service.exited;
    expect(code).toBe(1);
    expect(at - signalled).toBeGreaterThanOrEqual(1_400);
    expect(at - signalled).toBeLessThan(10_000);
    expect(service.messages).toContain("shutdown grace period elapsed; exiting");
    expect(service.messages).not.toContain("stopped");
  });

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
      expect(service.stderr()).toMatch(/^rail402: fatal: .*embedding model file .* is missing/);
      expect(service.messages).not.toContain("rail402 listening");
    });
  });
});
