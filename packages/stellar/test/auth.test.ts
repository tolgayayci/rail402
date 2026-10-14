import { describe, expect, it } from "vitest";
import {
  Account,
  Address,
  Keypair,
  MuxedAccount,
  Networks,
  authorizeEntry,
  hash,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import {
  I128_MAX,
  MAX_PREIMAGE_BASE64,
  PUBNET,
  TESTNET,
  decodeAuthorizationPreimage,
  decodeContractCall,
  decodeSacTransferArgs,
  networkIdFor,
  networkIdForPassphrase,
  sameBytes,
} from "@rail402.dev/stellar";
import { randomContractId } from "@rail402.dev/testkit";

const payer = Keypair.random();
const token = randomContractId();
const payTo = Keypair.random().publicKey();
const muxed = new MuxedAccount(new Account(payTo, "0"), "9").accountId();

function transferInvocation(args: xdr.ScVal[], subInvocations: xdr.SorobanAuthorizedInvocation[] = []) {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(token).toScAddress(),
        functionName: "transfer",
        args,
      }),
    ),
    subInvocations,
  });
}

const transferArgs = (to = payTo, amount = 1_234_567n) => [
  nativeToScVal(payer.publicKey(), { type: "address" }),
  nativeToScVal(to, { type: "address" }),
  nativeToScVal(amount, { type: "i128" }),
];

/** The exact base64 preimage @stellar/stellar-sdk hands a signer for this entry. */
async function preimageFor(credential: "address" | "address_v2", expiration = 1_000): Promise<string> {
  const credentials = new xdr.SorobanAddressCredentials({
    address: Address.fromString(payer.publicKey()).toScAddress(),
    nonce: xdr.Int64.fromString("77"),
    signatureExpirationLedger: 0,
    signature: xdr.ScVal.scvVoid(),
  });
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials:
      credential === "address"
        ? xdr.SorobanCredentials.sorobanCredentialsAddress(credentials)
        : xdr.SorobanCredentials.sorobanCredentialsAddressV2(credentials),
    rootInvocation: transferInvocation(transferArgs()),
  });
  let captured = "";
  await authorizeEntry(
    entry,
    (preimage) => {
      captured = preimage.toXDR("base64");
      return Promise.resolve({
        signature: payer.sign(hash(preimage.toXDR())),
        publicKey: payer.publicKey(),
      });
    },
    expiration,
    Networks.TESTNET,
  );
  return captured;
}

describe("decodeAuthorizationPreimage", () => {
  it("decodes a legacy address-credential preimage", async () => {
    const decoded = decodeAuthorizationPreimage(await preimageFor("address", 4_321));
    expect(decoded).toMatchObject({ credential: "address", nonce: 77n, signatureExpirationLedger: 4_321 });
    expect(decoded?.address).toBeUndefined();
    expect(sameBytes(decoded?.networkId ?? new Uint8Array(), networkIdFor(TESTNET))).toBe(true);
    expect(sameBytes(decoded?.networkId ?? new Uint8Array(), networkIdFor(PUBNET))).toBe(false);
  });

  it("decodes a CAP-71 preimage and the address it binds", async () => {
    const decoded = decodeAuthorizationPreimage(await preimageFor("address_v2"));
    expect(decoded).toMatchObject({ credential: "address_v2", address: payer.publicKey(), nonce: 77n });
  });

  it("returns the invocation tree that is signed", async () => {
    const decoded = decodeAuthorizationPreimage(await preimageFor("address"));
    if (decoded === undefined) throw new Error("not decoded");
    const call = decodeContractCall(decoded.invocation);
    expect(call).toMatchObject({ contract: token, fn: "transfer", subInvocations: [] });
    expect(decodeSacTransferArgs(call?.args ?? [])).toEqual({
      from: payer.publicKey(),
      to: payTo,
      amount: 1_234_567n,
    });
  });

  it("refuses other envelope types, garbage, trailing bytes and oversized input", async () => {
    const contractId = xdr.HashIdPreimage.envelopeTypeContractId(
      new xdr.HashIdPreimageContractId({
        networkId: Buffer.from(networkIdFor(TESTNET)),
        contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAsset(xdr.Asset.assetTypeNative()),
      }),
    ).toXDR("base64");
    expect(decodeAuthorizationPreimage(contractId)).toBeUndefined();
    expect(decodeAuthorizationPreimage("not base64 at all")).toBeUndefined();
    expect(decodeAuthorizationPreimage("")).toBeUndefined();
    const valid = Buffer.from(await preimageFor("address"), "base64");
    expect(
      decodeAuthorizationPreimage(Buffer.concat([valid, Buffer.alloc(4)]).toString("base64")),
    ).toBeUndefined();
    expect(decodeAuthorizationPreimage("A".repeat(MAX_PREIMAGE_BASE64 + 4))).toBeUndefined();
  });
});

describe("networkIdFor", () => {
  it("is SHA-256 of the passphrase", () => {
    expect(Buffer.from(networkIdFor(TESTNET))).toEqual(hash(Buffer.from(Networks.TESTNET)));
    expect(networkIdForPassphrase(Networks.PUBLIC)).toEqual(networkIdFor(PUBNET));
  });
});

describe("decodeContractCall", () => {
  it("is undefined for contract creation", () => {
    const create = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractHostFn(
        new xdr.CreateContractArgs({
          contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAsset(xdr.Asset.assetTypeNative()),
          executable: xdr.ContractExecutable.contractExecutableStellarAsset(),
        }),
      ),
      subInvocations: [],
    });
    expect(decodeContractCall(create)).toBeUndefined();
  });

  it("exposes sub-invocations so callers can refuse them", () => {
    const child = transferInvocation(transferArgs());
    expect(decodeContractCall(transferInvocation(transferArgs(), [child]))?.subInvocations).toHaveLength(1);
  });
});

describe("decodeSacTransferArgs", () => {
  it("accepts G, C and M destinations", () => {
    const contract = randomContractId();
    expect(decodeSacTransferArgs(transferArgs(contract))?.to).toBe(contract);
    expect(decodeSacTransferArgs(transferArgs(muxed))?.to).toBe(muxed);
  });

  it("refuses other shapes", () => {
    const [from, to, amount] = transferArgs() as [xdr.ScVal, xdr.ScVal, xdr.ScVal];
    expect(decodeSacTransferArgs([from, to])).toBeUndefined();
    expect(decodeSacTransferArgs([from, to, amount, amount])).toBeUndefined();
    expect(decodeSacTransferArgs([from, to, nativeToScVal(5n, { type: "i64" })])).toBeUndefined();
    expect(decodeSacTransferArgs([to, nativeToScVal("x", { type: "symbol" }), amount])).toBeUndefined();
    expect(decodeSacTransferArgs(transferArgs(payTo, 0n))).toBeUndefined();
    expect(decodeSacTransferArgs(transferArgs(payTo, -1n))).toBeUndefined();
    expect(decodeSacTransferArgs(transferArgs(payTo, I128_MAX))?.amount).toBe(I128_MAX);
    // A muxed source is not a valid `from`.
    const muxedFrom = nativeToScVal(muxed, { type: "address" });
    expect(decodeSacTransferArgs([muxedFrom, to, amount])).toBeUndefined();
  });
});

describe("sameBytes", () => {
  it("compares length and content", () => {
    expect(sameBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(sameBytes(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(sameBytes(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });
});
