/**
 * Generates the test vectors of the x402 `upto` scheme on Stellar, `upto-stellar-vectors.json`.
 * Run this file to rewrite the fixture, or with `--check` to compare it with a fresh generation.
 *
 * Everything is deterministic: fixed test-only seeds, a fixed nonce, and ed25519 signatures (which
 * are deterministic by construction). Other implementations can replay the file to check that
 * their encodings of the terms, the tree and the signature payload agree byte for byte.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Keypair, Networks, StrKey, authorizeEntry, hash, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { USDC_TESTNET_ADDRESS } from "@x402/stellar";
import {
  authorityEntry,
  authorizationPreimage,
  encodeAuthorizationEntry,
  payerInvocation,
  approveInvocation,
  settleInvokeArgs,
  termsToScVal,
  unsignedPayerEntry,
  type UptoCredential,
  type UptoTerms,
} from "../src/terms.ts";
import type { UptoCode } from "../src/errors.ts";

export const VECTORS_PATH = fileURLToPath(
  new URL("../test/fixtures/upto-stellar-vectors.json", import.meta.url),
);

const NETWORK = "stellar:testnet";
const PASSPHRASE = Networks.TESTNET;
const PAYER_SEED = Buffer.alloc(32, 1);
const AUTHORITY_SEED = Buffer.alloc(32, 2);
const RECIPIENT_SEED = Buffer.alloc(32, 3);
const OTHER_SEED = Buffer.alloc(32, 4);
const MAX_AMOUNT = 1_000_000n;
const EXPIRATION = 123_456;
const NONCE = 42n;
const MAX_TIMEOUT_SECONDS = 60;
const LEDGER_SECONDS = 5;
/** The ledger the negative vectors are checked at: within the window of `EXPIRATION`. */
const CURRENT_LEDGER = EXPIRATION - 10;

/** Test-only contract addresses, independent of any deployment so the vectors never go stale. */
const CONTRACT = StrKey.encodeContract(hash(Buffer.from("x402-upto-stellar/test-vectors/contract")));
const CONTRACT_PAYER = StrKey.encodeContract(
  hash(Buffer.from("x402-upto-stellar/test-vectors/contract-payer")),
);

const payer = Keypair.fromRawEd25519Seed(PAYER_SEED);
const authority = Keypair.fromRawEd25519Seed(AUTHORITY_SEED);
const recipient = Keypair.fromRawEd25519Seed(RECIPIENT_SEED);
const other = Keypair.fromRawEd25519Seed(OTHER_SEED);

const TERMS: UptoTerms = {
  expirationLedger: EXPIRATION,
  facilitator: authority.publicKey(),
  maxAmount: MAX_AMOUNT,
  recipient: recipient.publicKey(),
  token: USDC_TESTNET_ADDRESS,
  validAfterLedger: 0,
};

interface Requirements {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

const REQUIREMENTS: Requirements = {
  scheme: "upto",
  network: NETWORK,
  amount: MAX_AMOUNT.toString(),
  asset: USDC_TESTNET_ADDRESS,
  payTo: recipient.publicKey(),
  maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
  extra: { areFeesSponsored: true, facilitatorAddress: authority.publicKey() },
};

export interface NegativeVector {
  readonly name: string;
  readonly phase: "verify" | "settle";
  readonly payload: { authorization: string; signerAuthorizations?: string[] };
  readonly accepted: Requirements;
  readonly requirements: Requirements;
  readonly expectedCode: UptoCode;
}

async function sign(
  entry: xdr.SorobanAuthorizationEntry,
  key: Keypair = payer,
  expiration = EXPIRATION,
): Promise<xdr.SorobanAuthorizationEntry> {
  return authorizeEntry(entry, key, expiration, PASSPHRASE);
}

async function signedEntry(
  options: {
    terms?: UptoTerms;
    credential?: UptoCredential;
    key?: Keypair;
    contract?: string;
    root?: xdr.SorobanAuthorizedInvocation;
    signatureExpiration?: number;
  } = {},
): Promise<xdr.SorobanAuthorizationEntry> {
  const key = options.key ?? payer;
  const terms = options.terms ?? TERMS;
  const entry = unsignedPayerEntry({
    contract: options.contract ?? CONTRACT,
    payer: key.publicKey(),
    terms,
    nonce: NONCE,
    credential: options.credential ?? "address",
  });
  if (options.root !== undefined) entry.rootInvocation(options.root);
  return sign(entry, key, options.signatureExpiration ?? terms.expirationLedger);
}

function contractFn(
  contract: string,
  name: string,
  args: xdr.ScVal[],
  children: xdr.SorobanAuthorizedInvocation[] = [],
): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: nativeToScVal(contract, { type: "address" }).address(),
        functionName: name,
        args,
      }),
    ),
    subInvocations: children,
  });
}

