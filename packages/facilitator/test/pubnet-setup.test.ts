import { describe, expect, it } from "vitest";
import { Keypair, xdr, type rpc } from "@stellar/stellar-sdk";
import { USDC } from "@rail402.dev/stellar";
import {
  FacilitatorSetupError,
  MemorySettlementLedger,
  SponsorBudget,
  acceptedAsset,
  UptoContractCheckError,
  assertUptoContract,
  createStellarFacilitator,
  type NetworkSetup,
} from "@rail402.dev/facilitator";

const CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const ledger = new MemorySettlementLedger();
const pubnet: NetworkSetup = {
  network: "stellar:pubnet",
  rpcUrl: "https://mainnet.example/rpc",
  sponsorSecret: Keypair.random().secret(),
  channelCount: 1,
  assets: [acceptedAsset(USDC["stellar:pubnet"], { minAmount: 10_000n })],
  policy: { maxTransactionFeeStroops: 300_000, inclusionFeeStroops: 200 },
  guard: new SponsorBudget({
    network: "stellar:pubnet",
    ledger,
    balance: () => 0n,
    minBalanceStroops: 0n,
    refuseWhileUnknown: true,
  }),
};
const build = (setup: NetworkSetup) => () => createStellarFacilitator({ networks: [setup] });

/** The stable code a setup is refused with. */
function refusedWith(setup: NetworkSetup): string {
  try {
    build(setup)();
  } catch (error) {
    expect(error).toBeInstanceOf(FacilitatorSetupError);
    expect((error as FacilitatorSetupError).message).not.toBe("");
    return (error as FacilitatorSetupError).code;
  }
  throw new Error("the setup was accepted");
}

describe("an in-process facilitator on pubnet", () => {
  it("starts with a guard, explicit fee ceilings and an inclusion floor of at least 200", () => {
    expect(build(pubnet)).not.toThrow();
  });

  it("refuses to run without a guard unless told to run unguarded", () => {
    const { guard: _guard, ...unguarded } = pubnet;
    expect(build(unguarded)).toThrow(/guard .* is required, or unguarded: true/);
    expect(refusedWith(unguarded)).toBe("config_pubnet_guard_missing");
    expect(build({ ...unguarded, unguarded: true })).not.toThrow();
  });

  it("refuses pubnet without explicit accepted assets, where testnet defaults to USDC", () => {
    const { assets: _assets, ...defaulted } = pubnet;
    expect(build(defaulted)).toThrow(/assets is required/);
    expect(refusedWith(defaulted)).toBe("config_pubnet_assets_missing");
    expect(refusedWith({ ...pubnet, assets: [] })).toBe("config_pubnet_assets_missing");
    const testnet = createStellarFacilitator({
      networks: [
        {
          network: "stellar:testnet",
          rpcUrl: "https://testnet.example/rpc",
          sponsorSecret: pubnet.sponsorSecret,
          channelCount: 1,
        },
      ],
    });
    expect([...(testnet.networks.get("stellar:testnet")?.policy.assets.keys() ?? [])]).toEqual([
      USDC["stellar:testnet"].contract,
    ]);
  });

  it.each([
    ["stellar:testnet", "https://testnet.example/rpc"],
    ["stellar:pubnet", pubnet.rpcUrl],
  ] as const)("refuses %s without a sponsor seed or an RPC URL", (network, rpcUrl) => {
    const setup = { ...pubnet, network, rpcUrl };
    expect(refusedWith({ ...setup, sponsorSecret: "" })).toBe("config_sponsor_secret_missing");
    expect(refusedWith({ ...setup, sponsorSecret: undefined as unknown as string })).toBe(
      "config_sponsor_secret_missing",
    );
    expect(refusedWith({ ...setup, rpcUrl: "" })).toBe("config_rpc_missing");
    expect(refusedWith({ ...setup, rpcUrl: undefined as unknown as string })).toBe("config_rpc_missing");
  });

  it("refuses a pubnet RPC without https", () => {
    expect(refusedWith({ ...pubnet, rpcUrl: "http://mainnet.example/rpc" })).toBe(
      "config_pubnet_rpc_insecure",
    );
  });

  it("refuses pubnet without explicit fee ceilings and an inclusion floor of at least 200", () => {
    expect(build({ ...pubnet, policy: { inclusionFeeStroops: 200 } })).toThrow(
      /maxTransactionFeeStroops is required/,
    );
    expect(build({ ...pubnet, policy: { maxTransactionFeeStroops: 300_000 } })).toThrow(
      /inclusionFeeStroops is required/,
    );
    expect(refusedWith({ ...pubnet, policy: { inclusionFeeStroops: 200 } })).toBe(
      "config_pubnet_fee_ceiling_missing",
    );
    expect(refusedWith({ ...pubnet, policy: { maxTransactionFeeStroops: 300_000 } })).toBe(
      "config_pubnet_fee_ceiling_missing",
    );
    expect(
      build({ ...pubnet, policy: { maxTransactionFeeStroops: 300_000, inclusionFeeStroops: 100 } }),
    ).toThrow(/below 200/);
    expect(
      refusedWith({ ...pubnet, policy: { maxTransactionFeeStroops: 300_000, inclusionFeeStroops: 100 } }),
    ).toBe("config_pubnet_inclusion_floor_too_low");
    expect(build({ ...pubnet, inclusionFee: { floor: 150, cap: 1_000, percentile: "p90" } })).toThrow(
      /below 200/,
    );
    expect(
      build({
        ...pubnet,
        policy: { maxTransactionFeeStroops: 300_000, inclusionFeeStroops: 100 },
        allowInclusionFeeBelowFloor: true,
      }),
    ).not.toThrow();
    expect(
      build({ ...pubnet, ledger, upto: { contract: CONTRACT, contractWasmHash: "ab".repeat(32) } }),
    ).toThrow(/upto.maxTransactionFeeStroops is required/);
    expect(
      refusedWith({ ...pubnet, ledger, upto: { contract: CONTRACT, contractWasmHash: "ab".repeat(32) } }),
    ).toBe("config_pubnet_fee_ceiling_missing");
    expect(build({ ...pubnet, upto: { contract: CONTRACT, maxTransactionFeeStroops: 500_000 } })).toThrow(
      /contractWasmHash is required/,
    );
  });
});

