import { readFileSync, readdirSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import {
  Address,
  Networks,
  buildAuthorizationEntryPreimage,
  hash,
  xdr,
  type Keypair,
} from "@stellar/stellar-sdk";
import {
  parseRegistry,
  type ClassifyContext,
  type RegistryDocument,
  type TransactionInput,
} from "../src/index.ts";

const FIXTURES = new URL("fixtures/", import.meta.url);

/** Real transactions from public ledgers, extracted from the data lake (see fixtures/README.md). */
export interface FixtureTransaction extends TransactionInput {
  readonly network: "stellar:testnet" | "stellar:pubnet";
  readonly hash: string;
}

export const TRANSACTIONS = JSON.parse(
  readFileSync(new URL("transactions.json", FIXTURES), "utf8"),
) as Record<
  | "rail402-exact"
  | "rail402-upto"
  | "rail402-exact-previous-sponsor"
  | "x402org-exact-1"
  | "x402org-exact-2"
  | "beta-exact"
  | "beta-upto",
  FixtureTransaction
>;

const LEDGERS = new URL("ledgers/testnet/", FIXTURES);
/** Testnet ledgers holding settlements through the concluded beta's contracts. */
export const BETA_LEDGERS = new URL("ledgers/testnet-beta/", FIXTURES);

/** Sequences of the committed testnet ledger slice. */
export const LEDGER_SLICE: readonly number[] = readdirSync(LEDGERS)
  .map((name) => Number(name.replace(".xdr.zst", "")))
  .sort((a, b) => a - b);

/** One committed testnet ledger, as the data lake publishes it (a zstd LedgerCloseMetaBatch). */
export function ledgerObject(sequence: number): Buffer {
  return readFileSync(new URL(`${String(sequence)}.xdr.zst`, LEDGERS));
}

export function ledgerMeta(sequence: number, folder = LEDGERS): xdr.LedgerCloseMeta {
  const batch = xdr.LedgerCloseMetaBatch.fromXDR(
    zstdDecompressSync(readFileSync(new URL(`${String(sequence)}.xdr.zst`, folder))),
  );
  const [meta] = batch.ledgerCloseMeta();
  if (meta === undefined) throw new Error("empty batch");
  return meta;
}

export const EVIDENCE = {
  url: "https://example.org/supported",
  sha256: "a".repeat(64),
  archivedAt: "2026-10-22T00:00:00Z",
  archive: `registry/evidence/${"a".repeat(64)}.json`,
};

export const ADDRESSES = {
  sponsor: "GDKMZDQWLPH466HID3JCZHV2TSPLYY2LOSQ4K2DUZTDUZQGVL6SEGH62",
  previousSponsor: "GAX6MVOC5O5VZCSCCY26RM33AKPODAEHAMUS76IT4DBAGED46VIOWEPC",
  authority: "GBAQ3BGTI3THOPSLXCAAJNHOH7LGU477RFXOQ6NVECNVOTCABEAEI6SX",
  x402orgFeeBump: "GC5OLUZ4WANPN6VT7YGTK2SRMZG762KOVKJXHWIO4K57UBASO2FMNRET",
  x402orgChannel: "GC6CSXBV4C6RL3HEDTW57KXYXSSXKAWKGYDEOSATXM3XNKXSR2VRYN3K",
  beta: "GAIWUSSOZMK4PNOUSHVTHEBND5LUSOFYLZDOIDVJBKLFEIND3M7G2ZSE",
  usdcTestnet: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  upto: "CBTVKCHLSGQ3WSV3NKSU6FZR4FZMC6ENMDMXUS5XQ66HYVUUHYE3TU7U",
  uptoWasm: "cc2d2fefe77d1a470abe88be8563679a9d40f49c127683947784c0cb2d0ca797",
  betaUpto: "CCQ3LI76R3EN7MKC7NQOW744BAJPGXWJNDWNORBX6BVFYZUYXUT2WAZJ",
} as const;

const account = (address: string, role: string, from: number, to: number | null, epoch = "2025-12-17") => ({
  address,
  role,
  epoch,
  validFromLedger: from,
  validToLedger: to,
  evidence: [EVIDENCE],
});

/** A testnet registry for tests: the hosted Rail402 sponsor rotation and the x402.org signers. */
export function testnetDocument(): RegistryDocument {
  return {
    schemaVersion: 1,
    network: "stellar:testnet",
    registryVersion: "2026-10-22.1",
    epochs: [
      { id: "2025-12-17", passphrase: Networks.TESTNET, fromLedger: 2, dataLakeFolder: "testnet/2025-12-18" },
    ],
    facilitators: [
      {
        id: "rail402",
        name: "Rail402 hosted service",
        tier: "rail402",
        sharedRelayer: false,
        accounts: [
          account(ADDRESSES.previousSponsor, "sponsor", 4_912_912, 5_315_307),
          account(ADDRESSES.sponsor, "sponsor", 5_327_208, null),
          account(ADDRESSES.authority, "upto-authority", 5_071_399, null),
        ],
      },
      {
        id: "x402-org",
        name: "x402.org facilitator",
        tier: "facilitator",
        sharedRelayer: false,
        accounts: [
          account(ADDRESSES.x402orgFeeBump, "fee-bump", 1_421_987, null),
          account(ADDRESSES.x402orgChannel, "channel", 1_421_987, null),
        ],
      },
    ],
    uptoContracts: [
      {
        contract: ADDRESSES.upto,
        wasmSha256: ADDRESSES.uptoWasm,
        epoch: "2025-12-17",
        validFromLedger: 5_071_399,
        validToLedger: null,
        rule: "R-UPTO",
        evidence: [EVIDENCE],
      },
    ],
  } as RegistryDocument;
}

export function pubnetDocument(): RegistryDocument {
  return {
    schemaVersion: 1,
    network: "stellar:pubnet",
    registryVersion: "2026-10-22.1",
    epochs: [{ id: "pubnet", passphrase: Networks.PUBLIC, fromLedger: 1, dataLakeFolder: "pubnet" }],
    facilitators: [
      {
        id: "rail402-beta",
        name: "Rail402 beta",
        tier: "rail402-beta",
        sharedRelayer: false,
        accounts: [account(ADDRESSES.beta, "sponsor", 63_000_000, 64_000_000, "pubnet")],
      },
    ],
    uptoContracts: [
      {
        contract: ADDRESSES.betaUpto,
        wasmSha256: "b".repeat(64),
        epoch: "pubnet",
        validFromLedger: 63_000_000,
        validToLedger: 64_000_000,
        rule: "R-UPTO-BETA",
        evidence: [EVIDENCE],
      },
    ],
  } as RegistryDocument;
}

export const testnet = (document = testnetDocument()): ClassifyContext => ({
  network: "stellar:testnet",
  epoch: "2025-12-17",
  passphrase: Networks.TESTNET,
  registry: parseRegistry(document),
});

export const pubnet = (document = pubnetDocument()): ClassifyContext => ({
  network: "stellar:pubnet",
  epoch: "pubnet",
  passphrase: Networks.PUBLIC,
  registry: parseRegistry(document),
});

export const contextFor = (tx: FixtureTransaction): ClassifyContext =>
  tx.network === "stellar:pubnet" ? pubnet() : testnet();

/**
 * Re-commits a successful transaction's result to edited events: recomputes the success hash of
 * contract call `index` from the meta, as the network would have for a contract that really emitted
 * them. Tests that probe a rule (not the integrity check) edit events and seal the result again.
 */
export function sealResult(resultXdr: string, meta: xdr.TransactionMeta, index = 0): string {
  const result = xdr.TransactionResult.fromXDR(resultXdr, "base64");
  const outer = result.result();
  const results =
    outer.switch() === xdr.TransactionResultCode.txFeeBumpInnerSuccess()
      ? outer.innerResultPair().result().result().results()
      : outer.results();
  const v4 = meta.v4();
  const returnValue = v4.sorobanMeta()?.returnValue() ?? xdr.ScVal.scvVoid();
  const events = v4.operations()[index]?.events() ?? [];
  const success = hash(new xdr.InvokeHostFunctionSuccessPreImage({ returnValue, events }).toXDR());
  const operation = results[index];
  if (operation === undefined) throw new Error("no operation result");
  results[index] = xdr.OperationResult.opInner(
    xdr.OperationResultTr.invokeHostFunction(xdr.InvokeHostFunctionResult.invokeHostFunctionSuccess(success)),
  );
  return result.toXDR("base64");
}

/** One `{ public_key, signature }` element of a Stellar account's authorization signature. */
export function accountSignature(publicKey: Buffer, signature: Buffer): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("public_key"), val: xdr.ScVal.scvBytes(publicKey) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("signature"), val: xdr.ScVal.scvBytes(signature) }),
  ]);
}

