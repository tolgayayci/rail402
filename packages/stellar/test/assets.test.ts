import { describe, expect, it } from "vitest";
import { Address, StrKey, nativeToScVal, xdr, type rpc } from "@stellar/stellar-sdk";
import {
  AssetDirectory,
  TESTNET,
  availableNativeBalance,
  availableTrustlineBalance,
  networkPassphrase,
} from "@rail402.dev/stellar";

const CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 9));

/** Host errors as a simulation reports them (first line and diagnostic events, abridged). */
const ERRORS = {
  missingWasmFunction:
    'HostError: Error(WasmVm, MissingValue)\n\nEvent log (newest first):\n   0: [Diagnostic Event] topics:[error, Error(WasmVm, MissingValue)], data:["trying to invoke non-existent contract function", decimals]',
  missingSacFunction:
    'HostError: Error(Value, InvalidInput)\n\nEvent log (newest first):\n   0: [Diagnostic Event] topics:[error, Error(Value, InvalidInput)], data:["symbol not found in slice of strs", decimals]',
  noInstance:
    'HostError: Error(Storage, MissingValue)\n\nEvent log (newest first):\n   0: [Diagnostic Event] topics:[error, Error(Storage, MissingValue)], data:"trying to get non-existing value for contract instance"',
  trapped:
    'HostError: Error(WasmVm, InvalidAction)\n\nEvent log (newest first):\n   0: [Diagnostic Event] topics:[error, Error(WasmVm, InvalidAction)], data:"escalating error to VM trap from failed host function call: call"',
  budget: "HostError: Error(Budget, ExceededLimit)",
  unlabeled: "Error(Storage, MissingValue)",
};

/** A server whose contract instance is live, answering `decimals()` as told. */
function directory(
  simulation: () => Partial<rpc.Api.SimulateTransactionResponse> | Promise<never>,
  executable = xdr.ContractExecutable.contractExecutableStellarAsset(),
): AssetDirectory {
  const server = {
    getLedgerEntries: (...keys: xdr.LedgerKey[]) => {
      const instances = keys.filter((key) => key.switch() === xdr.LedgerEntryType.contractData());
      return Promise.resolve({
        latestLedger: 100,
        entries: instances.map((key) => ({
          key,
          liveUntilLedgerSeq: 1_000,
          val: xdr.LedgerEntryData.contractData(
            new xdr.ContractDataEntry({
              ext: new xdr.ExtensionPoint(0),
              contract: Address.fromString(CONTRACT).toScAddress(),
              key: xdr.ScVal.scvLedgerKeyContractInstance(),
              durability: xdr.ContractDataDurability.persistent(),
              val: xdr.ScVal.scvContractInstance(new xdr.ScContractInstance({ executable, storage: null })),
            }),
          ),
        })),
      });
    },
    simulateTransaction: () => {
      const answer = simulation();
      return answer instanceof Promise ? answer : Promise.resolve({ latestLedger: 100, ...answer });
    },
  };
  return new AssetDirectory(server as unknown as rpc.Server, networkPassphrase(TESTNET));
}

const answering = (value: xdr.ScVal) => () =>
  ({
    transactionData: new xdr.SorobanTransactionData({
      ext: new xdr.SorobanTransactionDataExt(0),
      resources: new xdr.SorobanResources({
        footprint: new xdr.LedgerFootprint({ readOnly: [], readWrite: [] }),
        instructions: 0,
        diskReadBytes: 0,
        writeBytes: 0,
      }),
      resourceFee: xdr.Int64.fromString("0"),
    }),
    minResourceFee: "0",
    result: { auth: [], retval: value },
  }) as unknown as Partial<rpc.Api.SimulateTransactionResponse>;

const failing = (error: string) => () => ({ error, events: [] });

