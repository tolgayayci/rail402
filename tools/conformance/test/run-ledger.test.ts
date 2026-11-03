import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LedgerError, RunLedger, planRun, type RunMaterial } from "../src/run-ledger.ts";

const dir = mkdtempSync(join(tmpdir(), "rail402-ledger-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const material = (overrides: Partial<RunMaterial> = {}): RunMaterial => ({
  commit: "c0ffee",
  network: "stellar:pubnet",
  treasury: "GTREASURY",
  runCaps: { maxNetXlmStroops: 1_000n, maxNetUsdcBaseUnits: 500n },
  settings: { maxSettlements: "10" },
  ...overrides,
});

const code = (run: () => unknown) => {
  try {
    run();
    return "";
  } catch (error) {
    return error instanceof LedgerError ? error.code : String(error);
  }
};

describe("the run ledger", () => {
  it("is planned owner-only, claimed once, and refuses other material", () => {
    const { runId, path } = planRun(material(), dir);
    expect(statSync(path).mode & 0o077).toBe(0);
    expect(statSync(join(dir, runId)).mode & 0o077).toBe(0);
    expect(code(() => RunLedger.join(path, runId, material(), "early"))).toBe("pubnet_run_unconfirmed");
    expect(code(() => RunLedger.claim(runId, material({ commit: "c0ffef" }), "canonical", dir))).toBe(
      "pubnet_run_mismatch",
    );
    const ledger = RunLedger.claim(runId, material(), "canonical", dir);
    expect(code(() => RunLedger.claim(runId, material(), "canonical", dir))).toBe("pubnet_run_reused");
    expect(code(() => RunLedger.claim("0".repeat(16), material(), "canonical", dir))).toBe(
      "pubnet_run_unknown",
    );
    const joined = RunLedger.join(path, runId, material(), "live-matrix");
    expect(joined.read().harnesses.map((entry) => entry.name)).toEqual(["canonical", "live-matrix"]);
    ledger.close();
    expect(
      code(() => {
        joined.debit({ xlmStroops: 1n }, "a fee");
      }),
    ).toBe("pubnet_run_closed");
    expect(code(() => RunLedger.claim(runId, material(), "canonical", dir))).toBe("pubnet_run_reused");
  });

  it("caps the run's net XLM and net USDC loss: what comes back makes room again", () => {
    const { runId } = planRun(material(), dir);
    const ledger = RunLedger.claim(runId, material(), "canonical", dir);
    ledger.debit({ xlmStroops: 900n, usdcBaseUnits: 500n, settlements: 3 }, "funding");
    expect(
      code(() => {
        ledger.debit({ xlmStroops: 101n }, "a fee");
      }),
    ).toBe("spend_cap_exceeded");
    expect(
      code(() => {
        ledger.debit({ usdcBaseUnits: 1n }, "a payment");
      }),
    ).toBe("spend_cap_exceeded");
    expect(
      code(() => {
        ledger.ensure({ usdcBaseUnits: 1n }, "a plan");
      }),
    ).toBe("spend_cap_exceeded");
    ledger.credit({ usdcBaseUnits: 400n, xlmStroops: 200n });
    ledger.debit({ usdcBaseUnits: 400n, xlmStroops: 300n }, "a second harness's funding");
    ledger.release(100n);
    expect(ledger.totals()).toMatchObject({
      spent: { xlmStroops: "1100", usdcBaseUnits: "900", settlements: 3 },
      returned: { xlmStroops: "200", usdcBaseUnits: "400" },
    });
  });

  it("never lets concurrent harness processes pass the run's cap together", async () => {
    const { runId, path } = planRun(material(), dir);
    RunLedger.claim(runId, material(), "run-evidence", dir);
    const script = `
      import { RunLedger } from ${JSON.stringify(new URL("../src/run-ledger.ts", import.meta.url).href)};
      const [path, runId, material] = process.argv.slice(1);
      const parsed = JSON.parse(material);
      parsed.runCaps = { maxNetXlmStroops: BigInt(parsed.runCaps.maxNetXlmStroops), maxNetUsdcBaseUnits: BigInt(parsed.runCaps.maxNetUsdcBaseUnits) };
      const ledger = RunLedger.join(path, runId, parsed, "harness-" + process.pid);
      let ok = 0;
      for (let i = 0; i < 60; i++) {
        try { ledger.debit({ xlmStroops: 7n, settlements: 1 }, "a fee"); ok++; } catch (error) { if (error.code !== "spend_cap_exceeded") throw error; }
      }
      process.stdout.write(String(ok));
    `;
    const serial = JSON.stringify(material(), (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    const children = Array.from(
      { length: 6 },
      () =>
        new Promise<number>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            ["--conditions=@rail402/source", "--input-type=module", "-e", script, path, runId, serial],
            { cwd: new URL("..", import.meta.url), stdio: ["ignore", "pipe", "pipe"] },
          );
          let out = "";
          let err = "";
          child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
          child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
          child.on("close", (exit) => {
            if (exit === 0) resolve(Number(out));
            else reject(new Error(`a harness process failed: ${err}`));
          });
        }),
    );
    const debits = (await Promise.all(children)).reduce((sum, ok) => sum + ok, 0);
    const totals = RunLedger.inspect(path).totals();
    // 6 × 60 × 7 stroops were asked for; the run allowed exactly what fits its 1,000 stroops.
    expect(BigInt(totals.spent.xlmStroops)).toBe(994n);
    expect(debits).toBe(142);
    expect(totals.spent.settlements).toBe(142);
  }, 60_000);
});
