import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };
import { PAY_TO } from "./support.ts";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));

/** Runs the server entry point with `env` only; resolves when it exits or after `untilMs`. */
function run(env: Record<string, string>, untilMs = 15_000) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ["--conditions=@rail402/source", MAIN], {
      env: { PATH: process.env["PATH"] ?? "", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => child.kill("SIGTERM"), untilMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe("server entry point", () => {
  it("exits with 78 and a coded line when the configuration is invalid", async () => {
    const result = await run({ PLAYGROUND_PAY_TO: PAY_TO });
    expect(result.code).toBe(78);
    expect(JSON.parse(result.stderr.trim())).toMatchObject({
      level: "fatal",
      code: "playground_config_invalid",
      reason: expect.stringMatching(/^PUBLIC_URL/) as string,
    });
  });

  it("refuses to start with a secret seed anywhere in its environment, without printing it", async () => {
    const seed = Keypair.random().secret();
    const result = await run({
      PUBLIC_URL: "https://playground.example",
      PLAYGROUND_PAY_TO: PAY_TO,
      LEFTOVER: seed,
    });
    expect(result.code).toBe(78);
    expect(result.stderr).toContain("LEFTOVER holds a Stellar secret seed");
    expect(result.stderr + result.stdout).not.toContain(seed);
  });

  it("starts, serves /health and stops on SIGTERM", async () => {
    const port = String(20_000 + Math.floor(Math.random() * 20_000));
    const child = spawn(process.execPath, ["--conditions=@rail402/source", MAIN], {
      env: {
        PATH: process.env["PATH"] ?? "",
        PUBLIC_URL: "http://127.0.0.1:8080",
        PLAYGROUND_PAY_TO: PAY_TO,
        PORT: port,
        HOST: "127.0.0.1",
      },
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("the server did not start"));
      }, 15_000);
      child.stdout.on("data", () => {
        if (stdout.includes("rail402-playground listening")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(await health.json()).toMatchObject({ status: "ok", version: pkg.version });
    const exited = new Promise<number | null>((resolve) => {
      child.on("exit", resolve);
    });
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
  }, 30_000);
});
