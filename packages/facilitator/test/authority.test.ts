import { hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Keypair, xdr, type rpc } from "@stellar/stellar-sdk";
import {
  authorityStatus,
  createStellarFacilitator,
  MemorySettlementLedger,
  deriveAuthorityKeypair,
  deriveChannelKeypairs,
} from "@rail402.dev/facilitator";
import { UPTO_TESTNET_DEPLOYMENT } from "@rail402.dev/upto";
import { CONTRACT, FakeServer } from "./upto-helpers.ts";

const sponsor = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7));

describe("the upto settlement authority", () => {
  it("is HKDF-SHA256 of the sponsor secret with the upto-authority salt and the network as info", () => {
    const expected = Keypair.fromRawEd25519Seed(
      Buffer.from(
        hkdfSync("sha256", sponsor.rawSecretKey(), "rail402/upto-authority", "stellar:testnet", 32),
      ),
    );
    expect(deriveAuthorityKeypair(sponsor, "stellar:testnet").publicKey()).toBe(expected.publicKey());
  });

  it("is stable per sponsor and network, and distinct from the sponsor and every channel", () => {
    const testnet = deriveAuthorityKeypair(sponsor, "stellar:testnet").publicKey();
    expect(deriveAuthorityKeypair(sponsor, "stellar:testnet").publicKey()).toBe(testnet);
    expect(deriveAuthorityKeypair(sponsor, "stellar:pubnet").publicKey()).not.toBe(testnet);
    const otherSponsor = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 8));
    expect(deriveAuthorityKeypair(otherSponsor, "stellar:testnet").publicKey()).not.toBe(testnet);
    expect(testnet).not.toBe(sponsor.publicKey());
    const channels = deriveChannelKeypairs(sponsor, "stellar:testnet", 64).map((key) => key.publicKey());
    expect(channels).not.toContain(testnet);
  });

  it("refuses an empty network", () => {
    expect(() => deriveAuthorityKeypair(sponsor, "")).toThrow(RangeError);
  });

  it("reports whether the account exists and what it holds", async () => {
    const server = new FakeServer();
    const address = deriveAuthorityKeypair(sponsor, "stellar:testnet").publicKey();
    expect(await authorityStatus(server.asServer(), address)).toEqual({
      address,
      exists: true,
      balanceStroops: 0n,
      spendableStroops: 0n,
    });
    server.accounts = new Set();
    expect(await authorityStatus(server.asServer(), address)).toEqual({
      address,
      exists: false,
      balanceStroops: 0n,
      spendableStroops: 0n,
    });
  });

  it("counts as spendable only the XLM beyond the reserves the account pays itself", async () => {
    const address = deriveAuthorityKeypair(sponsor, "stellar:testnet").publicKey();
    const status = (account: xdr.AccountEntry) =>
      authorityStatus(
        {
          getLedgerEntries: () =>
            Promise.resolve({ entries: [{ val: xdr.LedgerEntryData.account(account) }], latestLedger: 1 }),
        } as unknown as rpc.Server,
        address,
      );
    // Two base reserves (1 XLM) are its own when nobody sponsors them.
    expect(await status(accountEntry(address, 12_500_000n))).toMatchObject({
      balanceStroops: 12_500_000n,
      spendableStroops: 2_500_000n,
    });
    // Provisioned: both reserves sponsored, so every stroop it holds is spendable.
    expect(await status(accountEntry(address, 300n, { sponsored: 2 }))).toMatchObject({
      spendableStroops: 300n,
    });
    expect(await status(accountEntry(address, 0n, { sponsored: 2 }))).toMatchObject({ spendableStroops: 0n });
    // A trustline adds a reserve; selling liabilities are locked too.
    expect(
      await status(accountEntry(address, 20_000_000n, { subEntries: 1, sellingLiabilities: 1_000n })),
    ).toMatchObject({ spendableStroops: 4_999_000n });
  });
});

