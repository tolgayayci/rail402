import { Address, xdr } from "@stellar/stellar-sdk";
import { LedgerSourceError } from "./errors.ts";
import { request, type Fetch } from "./http.ts";

export interface ContractWasm {
  readonly contract: string;
  /** Hex SHA-256 of the WASM the instance runs, or `null` for a Stellar Asset Contract. */
  readonly wasmSha256: string | null;
  readonly latestLedger: number;
}

/**
 * Reads a contract instance through RPC `getLedgerEntries` and returns the hash of the WASM it runs.
 * Used to check an upto registry entry against the chain before it is added.
 */
export async function contractWasmHash(
  rpcUrl: string,
  contract: string,
  options: { readonly fetch?: Fetch; readonly timeoutMs?: number } = {},
): Promise<ContractWasm> {
  const url = new URL(rpcUrl);
  if (url.protocol !== "https:")
    throw new LedgerSourceError("source_config_invalid", "the RPC URL must be https");
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(contract).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
  const result = await request(
    url,
    {
      maxBytes: 1024 * 1024,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    },
    {
      method: "POST",
      json: { jsonrpc: "2.0", id: 1, method: "getLedgerEntries", params: { keys: [key.toXDR("base64")] } },
    },
  );
  if (result.status === 404) throw new LedgerSourceError("http_status", `${url.host} answered 404`);
  const body = JSON.parse(result.body.toString("utf8")) as {
    result?: { entries?: { xdr: string }[] | null; latestLedger: number };
    error?: { message?: string };
  };
  const [entry] = body.result?.entries ?? [];
  if (body.result === undefined || entry === undefined) {
    throw new LedgerSourceError(
      "rpc_error",
      `${contract}: no contract instance (${body.error?.message ?? "not found"})`,
    );
  }
  const data = xdr.LedgerEntryData.fromXDR(entry.xdr, "base64").contractData();
  const executable = data.val().instance().executable();
  return {
    contract,
    wasmSha256:
      executable.switch() === xdr.ContractExecutableType.contractExecutableWasm()
        ? executable.wasmHash().toString("hex")
        : null,
    latestLedger: body.result.latestLedger,
  };
}
