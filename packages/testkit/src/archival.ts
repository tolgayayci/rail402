import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Keypair } from "@stellar/stellar-sdk";
import { LocalNetwork } from "./network.ts";

const run = promisify(execFile);

/** The quickstart image of docker-compose.yml's `stellar` and `stellar-archival` services. */
export const QUICKSTART_IMAGE = "stellar/quickstart:v669-b1438.1-latest";

/** Quickstart's testnet limits with state archival sped up (min persistent TTL 10, min temporary TTL 16). */
export const SHORT_TTL_LIMITS = fileURLToPath(
  new URL("../../../test/stellar/short-ttl.json", import.meta.url),
);

/** Where quickstart looks for a `--limits short-ttl` preset (protocol 28 reads the p26 directory). */
const LIMITS_TARGET = "/opt/stellar-default/local/core/etc/config-settings/p26/short-ttl.json";

/** A private network of its own whose contracts are archived about ten ledgers after their last extension. */
export interface ArchivalNetwork {
  readonly network: LocalNetwork;
  readonly container: string;
  /** Removes the container. */
  stop(): Promise<void>;
}

/** Whether a Docker daemon answers, so tests that start their own network can run. */
export async function dockerAvailable(): Promise<boolean> {
  try {
    await run("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 60_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Starts a disposable quickstart container with the short-TTL limits on a free loopback port, under a
 * unique name, and waits until Friendbot funds accounts. It never touches the shared `stellar`
 * service. Call `stop()` when done.
 */
export async function startArchivalNetwork(
  options: { readonly limitsFile?: string; readonly readyTimeoutMs?: number } = {},
): Promise<ArchivalNetwork> {
  const container = `rail402-archival-${randomBytes(4).toString("hex")}`;
  const stop = async () => {
    await run("docker", ["rm", "-f", container], { timeout: 60_000 }).catch(() => undefined);
  };
  await run(
    "docker",
    [
      "run",
      "-d",
      "--name",
      container,
      "-p",
      "127.0.0.1::8000",
      "-e",
      "NETWORK_PASSPHRASE=Test SDF Network ; September 2015",
      "-e",
      "RANDOMIZE_NETWORK_PASSPHRASE=false",
      "-v",
      `${options.limitsFile ?? SHORT_TTL_LIMITS}:${LIMITS_TARGET}:ro`,
      QUICKSTART_IMAGE,
      "--local",
      "--limits",
      "short-ttl",
      "--enable",
      "core,rpc",
    ],
    { timeout: 120_000 },
  );
  try {
    const { stdout } = await run("docker", ["port", container, "8000/tcp"], { timeout: 10_000 });
    const port = /:(\d+)\s*$/m.exec(stdout.trim())?.[1];
    if (port === undefined) throw new Error(`no host port for ${container}: ${stdout}`);
    const origin = `http://127.0.0.1:${port}`;
    const network = new LocalNetwork(`${origin}/rpc`, `${origin}/friendbot`);
    await waitUntilReady(container, network, options.readyTimeoutMs ?? 240_000);
    return { network, container, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function waitUntilReady(container: string, network: LocalNetwork, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const logs = await run("docker", ["logs", container], { timeout: 10_000, maxBuffer: 64 << 20 }).then(
      ({ stdout, stderr }) => stdout + stderr,
      () => "",
    );
    // Core refuses a limits preset it cannot apply; waiting longer would not help.
    if (logs.includes("Unable to upgrade")) throw new Error(`${container}: core rejected the limits preset`);
    try {
      // A fresh account each time: Friendbot refuses to fund one twice.
      const funded = await fetch(`${network.friendbotUrl}?addr=${Keypair.random().publicKey()}`);
      if (funded.ok && (await network.available())) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`${container} was not ready after ${String(timeoutMs)} ms`);
}