describe("assertUptoContract", () => {
  const instance = (hash: string) =>
    ({
      getLedgerEntries: (...keys: xdr.LedgerKey[]) =>
        Promise.resolve({
          latestLedger: 100,
          entries: keys
            .filter((key) => key.switch() === xdr.LedgerEntryType.contractData())
            .map((key) => ({
              key,
              liveUntilLedgerSeq: 500,
              val: xdr.LedgerEntryData.contractData(
                new xdr.ContractDataEntry({
                  ext: new xdr.ExtensionPoint(0),
                  contract: key.contractData().contract(),
                  key: xdr.ScVal.scvLedgerKeyContractInstance(),
                  durability: xdr.ContractDataDurability.persistent(),
                  val: xdr.ScVal.scvContractInstance(
                    new xdr.ScContractInstance({
                      executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(hash, "hex")),
                      storage: null,
                    }),
                  ),
                }),
              ),
            })),
        }),
    }) as unknown as rpc.Server;
  const absent = {
    getLedgerEntries: () => Promise.resolve({ latestLedger: 100, entries: [] }),
  } as unknown as rpc.Server;

  it("accepts the configured WASM and refuses an absent contract or other code", async () => {
    await expect(
      assertUptoContract(instance("ab".repeat(32)), CONTRACT, "AB".repeat(32)),
    ).resolves.toBeUndefined();
    await expect(
      assertUptoContract(instance("cd".repeat(32)), CONTRACT, "ab".repeat(32)),
    ).rejects.toMatchObject({ reason: "wasm_mismatch" });
    const error = await assertUptoContract(absent, CONTRACT, "ab".repeat(32)).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(UptoContractCheckError);
    expect((error as UptoContractCheckError).reason).toBe("absent");
  });
});
