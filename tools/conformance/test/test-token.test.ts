import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TEST6_TESTNET } from "@rail402.dev/testkit";
import { TEST6_RECORD_PATH, readTest6Record, test6Asset } from "../src/test-token.ts";

const scratch = await mkdtemp(join(tmpdir(), "rail402-test6-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));

async function tampered(edit: (record: Record<string, unknown>) => void): Promise<string> {
  const record = JSON.parse(await readFile(TEST6_RECORD_PATH, "utf8")) as Record<string, unknown>;
  edit(record);
  const file = join(scratch, `${String(Math.random()).slice(2)}.json`);
  await writeFile(file, JSON.stringify(record));
  return file;
}

describe("the TEST6 deployment record", () => {
  it("is the token tests import as TEST6_TESTNET", () => {
    expect(test6Asset()).toEqual({
      contract: TEST6_TESTNET.address,
      symbol: "TEST6",
      decimals: 6,
      record: {
        deployTx: readTest6Record().transactions.deploy.tx,
        wasmSha256: TEST6_TESTNET.wasmHash,
        commit: readTest6Record().commit,
      },
    });
  });

  it("is refused when it disagrees with TEST6_TESTNET", async () => {
    const otherContract = await tampered((record) => {
      record["contract_id"] = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    });
    expect(() => readTest6Record(otherContract)).toThrow("disagrees with TEST6_TESTNET on contract_id");
    const otherWasm = await tampered((record) => {
      record["wasm_sha256"] = "0".repeat(64);
    });
    expect(() => readTest6Record(otherWasm)).toThrow("on wasm_sha256");
  });

  it("is refused when it is not a 6-decimal test token record", async () => {
    const eighteen = await tampered((record) => {
      (record["constructor"] as Record<string, unknown>)["decimals"] = 18;
    });
    expect(() => readTest6Record(eighteen)).toThrow();
  });
});