function approve(
  overrides: { amount?: bigint; spender?: string; liveUntil?: number } = {},
): xdr.SorobanAuthorizedInvocation {
  return contractFn(TERMS.token, "approve", [
    nativeToScVal(payer.publicKey(), { type: "address" }),
    nativeToScVal(overrides.spender ?? CONTRACT, { type: "address" }),
    nativeToScVal(overrides.amount ?? MAX_AMOUNT, { type: "i128" }),
    xdr.ScVal.scvU32(overrides.liveUntil ?? EXPIRATION),
  ]);
}

async function arm(credential: UptoCredential) {
  const unsigned = unsignedPayerEntry({
    contract: CONTRACT,
    payer: payer.publicKey(),
    terms: TERMS,
    nonce: NONCE,
    credential,
  });
  const preimage = authorizationPreimage(unsigned, PASSPHRASE);
  const payload = hash(preimage.toXDR());
  const signed = await sign(unsigned);
  return {
    preimageXdr: preimage.toXDR("base64"),
    payloadSha256: payload.toString("hex"),
    signature: payer.sign(payload).toString("hex"),
    authorization: encodeAuthorizationEntry(signed),
  };
}

async function contractPayerArm() {
  const unsigned = unsignedPayerEntry({
    contract: CONTRACT,
    payer: CONTRACT_PAYER,
    terms: TERMS,
    nonce: NONCE,
  });
  const payload = hash(authorizationPreimage(unsigned, PASSPHRASE).toXDR());
  // A minimal ed25519 contract account: its __check_auth takes the raw 64-byte signature.
  const signed = await authorizeEntry(
    unsigned,
    () => Promise.resolve({ signatureScVal: xdr.ScVal.scvBytes(payer.sign(payload)) }),
    EXPIRATION,
    PASSPHRASE,
  );
  return {
    address: CONTRACT_PAYER,
    publicKey: payer.rawPublicKey().toString("hex"),
    payloadSha256: payload.toString("hex"),
    authorization: encodeAuthorizationEntry(signed),
    settle: [300_000n, 0n].map((amount) => ({
      amount: amount.toString(),
      invokeContractArgsXdr: settleInvokeArgs(CONTRACT, CONTRACT_PAYER, TERMS, amount).toXDR("base64"),
      authorityEntryXdr: authorityEntry(CONTRACT, CONTRACT_PAYER, TERMS, amount).toXDR("base64"),
    })),
  };
}

function withTerms(overrides: Partial<UptoTerms>): UptoTerms {
  return { ...TERMS, ...overrides };
}