/** The address credentials of an `Address` or `AddressV2` authorization entry. */
export function addressCredentials(entry: xdr.SorobanAuthorizationEntry): xdr.SorobanAddressCredentials {
  const credentials = entry.credentials();
  return credentials.switch() === xdr.SorobanCredentialsType.sorobanCredentialsAddressV2()
    ? credentials.addressV2()
    : credentials.address();
}

/**
 * Signs an authorization entry in place the way a wallet does: every key signs the SDK's preimage of the
 * entry (its nonce, expiration ledger and root invocation on `passphrase`), in the given order.
 */
export function signEntry(
  entry: xdr.SorobanAuthorizationEntry,
  keys: readonly Keypair[],
  passphrase: string = Networks.TESTNET,
): void {
  const credentials = addressCredentials(entry);
  const payload = hash(
    buildAuthorizationEntryPreimage(entry, credentials.signatureExpirationLedger(), passphrase).toXDR(),
  );
  credentials.signature(
    xdr.ScVal.scvVec(keys.map((key) => accountSignature(key.rawPublicKey(), key.sign(payload)))),
  );
}

/**
 * Makes `payer` the payer of an `exact` settlement's operation and events: the transfer's `from`, the
 * authorization's address and root `from`, and the transfer event's `from` topic. The entry keeps its
 * old signature until it is signed again.
 */
export function payAs(
  op: xdr.InvokeHostFunctionOp,
  events: readonly xdr.ContractEvent[],
  payer: string,
): void {
  const from = xdr.ScVal.scvAddress(Address.fromString(payer).toScAddress());
  op.hostFunction().invokeContract().args()[0] = from;
  const [entry] = op.auth();
  if (entry === undefined) throw new Error("no authorization entry");
  addressCredentials(entry).address(Address.fromString(payer).toScAddress());
  entry.rootInvocation().function().contractFn().args()[0] = from;
  for (const event of events) {
    const topics = event.body().v0().topics();
    const [name] = topics;
    if (name?.switch() === xdr.ScValType.scvSymbol() && name.sym().toString() === "transfer")
      topics[1] = from;
  }
}
