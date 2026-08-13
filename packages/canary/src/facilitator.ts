import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { X402Error } from "@rail402/errors";
import { fundedSigner, sleep } from "./testnet.js";

/**
 * Optionally run the facilitator ourselves.
 *
 * A canary should normally point at a **deployment** — that is the thing whose health anybody
 * cares about. This module exists for the other case: a fresh clone, or a CI job with no secrets,
 * where there is no deployment to point at. It generates a settlement signer, funds it from
 * friendbot, and starts the real service as a child process with real configuration.
 *
 * That keeps the whole check runnable by anyone with `pnpm canary`, which matters more than it
 * sounds: a maintenance system a fork cannot run is a maintenance system a fork does not inherit.
 */

export interface SpawnedFacilitator {
  readonly url: string;
  readonly signerAddress: string;
  stop(): Promise<void>;
}

const READY_TIMEOUT_MS = 60_000;

/** Walk up from this module to the workspace root, identified by its pnpm workspace file. */
export function findRepoRoot(from: string = dirname(fileURLToPath(import.meta.url))): string {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new X402Error("canary_setup_failed", {
        reason: `Could not locate the workspace root above ${from}; --spawn needs it to start the facilitator.`,
      });
    }
    dir = parent;
  }
}

export async function spawnFacilitator(port: number): Promise<SpawnedFacilitator> {
  const root = findRepoRoot();
  const signer = await fundedSigner();
  const url = `http://127.0.0.1:${port}`;

  const child: ChildProcess = spawn(
    "pnpm",
    ["--filter", "@rail402/facilitator", "exec", "tsx", "src/index.ts"],
    {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        STELLAR_NETWORKS: "stellar:testnet",
        FACILITATOR_STELLAR_SECRET: signer.secret(),
        // A smart-account payment cross-calls a signature verifier and a spending policy, so it
        // costs far more than a keypair transfer: ~210k stroops for exact and ~165k for upto,
        // against ~23k for a keypair. The 100k default correctly refuses them, so a facilitator
        // that serves smart-account buyers (the oz-account canary does) must raise the cap. This is
        // a real deployment requirement, documented in the operator guide, not a test artifact.
        MAX_TRANSACTION_FEE_STROOPS: "500000",
        // The synthetic sellers bind 127.0.0.1, and the catalog refuses loopback resource URLs by
        // default (they are unreachable from the public internet and a stored SSRF target). A locally
        // spawned facilitator is the one place that opt-in is correct — a hosted deployment never
        // sets it. Without this, cataloging every canary listing would be rejected as a private host.
        BAZAAR_ALLOW_PRIVATE_HOSTS: "1",
        LOG_LEVEL: "warn",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  // Keep the child's output — if it dies during startup this is the only explanation available.
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });

  let exited = false;
  child.on("exit", () => {
    exited = true;
  });

  const stop = async (): Promise<void> => {
    if (exited) return;
    child.kill("SIGTERM");
    for (let i = 0; i < 40 && !exited; i++) await sleep(100);
    if (!exited) child.kill("SIGKILL");
  };

  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (exited) {
      throw new X402Error("canary_setup_failed", {
        reason: `The facilitator process exited during startup. Output:\n${output.trim() || "(none)"}`,
      });
    }
    const healthy = await fetch(`${url}/health`)
      .then(r => r.ok)
      .catch(() => false);
    if (healthy) return { url, signerAddress: signer.publicKey(), stop };

    if (Date.now() >= deadline) {
      await stop();
      throw new X402Error("canary_setup_failed", {
        reason: `The facilitator did not answer /health within ${READY_TIMEOUT_MS}ms. Output:\n${output.trim() || "(none)"}`,
      });
    }
    await sleep(250);
  }
}
