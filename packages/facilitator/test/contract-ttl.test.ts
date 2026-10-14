import { describe, expect, it } from "vitest";
import {
  Account,
  Keypair,
  Networks,
  SorobanDataBuilder,
  StrKey,
  hash,
  xdr,
  type Transaction,
  type rpc,
} from "@stellar/stellar-sdk";
import {
  ContractTtlError,
  MemoryTaskLock,
  contractFootprint,
  contractLiveness,
  extendContractTtl,
  planContractTtl,
  restoreContract,
} from "@rail402.dev/facilitator";
import { contractCodeKey, contractInstanceKey } from "@rail402.dev/stellar";

const CONTRACT = StrKey.encodeContract(hash(Buffer.from("rail402 contract ttl tests")));
const WASM_HASH = "ab".repeat(32);
const sponsor = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9));

describe("contract liveness", () => {
  it("counts ledgers left per entry, negative once archived", () => {
    const live = {
      contract: CONTRACT,
      kind: "wasm" as const,
      instanceLiveUntil: 1_500,
      codeLiveUntil: 1_200,
    };
    expect(contractLiveness(live, 1_000)).toEqual({
      instanceTtlLedgers: 500,
      codeTtlLedgers: 200,
      instanceArchived: false,
      codeArchived: false,
    });
    // An archived entry is still returned by the RPC, with liveUntilLedgerSeq 0.
    expect(contractLiveness({ ...live, instanceLiveUntil: 0 }, 1_000)).toMatchObject({
      instanceTtlLedgers: -1_000,
      instanceArchived: true,
      codeArchived: false,
    });
    expect(contractLiveness(undefined, 1_000)).toEqual({
      instanceTtlLedgers: undefined,
      codeTtlLedgers: undefined,
      instanceArchived: false,
      codeArchived: false,
    });
  });
});

describe("planning a contract's TTL", () => {
  const liveness = (instance: number | undefined, code: number | undefined) => ({
    instanceTtlLedgers: instance,
    codeTtlLedgers: code,
    instanceArchived: instance !== undefined && instance < 0,
    codeArchived: code !== undefined && code < 0,
  });
  const options = { extendBelowLedgers: 1_000, autoRestore: true };

  it("extends once either entry falls below the threshold", () => {
    expect(planContractTtl(liveness(5_000, 5_000), options)).toEqual({ action: "none" });
    expect(planContractTtl(liveness(1_000, 5_000), options)).toEqual({ action: "none" });
    expect(planContractTtl(liveness(5_000, 999), options)).toEqual({
      action: "extend",
      lowestTtlLedgers: 999,
    });
    expect(planContractTtl(liveness(0, 5_000), options)).toEqual({ action: "extend", lowestTtlLedgers: 0 });
  });

  it("restores an archived entry only where automatic restoration is allowed", () => {
    expect(planContractTtl(liveness(-3, 5_000), options)).toEqual({ action: "restore" });
    expect(planContractTtl(liveness(5_000, -1), options)).toEqual({ action: "restore" });
    expect(planContractTtl(liveness(-3, -3), { ...options, autoRestore: false })).toEqual({
      action: "restore_required",
    });
  });

  it("reports a contract or code that is not on the network", () => {
    expect(planContractTtl(liveness(undefined, undefined), options)).toEqual({ action: "missing" });
    expect(planContractTtl(liveness(5_000, undefined), options)).toEqual({ action: "missing" });
  });
});

/** An RPC that simulates every TTL operation at `fee` stroops and confirms whatever is sent. */
class TtlServer {
  readonly simulated: Transaction[] = [];
  readonly sent: Transaction[] = [];
  status: "SUCCESS" | "FAILED" = "SUCCESS";
  simulationError: string | undefined;

  private readonly fee: number;
  private readonly maxEntryTtl: number;

  constructor(fee: number, maxEntryTtl = 3_110_400) {
    this.fee = fee;
    this.maxEntryTtl = maxEntryTtl;
  }

  getAccount(address: string) {
    return Promise.resolve(new Account(address, "41"));
  }

  /** The sponsor's XLM balance, for an account read. */
  sponsorBalance = 1_000_000_000n;