describe("AssetDirectory.inspect", () => {
  it("reads the kind and the decimals of a token", async () => {
    expect(await directory(answering(nativeToScVal(6, { type: "u32" }))).inspect(CONTRACT)).toEqual({
      found: true,
      kind: "sac",
      decimals: 6,
    });
    const wasm = xdr.ContractExecutable.contractExecutableWasm(Buffer.alloc(32, 1));
    expect(await directory(answering(nativeToScVal(18, { type: "u32" })), wasm).inspect(CONTRACT)).toEqual({
      found: true,
      kind: "sep41",
      decimals: 18,
    });
  });

  it("is definitive when the contract has no decimals() or answers it with something else", async () => {
    for (const error of [ERRORS.missingWasmFunction, ERRORS.missingSacFunction]) {
      expect(await directory(failing(error)).inspect(CONTRACT)).toEqual({
        found: true,
        kind: "sac",
        decimals: undefined,
      });
    }
    expect(await directory(answering(xdr.ScVal.scvString("seven"))).inspect(CONTRACT)).toMatchObject({
      decimals: undefined,
    });
  });

  it("reports a contract without an instance as not deployed", async () => {
    expect(await directory(failing(ERRORS.noInstance)).inspect(CONTRACT)).toEqual({ found: false });
  });

  it("rejects on every other failure, so the check is retried rather than decided", async () => {
    for (const error of [ERRORS.trapped, ERRORS.budget, ERRORS.unlabeled]) {
      await expect(directory(failing(error)).inspect(CONTRACT)).rejects.toThrow(
        /simulating decimals\(\) failed/,
      );
    }
    await expect(
      directory(() => Promise.reject(new Error("socket hang up"))).inspect(CONTRACT),
    ).rejects.toThrow("socket hang up");
  });
});

describe("available balances", () => {
  const liabilities = (selling: bigint) =>
    new xdr.Liabilities({
      buying: xdr.Int64.fromString("0"),
      selling: xdr.Int64.fromString(selling.toString()),
    });

  it("holds back a trustline's selling liabilities", () => {
    const trustline = (ext: xdr.TrustLineEntryExt) =>
      new xdr.TrustLineEntry({
        accountId: xdr.PublicKey.publicKeyTypeEd25519(Buffer.alloc(32, 1)),
        asset: xdr.TrustLineAsset.assetTypeNative(),
        balance: xdr.Int64.fromString("1000"),
        limit: xdr.Int64.fromString("100000"),
        flags: 1,
        ext,
      });
    expect(availableTrustlineBalance(trustline(new xdr.TrustLineEntryExt(0)))).toBe(1_000n);
    const withOffers = new xdr.TrustLineEntryExt(
      1,
      new xdr.TrustLineEntryV1({ liabilities: liabilities(400n), ext: new xdr.TrustLineEntryV1Ext(0) }),
    );
    expect(availableTrustlineBalance(trustline(withOffers))).toBe(600n);
  });

  it("holds back the native minimum reserve and selling liabilities", () => {
    const account = (balance: bigint, subEntries: number, ext: xdr.AccountEntryExt) =>
      new xdr.AccountEntry({
        accountId: xdr.PublicKey.publicKeyTypeEd25519(Buffer.alloc(32, 2)),
        balance: xdr.Int64.fromString(balance.toString()),
        seqNum: xdr.Int64.fromString("1"),
        numSubEntries: subEntries,
        inflationDest: null,
        flags: 0,
        homeDomain: "",
        thresholds: Buffer.from([1, 0, 0, 0]),
        signers: [],
        ext,
      });
    // Two base reserves for the account and one per trustline.
    expect(availableNativeBalance(account(100_000_000n, 1, new xdr.AccountEntryExt(0)))).toBe(85_000_000n);
    const withOffers = new xdr.AccountEntryExt(
      1,
      new xdr.AccountEntryExtensionV1({
        liabilities: liabilities(5_000_000n),
        ext: new xdr.AccountEntryExtensionV1Ext(0),
      }),
    );
    expect(availableNativeBalance(account(100_000_000n, 1, withOffers))).toBe(80_000_000n);
    expect(availableNativeBalance(account(10_000_000n, 0, new xdr.AccountEntryExt(0)))).toBe(0n);
  });
});