describe("a facilitator with upto", () => {
  const base = {
    rpcUrl: "https://soroban-testnet.stellar.org",
    sponsorSecret: sponsor.secret(),
    channelCount: 2,
  };

  it("registers upto next to exact with the canonical testnet contract and the derived authority", () => {
    const facilitator = createStellarFacilitator({
      networks: [{ ...base, network: "stellar:testnet", upto: {} }],
    });
    const authority = deriveAuthorityKeypair(sponsor, "stellar:testnet").publicKey();
    const supported = facilitator.core.getSupported();
    expect(supported.kinds).toEqual([
      { x402Version: 2, scheme: "exact", network: "stellar:testnet", extra: { areFeesSponsored: true } },
      {
        x402Version: 2,
        scheme: "upto",
        network: "stellar:testnet",
        extra: { areFeesSponsored: true, facilitatorAddress: authority },
      },
    ]);
    expect(supported.signers["stellar:*"]).toContain(authority);
    expect(facilitator.networks.get("stellar:testnet")?.upto).toEqual({
      authorityAddress: authority,
      policy: {
        contract: UPTO_TESTNET_DEPLOYMENT.address,
        contractWasmHash: UPTO_TESTNET_DEPLOYMENT.wasmHash,
        zeroSettlement: "onchain",
        maxTransactionFeeStroops: 500_000,
        // Read from the network's own RPC.
        ledgerSeconds: expect.any(Function) as unknown,
      },
    });
  });

  it("leaves upto and the authority out unless configured", () => {
    const facilitator = createStellarFacilitator({ networks: [{ ...base, network: "stellar:testnet" }] });
    expect(facilitator.core.getSupported().kinds.map((kind) => kind.scheme)).toEqual(["exact"]);
    const runtime = facilitator.networks.get("stellar:testnet");
    expect(runtime?.upto).toBeUndefined();
    expect(
      runtime?.engine.facilitatorAddresses.has(
        deriveAuthorityKeypair(sponsor, "stellar:testnet").publicKey(),
      ),
    ).toBe(false);
  });

  it("uses an operator's own contract without assuming the canonical WASM", () => {
    const facilitator = createStellarFacilitator({
      networks: [
        {
          ...base,
          network: "stellar:testnet",
          ledger: new MemorySettlementLedger(),
          upto: { contract: CONTRACT, zeroSettlement: "offchain", maxTransactionFeeStroops: 700_000 },
        },
      ],
    });
    expect(facilitator.networks.get("stellar:testnet")?.upto?.policy).toMatchObject({
      contract: CONTRACT,
      contractWasmHash: undefined,
      zeroSettlement: "offchain",
      maxTransactionFeeStroops: 700_000,
    });
  });

  it("refuses a network without a canonical contract, and malformed settings", () => {
    const pubnet = { ...base, network: "stellar:pubnet" as const };
    expect(() => createStellarFacilitator({ networks: [{ ...pubnet, upto: {} }] })).toThrow(/configure one/);
    expect(() =>
      createStellarFacilitator({
        networks: [{ ...base, network: "stellar:testnet", upto: { contract: "CBAD" } }],
      }),
    ).toThrow(/C… address/);
    expect(() =>
      createStellarFacilitator({
        networks: [{ ...base, network: "stellar:testnet", upto: { contractWasmHash: "XYZ" } }],
      }),
    ).toThrow(/hex/);
    expect(() =>
      createStellarFacilitator({
        networks: [{ ...base, network: "stellar:testnet", upto: { maxTransactionFeeStroops: 50 } }],
      }),
    ).toThrow(/inclusion fee/);
    // An off-chain zero lives only in the settlement ledger: the default in-memory one is not chosen
    // implicitly for it.
    expect(() =>
      createStellarFacilitator({
        networks: [{ ...base, network: "stellar:testnet", upto: { zeroSettlement: "offchain" } }],
      }),
    ).toThrow(/needs an explicit settlement ledger/);
    expect(() =>
      createStellarFacilitator({
        networks: [{ ...base, network: "stellar:testnet", policy: { expirationMarginLedgers: 0 } }],
      }),
    ).toThrow(/expirationMarginLedgers must be an integer of at least 1/);
  });
});

function accountEntry(
  address: string,
  balance: bigint,
  options: { sponsored?: number; subEntries?: number; sellingLiabilities?: bigint } = {},
): xdr.AccountEntry {
  const liabilities = new xdr.Liabilities({
    buying: xdr.Int64.fromString("0"),
    selling: xdr.Int64.fromString(String(options.sellingLiabilities ?? 0n)),
  });
  const v2 = new xdr.AccountEntryExtensionV2({
    numSponsored: options.sponsored ?? 0,
    numSponsoring: 0,
    signerSponsoringIDs: [],
    ext: new xdr.AccountEntryExtensionV2Ext(0),
  });
  return new xdr.AccountEntry({
    accountId: Keypair.fromPublicKey(address).xdrAccountId(),
    balance: xdr.Int64.fromString(String(balance)),
    seqNum: xdr.Int64.fromString("1"),
    numSubEntries: options.subEntries ?? 0,
    inflationDest: null,
    flags: 0,
    homeDomain: "",
    thresholds: Buffer.from([1, 0, 0, 0]),
    signers: [],
    ext: new xdr.AccountEntryExt(
      1,
      new xdr.AccountEntryExtensionV1({ liabilities, ext: new xdr.AccountEntryExtensionV1Ext(2, v2) }),
    ),
  });
}