  getLedgerEntries(...keys: xdr.LedgerKey[]) {
    if (keys[0]?.switch() === xdr.LedgerEntryType.account()) {
      const account = new xdr.AccountEntry({
        accountId: keys[0].account().accountId(),
        balance: xdr.Int64.fromString(this.sponsorBalance.toString()),
        seqNum: xdr.Int64.fromString("41"),
        numSubEntries: 0,
        inflationDest: null,
        flags: 0,
        homeDomain: "",
        thresholds: Buffer.from([1, 0, 0, 0]),
        signers: [],
        ext: new xdr.AccountEntryExt(0),
      });
      return Promise.resolve({
        latestLedger: 100,
        entries: [{ key: keys[0], val: xdr.LedgerEntryData.account(account) }],
      });
    }
    const settings = new xdr.StateArchivalSettings({
      maxEntryTtl: this.maxEntryTtl,
      minTemporaryTtl: 720,
      minPersistentTtl: 120_960,
      persistentRentRateDenominator: xdr.Int64.fromString("1"),
      tempRentRateDenominator: xdr.Int64.fromString("1"),
      maxEntriesToArchive: 1,
      liveSorobanStateSizeWindowSampleSize: 1,
      liveSorobanStateSizeWindowSamplePeriod: 1,
      evictionScanSize: 1,
      startingEvictionScanLevel: 1,
    });
    return Promise.resolve({
      latestLedger: 100,
      entries: keys.map((key) => ({
        key,
        val: xdr.LedgerEntryData.configSetting(xdr.ConfigSettingEntry.configSettingStateArchival(settings)),
      })),
    });
  }

  simulateTransaction(transaction: Transaction) {
    this.simulated.push(transaction);
    if (this.simulationError !== undefined) {
      return Promise.resolve({
        id: "1",
        latestLedger: 100,
        events: [],
        _parsed: true,
        error: this.simulationError,
      });
    }
    const data = new SorobanDataBuilder(transaction.toEnvelope().v1().tx().ext().sorobanData())
      .setResourceFee(this.fee)
      .build();
    return Promise.resolve({
      id: "1",
      latestLedger: 100,
      events: [],
      _parsed: true,
      transactionData: new SorobanDataBuilder(data),
      minResourceFee: String(this.fee),
    });
  }

  sendTransaction(transaction: Transaction) {
    this.sent.push(transaction);
    return Promise.resolve({
      status: "PENDING",
      hash: transaction.hash().toString("hex"),
      latestLedger: 100,
    });
  }

  pollTransaction(_hash: string) {
    return Promise.resolve({
      status: this.status,
      ledger: 101,
      resultXdr: { feeCharged: () => xdr.Int64.fromString(String(this.fee - 7)) },
    });
  }

  asServer(): rpc.Server {
    return this as unknown as rpc.Server;
  }
}

function options(server: TtlServer, maxFeeStroops = 1_000_000) {
  return {
    server: server.asServer(),
    passphrase: Networks.TESTNET,
    sponsor,
    contract: CONTRACT,
    wasmHash: WASM_HASH,
    maxFeeStroops,
  };
}

function operationOf(transaction: Transaction): xdr.Operation {
  const [operation] = transaction.toEnvelope().v1().tx().operations();
  if (operation === undefined) throw new Error("no operation");
  return operation;
}

