import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("indexer memory", () => {
  it("indexes rounds of large ledgers inside a 128 MB heap", () => {
    // 400 ledgers of 2 MiB decoded each: two rounds that would need about 500 MB held at once.
    const child = spawnSync(
      process.execPath,
      [
        "--max-old-space-size=128",
        "--expose-gc",
        "--conditions=@rail402/source",
        fileURLToPath(new URL("./memory-child.ts", import.meta.url)),
      ],
      { encoding: "utf8", env: { ...process.env, MEMORY_LEDGERS: "400" }, timeout: 90_000 },
    );
    expect(child.stderr).not.toMatch(/heap out of memory/);
    expect(child.status).toBe(0);
    const result = JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "{}") as {
      committed: number;
      retainedHeapMiB: number;
    };
    expect(result.committed).toBe(400);
    // The raw bytes held (at most 64 MiB), one decoded ledger and the code: about 90 MiB, where a round
    // of decoded ledgers held at once is about 450 MiB.
    expect(result.retainedHeapMiB).toBeLessThan(112);
  }, 120_000);

  it("rebuilds a full scope of large ledgers inside a 128 MB heap with a byte budget", () => {
    const run = (heapMiB: number, env: Record<string, string>) => {
      const child = spawnSync(
        process.execPath,
        [
          `--max-old-space-size=${String(heapMiB)}`,
          "--expose-gc",
          "--conditions=@rail402/source",
          fileURLToPath(new URL("./memory-rebuild-child.ts", import.meta.url)),
        ],
        { encoding: "utf8", env: { ...process.env, MEMORY_LEDGERS: "400", ...env }, timeout: 90_000 },
      );
      expect(child.stderr).not.toMatch(/heap out of memory/);
      expect(child.status).toBe(0);
      return JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "{}") as {
        ledgers: number;
        retainedHeapMiB: number;
        manifestSha256: string;
      };
    };
    // 64 requests in flight with 8 MiB of raw bytes allowed: one decoded ledger at a time.
    const budgeted = run(128, { MEMORY_CONCURRENCY: "64", MEMORY_BYTES_IN_FLIGHT: String(8 * 2 ** 20) });
    expect(budgeted.ledgers).toBe(400);
    // The raw bytes held, one decoded ledger and the code: about 40 MiB, where 64 decoded ledgers held
    // ahead of their turn are about 150 MiB.
    expect(budgeted.retainedHeapMiB).toBeLessThan(64);
    // The budget changes only memory: one request at a time gives the same manifest.
    expect(run(256, { MEMORY_CONCURRENCY: "1" }).manifestSha256).toBe(budgeted.manifestSha256);
  }, 180_000);
});
