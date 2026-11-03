import { Address, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { LedgerSourceError, contractWasmHash } from "../src/index.ts";

const CONTRACT = "CBTVKCHLSGQ3WSV3NKSU6FZR4FZMC6ENMDMXUS5XQ66HYVUUHYE3TU7U";

function instance(executable: xdr.ContractExecutable): string {
  return xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: new xdr.ExtensionPoint(0),
      contract: Address.fromString(CONTRACT).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
      val: xdr.ScVal.scvContractInstance(new xdr.ScContractInstance({ executable, storage: null })),
    }),
  ).toXDR("base64");
}

const rpc = (result: unknown) =>
  (() => Promise.resolve(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result })))) as typeof fetch;

describe("contractWasmHash", () => {
  it("reads the WASM hash a contract instance runs", async () => {
    const hash = Buffer.alloc(32, 0xcc);
    const found = await contractWasmHash("https://rpc.example", CONTRACT, {
      fetch: rpc({
        entries: [{ xdr: instance(xdr.ContractExecutable.contractExecutableWasm(hash)) }],
        latestLedger: 7,
      }),
    });
    expect(found).toEqual({ contract: CONTRACT, wasmSha256: hash.toString("hex"), latestLedger: 7 });
  });

  it("reports a Stellar Asset Contract as no WASM and a missing instance as an error", async () => {
    const sac = await contractWasmHash("https://rpc.example", CONTRACT, {
      fetch: rpc({
        entries: [{ xdr: instance(xdr.ContractExecutable.contractExecutableStellarAsset()) }],
        latestLedger: 7,
      }),
    });
    expect(sac.wasmSha256).toBeNull();
    await expect(
      contractWasmHash("https://rpc.example", CONTRACT, { fetch: rpc({ entries: [], latestLedger: 7 }) }),
    ).rejects.toBeInstanceOf(LedgerSourceError);
    await expect(contractWasmHash("http://rpc.example", CONTRACT)).rejects.toMatchObject({
      code: "source_config_invalid",
    });
  });
});
