import { Buffer } from "buffer";
import { Address, xdr, type rpc } from "@stellar/stellar-sdk";

/**
 * How long a contract stays live, read from the ledger. A Soroban contract lives in two persistent
 * entries: its instance (storage and executable) and, for a WASM contract, the code entry the
 * instance points at. Each entry has a `liveUntilLedgerSeq`; once the network passes it, the entry is
 * archived and every call to the contract fails until someone restores it. A Stellar Asset Contract
 * has no code entry: its executable is built into the protocol.
 */
export interface ContractTtl {
  readonly contract: string;
  readonly kind: "wasm" | "stellar_asset";
  /** Last ledger the instance entry is live in. */
  readonly instanceLiveUntil: number;
  /** Last ledger the code entry is live in; absent for a Stellar Asset Contract, or when the code entry is gone. */
  readonly codeLiveUntil?: number;
  /** The WASM hash the instance runs, hex; absent for a Stellar Asset Contract. */
  readonly wasmHash?: string;
}

export interface ContractTtlReading {
  /** The ledger the RPC answered at; `liveUntil - latestLedger` is the remaining TTL. */
  readonly latestLedger: number;
  /** One entry per requested contract; `undefined` when its instance entry is not in the live state. */
  readonly contracts: ReadonlyMap<string, ContractTtl | undefined>;
}

/** getLedgerEntries accepts at most this many keys per call. */
const MAX_KEYS = 200;

/** The ledger key of a contract's instance entry. */
export function contractInstanceKey(contract: string): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(contract).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

/** The ledger key of an uploaded WASM's code entry. */
export function contractCodeKey(wasmHash: Buffer): xdr.LedgerKey {
  return xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: wasmHash }));
}

/**
 * Reads the instance and code TTLs of `contracts` in two `getLedgerEntries` calls per 200 contracts:
 * one for the instance entries, one for the code entries they point at (shared code is read once).
 * A contract whose instance is not in the live state (never deployed, or archived and evicted) maps
 * to `undefined`. RPC failures reject.
 */
export async function readContractTtl(
  server: Pick<rpc.Server, "getLedgerEntries">,
  contracts: readonly string[],
): Promise<ContractTtlReading> {
  const unique = [...new Set(contracts)];
  const found = new Map<string, ContractTtl | undefined>();
  let latestLedger = 0;

  const instances = new Map<string, { liveUntil: number; wasmHash?: Buffer }>();
  for (const chunk of chunks(unique, MAX_KEYS)) {
    const keys = chunk.map(contractInstanceKey);
    const byKey = new Map(chunk.map((contract, index) => [keys[index]?.toXDR("base64"), contract]));
    const answer = await server.getLedgerEntries(...keys);
    latestLedger = Math.max(latestLedger, answer.latestLedger);
    for (const entry of answer.entries) {
      const contract = byKey.get(entry.key.toXDR("base64"));
      if (contract === undefined || entry.liveUntilLedgerSeq === undefined) continue;
      const executable = entry.val.contractData().val().instance().executable();
      const wasm =
        executable.switch() === xdr.ContractExecutableType.contractExecutableWasm()
          ? executable.wasmHash()
          : undefined;
      instances.set(contract, {
        liveUntil: entry.liveUntilLedgerSeq,
        ...(wasm === undefined ? {} : { wasmHash: wasm }),
      });
    }
  }

  const hashes = [
    ...new Set(
      [...instances.values()].flatMap((instance) =>
        instance.wasmHash === undefined ? [] : [instance.wasmHash.toString("hex")],
      ),
    ),
  ];
  const codeLiveUntil = new Map<string, number>();
  for (const chunk of chunks(hashes, MAX_KEYS)) {
    const answer = await server.getLedgerEntries(
      ...chunk.map((hex) => contractCodeKey(Buffer.from(hex, "hex"))),
    );
    latestLedger = Math.max(latestLedger, answer.latestLedger);
    for (const entry of answer.entries) {
      if (entry.liveUntilLedgerSeq === undefined) continue;
      codeLiveUntil.set(entry.key.contractCode().hash().toString("hex"), entry.liveUntilLedgerSeq);
    }
  }

  for (const contract of unique) {
    const instance = instances.get(contract);
    if (instance === undefined) {
      found.set(contract, undefined);
      continue;
    }
    const hex = instance.wasmHash?.toString("hex");
    const code = hex === undefined ? undefined : codeLiveUntil.get(hex);
    found.set(contract, {
      contract,
      kind: hex === undefined ? "stellar_asset" : "wasm",
      instanceLiveUntil: instance.liveUntil,
      ...(code === undefined ? {} : { codeLiveUntil: code }),
      ...(hex === undefined ? {} : { wasmHash: hex }),
    });
  }
  return { latestLedger, contracts: found };
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}