async function negatives(): Promise<NegativeVector[]> {
  const base = encodeAuthorizationEntry(await signedEntry());
  const vectors: NegativeVector[] = [];
  const add = (
    name: string,
    expectedCode: UptoCode,
    authorization: string,
    options: {
      phase?: "verify" | "settle";
      requirements?: Partial<Requirements>;
      accepted?: Partial<Requirements>;
      signerAuthorizations?: string[];
    } = {},
  ) => {
    const requirements = { ...REQUIREMENTS, ...options.requirements };
    vectors.push({
      name,
      phase: options.phase ?? "verify",
      payload: {
        authorization,
        ...(options.signerAuthorizations === undefined
          ? {}
          : { signerAuthorizations: options.signerAuthorizations }),
      },
      accepted: { ...requirements, ...options.accepted },
      requirements,
      expectedCode,
    });
  };
  const entry = async (options: Parameters<typeof signedEntry>[0]) =>
    encodeAuthorizationEntry(await signedEntry(options));

  // Bound fields, each changed in the signed terms (consistently re-signed).
  add(
    "recipient",
    "invalid_upto_stellar_payload_wrong_recipient",
    await entry({ terms: withTerms({ recipient: other.publicKey() }) }),
  );
  add(
    "asset",
    "invalid_upto_stellar_payload_wrong_asset",
    await entry({ terms: withTerms({ token: CONTRACT_PAYER }) }),
  );
  add(
    "cap",
    "invalid_upto_stellar_payload_wrong_amount",
    await entry({ terms: withTerms({ maxAmount: MAX_AMOUNT - 1n }) }),
  );
  add(
    "authority",
    "invalid_upto_stellar_payload_facilitator_mismatch",
    await entry({ terms: withTerms({ facilitator: other.publicKey() }) }),
  );
  add(
    "expiration differs from the signature's",
    "invalid_upto_stellar_payload_expiration_mismatch",
    await entry({ terms: withTerms({ expirationLedger: EXPIRATION - 1 }), signatureExpiration: EXPIRATION }),
  );
  add(
    "valid after a future ledger",
    "invalid_upto_stellar_payload_not_yet_valid",
    await entry({ terms: withTerms({ validAfterLedger: CURRENT_LEDGER + 5 }) }),
  );
  add(
    "expiration beyond maxTimeoutSeconds",
    "invalid_upto_stellar_signature_expiration_too_far",
    await entry({ terms: withTerms({ expirationLedger: CURRENT_LEDGER + 100 }) }),
  );
  add(
    "expired",
    "invalid_upto_stellar_signature_expired",
    await entry({ terms: withTerms({ expirationLedger: CURRENT_LEDGER - 1 }) }),
  );
  add(
    "expires too soon",
    "invalid_upto_stellar_signature_expiration_too_soon",
    await entry({ terms: withTerms({ expirationLedger: CURRENT_LEDGER + 1 }) }),
  );

  // Operation: contract, function, arguments.
  add("contract", "invalid_upto_stellar_payload_wrong_contract", await entry({ contract: CONTRACT_PAYER }));
  const termsArg = termsToScVal(TERMS);
  add(
    "function",
    "invalid_upto_stellar_payload_wrong_function",
    await entry({ root: contractFn(CONTRACT, "settle_all", [termsArg], [approve()]) }),
  );
  add(
    "extra argument",
    "invalid_upto_stellar_payload_wrong_function",
    await entry({ root: contractFn(CONTRACT, "settle", [termsArg, xdr.ScVal.scvU32(1)], [approve()]) }),
  );
  const termsMap = termsArg.map() ?? [];
  add(
    "terms missing a key",
    "invalid_upto_stellar_payload_invalid_terms",
    await entry({ root: contractFn(CONTRACT, "settle", [xdr.ScVal.scvMap(termsMap.slice(1))], [approve()]) }),
  );
  add(
    "terms keys out of order",
    "invalid_upto_stellar_payload_invalid_terms",
    await entry({
      root: contractFn(CONTRACT, "settle", [xdr.ScVal.scvMap([...termsMap].reverse())], [approve()]),
    }),
  );
  add(
    "cap encoded as u64",
    "invalid_upto_stellar_payload_invalid_terms",
    await entry({
      root: contractFn(
        CONTRACT,
        "settle",
        [
          xdr.ScVal.scvMap(
            termsMap.map((e) =>
              e.key().sym().toString() === "max_amount"
                ? new xdr.ScMapEntry({ key: e.key(), val: nativeToScVal(MAX_AMOUNT, { type: "u64" }) })
                : e,
            ),
          ),
        ],
        [approve()],
      ),
    }),
  );

  // Tree shapes.
  const settleRoot = (children: xdr.SorobanAuthorizedInvocation[]) =>
    contractFn(CONTRACT, "settle", [termsArg], children);
  add(
    "no approve child",
    "invalid_upto_stellar_payload_invalid_authorization_tree",
    await entry({ root: settleRoot([]) }),
  );
  add(
    "two children",
    "invalid_upto_stellar_payload_invalid_authorization_tree",
    await entry({ root: settleRoot([approve(), approve()]) }),
  );
  add(
    "approve amount",
    "invalid_upto_stellar_payload_invalid_authorization_tree",
    await entry({ root: settleRoot([approve({ amount: MAX_AMOUNT + 1n })]) }),
  );
  add(
    "approve spender",
    "invalid_upto_stellar_payload_invalid_authorization_tree",
    await entry({ root: settleRoot([approve({ spender: CONTRACT_PAYER })]) }),
  );
  add(
    "approve live_until",
    "invalid_upto_stellar_payload_invalid_authorization_tree",
    await entry({ root: settleRoot([approve({ liveUntil: EXPIRATION + 1 })]) }),
  );
  const withGrandchild = approve();
  withGrandchild.subInvocations([approve()]);
  add(
    "grandchild",
    "invalid_upto_stellar_payload_invalid_authorization_tree",
    await entry({ root: settleRoot([withGrandchild]) }),
  );
  add(
    "transfer child instead of approve",
    "invalid_upto_stellar_payload_invalid_authorization_tree",
    await entry({
      root: settleRoot([
        contractFn(TERMS.token, "transfer", [
          nativeToScVal(payer.publicKey(), { type: "address" }),
          nativeToScVal(recipient.publicKey(), { type: "address" }),
          nativeToScVal(MAX_AMOUNT, { type: "i128" }),
        ]),
      ]),
    }),
  );

  // Credentials and signature.
  const sourceAccount = xdr.SorobanAuthorizationEntry.fromXDR(base, "base64");
  sourceAccount.credentials(xdr.SorobanCredentials.sorobanCredentialsSourceAccount());
  add(
    "source-account credentials",
    "invalid_upto_stellar_payload_unsupported_credential_type",
    sourceAccount.toXDR("base64"),
  );
  add(
    "unsigned",
    "invalid_upto_stellar_payload_missing_payer_signature",
    encodeAuthorizationEntry(
      unsignedPayerEntry({ contract: CONTRACT, payer: payer.publicKey(), terms: TERMS, nonce: NONCE }),
    ),
  );
  add("not base64 XDR", "invalid_upto_stellar_payload_malformed", "AAAA");
  add("oversized", "invalid_upto_stellar_payload_too_large", "A".repeat(8 * 1024 + 4));

  // Parties.
  add(
    "payer is the authority",
    "invalid_upto_stellar_payload_facilitator_is_payer",
    await entry({ key: authority }),
  );
  const selfTerms = withTerms({ recipient: payer.publicKey() });
  add("payer is payTo", "invalid_upto_stellar_payload_self_payment", await entry({ terms: selfTerms }), {
    requirements: { payTo: payer.publicKey() },
  });
  add(
    "signer authorizations for an account payer",
    "invalid_upto_stellar_payload_invalid_signer_authorization",
    base,
    { signerAuthorizations: [base] },
  );

  // Requirements.
  add("muxed payTo", "invalid_upto_stellar_payload_unsupported_recipient", base, {
    requirements: {
      payTo: StrKey.encodeMed25519PublicKey(Buffer.concat([recipient.rawPublicKey(), Buffer.alloc(8, 7)])),
    },
  });
  add("fees not sponsored", "invalid_upto_stellar_requirements_fees_not_sponsored", base, {
    requirements: { extra: { areFeesSponsored: false, facilitatorAddress: authority.publicKey() } },
  });
  add("another facilitator address", "invalid_upto_stellar_requirements_facilitator_mismatch", base, {
    requirements: { extra: { areFeesSponsored: true, facilitatorAddress: other.publicKey() } },
  });
  add("payTo is the authority", "invalid_upto_stellar_requirements_invalid_pay_to", base, {
    requirements: { payTo: authority.publicKey() },
  });
  add("verify amount differs from the cap", "invalid_upto_stellar_payload_accepted_mismatch", base, {
    requirements: { amount: "999999" },
    accepted: { amount: MAX_AMOUNT.toString() },
  });
  add("settle amount above the cap", "invalid_upto_stellar_payload_settlement_exceeds_amount", base, {
    phase: "settle",
    requirements: { amount: (MAX_AMOUNT + 1n).toString() },
    accepted: { amount: MAX_AMOUNT.toString() },
  });
  add("timeout above the policy", "invalid_upto_stellar_requirements_timeout_out_of_range", base, {
    requirements: { maxTimeoutSeconds: 3_600 },
  });
  return vectors;
}