describe("extending and restoring a contract", () => {
  it("extends the instance and code entries read-only, paid and signed by the sponsor", async () => {
    const server = new TtlServer(40_000);
    const result = await extendContractTtl({ ...options(server), extendToLedgers: 500_000 });
    const [sent] = server.sent;
    expect(result).toEqual({
      hash: sent?.hash().toString("hex"),
      ledger: 101,
      feeChargedStroops: 39_993n,
    });
    if (sent === undefined) throw new Error("nothing sent");
    expect(sent.source).toBe(sponsor.publicKey());
    expect(sent.signatures).toHaveLength(1);
    expect(operationOf(sent).body().extendFootprintTtlOp().extendTo()).toBe(500_000);
    const footprint = sent.toEnvelope().v1().tx().ext().sorobanData().resources().footprint();
    expect(footprint.readOnly().map((key) => key.toXDR("base64"))).toEqual([
      contractInstanceKey(CONTRACT).toXDR("base64"),
      contractCodeKey(Buffer.from(WASM_HASH, "hex")).toXDR("base64"),
    ]);
    expect(footprint.readWrite()).toEqual([]);
    expect(contractFootprint({ contract: CONTRACT, wasmHash: WASM_HASH })).toHaveLength(2);
  });

  it("never extends past the network's maximum TTL", async () => {
    const server = new TtlServer(40_000, 50_000);
    await extendContractTtl({ ...options(server), extendToLedgers: 3_000_000 });
    expect(
      operationOf(server.sent[0] as Transaction)
        .body()
        .extendFootprintTtlOp()
        .extendTo(),
    ).toBe(49_999);
  });

  it("refuses to pay more than its fee ceiling, and reports a failed simulation or transaction", async () => {
    const expensive = new TtlServer(2_000_000);
    await expect(extendContractTtl({ ...options(expensive), extendToLedgers: 10 })).rejects.toThrow(
      /above the ceiling of 1000000/,
    );
    expect(expensive.sent).toEqual([]);

    const broken = new TtlServer(1_000);
    broken.simulationError = "HostError: archived";
    await expect(extendContractTtl({ ...options(broken), extendToLedgers: 10 })).rejects.toThrow(
      /did not simulate: HostError: archived/,
    );

    const failing = new TtlServer(1_000);
    failing.status = "FAILED";
    const error = await extendContractTtl({ ...options(failing), extendToLedgers: 10 }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ContractTtlError);
    expect((error as ContractTtlError).transaction).toMatch(/^[0-9a-f]{64}$/);
    await expect(extendContractTtl({ ...options(failing), extendToLedgers: 0 })).rejects.toThrow(RangeError);
  });

  it("never spends the sponsor below its reserve", async () => {
    const server = new TtlServer(40_000);
    server.sponsorBalance = 50_030_000n;
    await expect(
      extendContractTtl({ ...options(server), extendToLedgers: 10, reserveStroops: 50_000_000n }),
    ).rejects.toThrow(/below its reserve of 50000000/);
    expect(server.sent).toEqual([]);
    server.sponsorBalance = 50_040_100n;
    await extendContractTtl({ ...options(server), extendToLedgers: 10, reserveStroops: 50_000_000n });
    expect(server.sent).toHaveLength(1);
  });

  it("restores only the archived entries, read-write", async () => {
    const server = new TtlServer(30_000);
    expect(
      await restoreContract({ ...options(server), archived: { instance: false, code: false } }),
    ).toBeUndefined();
    expect(server.sent).toEqual([]);

    await restoreContract({ ...options(server), archived: { instance: true, code: false } });
    const [sent] = server.sent;
    if (sent === undefined) throw new Error("nothing sent");
    expect(operationOf(sent).body().switch()).toBe(xdr.OperationType.restoreFootprint());
    const footprint = sent.toEnvelope().v1().tx().ext().sorobanData().resources().footprint();
    expect(footprint.readWrite().map((key) => key.toXDR("base64"))).toEqual([
      contractInstanceKey(CONTRACT).toXDR("base64"),
    ]);
    expect(footprint.readOnly()).toEqual([]);
  });

  it("keeps a Stellar Asset Contract live by its instance alone", async () => {
    const server = new TtlServer(20_000);
    const { wasmHash: _none, ...asset } = options(server);
    await extendContractTtl({ ...asset, extendToLedgers: 1_000 });
    const footprint = (server.sent[0] as Transaction)
      .toEnvelope()
      .v1()
      .tx()
      .ext()
      .sorobanData()
      .resources()
      .footprint();
    expect(footprint.readOnly().map((key) => key.toXDR("base64"))).toEqual([
      contractInstanceKey(CONTRACT).toXDR("base64"),
    ]);
    await restoreContract({ ...asset, archived: { instance: true, code: true } });
    const restored = (server.sent[1] as Transaction)
      .toEnvelope()
      .v1()
      .tx()
      .ext()
      .sorobanData()
      .resources()
      .footprint();
    expect(restored.readWrite()).toHaveLength(1);
  });

  it("refuses a malformed WASM hash", async () => {
    const server = new TtlServer(1_000);
    await expect(
      extendContractTtl({ ...options(server), wasmHash: "AB".repeat(32), extendToLedgers: 10 }),
    ).rejects.toThrow(/wasmHash/);
  });
});

describe("the in-process task lock", () => {
  it("runs one task per name at a time and skips the others", async () => {
    const lock = new MemoryTaskLock();
    let release: () => void = () => undefined;
    const held = lock.run(
      "ttl",
      () =>
        new Promise<string>((resolve) => {
          release = () => {
            resolve("first");
          };
        }),
    );
    expect(await lock.run("ttl", () => Promise.resolve("second"))).toBeUndefined();
    expect(await lock.run("other", () => Promise.resolve("other"))).toBe("other");
    release();
    expect(await held).toBe("first");
    await expect(lock.run("ttl", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await lock.run("ttl", () => Promise.resolve("again"))).toBe("again");
  });
});