export async function buildUptoVectors() {
  return {
    description:
      "Test vectors for the x402 upto scheme on Stellar. Seeds are test-only; the contract addresses are test-only and belong to no deployment.",
    network: NETWORK,
    networkPassphrase: PASSPHRASE,
    networkId: hash(Buffer.from(PASSPHRASE)).toString("hex"),
    seeds: {
      payer: PAYER_SEED.toString("hex"),
      authority: AUTHORITY_SEED.toString("hex"),
      recipient: RECIPIENT_SEED.toString("hex"),
      other: OTHER_SEED.toString("hex"),
    },
    payer: payer.publicKey(),
    authority: authority.publicKey(),
    recipient: recipient.publicKey(),
    contract: CONTRACT,
    token: TERMS.token,
    terms: {
      expirationLedger: TERMS.expirationLedger,
      facilitator: TERMS.facilitator,
      maxAmount: TERMS.maxAmount.toString(),
      recipient: TERMS.recipient,
      token: TERMS.token,
      validAfterLedger: TERMS.validAfterLedger,
    },
    nonce: NONCE.toString(),
    termsXdr: termsToScVal(TERMS).toXDR("base64"),
    approveInvocationXdr: approveInvocation(CONTRACT, payer.publicKey(), TERMS).toXDR("base64"),
    rootInvocationXdr: payerInvocation(CONTRACT, payer.publicKey(), TERMS).toXDR("base64"),
    credentials: { address: await arm("address"), address_v2: await arm("address_v2") },
    settle: [300_000n, 0n].map((amount) => ({
      amount: amount.toString(),
      invokeContractArgsXdr: settleInvokeArgs(CONTRACT, payer.publicKey(), TERMS, amount).toXDR("base64"),
      authorityEntryXdr: authorityEntry(CONTRACT, payer.publicKey(), TERMS, amount).toXDR("base64"),
    })),
    contractPayer: await contractPayerArm(),
    check: {
      requirements: REQUIREMENTS,
      currentLedger: CURRENT_LEDGER,
      ledgerSeconds: LEDGER_SECONDS,
    },
    negatives: await negatives(),
  };
}

export type UptoVectors = Awaited<ReturnType<typeof buildUptoVectors>>;

export async function renderUptoVectors(): Promise<string> {
  return `${JSON.stringify(await buildUptoVectors(), null, 2)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rendered = await renderUptoVectors();
  if (process.argv.includes("--check")) {
    if (readFileSync(VECTORS_PATH, "utf8") !== rendered) {
      process.stderr.write(`${VECTORS_PATH} is out of date; run this script without --check\n`);
      process.exit(1);
    }
    process.stdout.write("upto vectors are up to date\n");
  } else {
    writeFileSync(VECTORS_PATH, rendered);
    process.stdout.write(`wrote ${VECTORS_PATH}\n`);
  }
}
