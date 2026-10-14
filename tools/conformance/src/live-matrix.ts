/**
 * Live facilitator matrix: every documented facilitator behaviour exercised over HTTP against a
 * deployed Rail402, on the public Stellar testnet, in Circle USDC. No API key is sent.
 *
 *   node tools/conformance/src/live-matrix.ts --facilitator https://… [--scheme exact,upto] [--asset usdc] \
 *     [--only id,id] [--write [--allow-branch <branch>]]
 *
 * Covers G… and C… payers, a C… payTo, 7-decimal SEP-41 amounts down to one base unit, missing
 * trustlines on either side, insufficient balance, expired and about-to-expire authorizations, the
 * expiry window the stock client derives from maxTimeoutSeconds, tampering, replay and idempotency
 * (sequential, concurrent and after the authorization expired), and requests the service must refuse
 * before touching the chain.
 * `upto` cases (`--scheme upto`) pay with `@rail402.dev/upto`'s client and settle zero, part and all of
 * the cap from a G… payer and from a smart account (C…), refuse a charge above the cap, let a smart
 * account's own spending limit refuse a cap above it, settle one authorization sent five times at once
 * exactly once, answer a repeat for another amount as a conflict, and hold the expiry window the
 * client derives from maxTimeoutSeconds.
 * Every settlement is checked on chain: the payer is debited, payTo is credited, one transfer event
 * moves the funds, and the facilitator's accounts only pay the network fee. Every rejection must
 * carry a registered code and a non-empty reason. Fresh accounts are created for each run, so the
 * script needs no secrets. With --write the run is recorded as schemaVersion 2 evidence.
 */
import { parseArgs } from "node:util";
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import {
  Address,
  Asset,
  FeeBumpTransaction,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import { createEd25519Signer, getEstimatedLedgerCloseTimeSeconds } from "@x402/stellar";
import { ExactStellarScheme as ExactStellarClient } from "@x402/stellar/exact/client";
import { inspectUptoAuthorization, resolveUptoContract } from "@rail402.dev/upto";
import { UptoStellarScheme as UptoStellarClient } from "@rail402.dev/upto/client";
import {
  LocalNetwork,
  addOzContextRule,
  buildTransfer,
  deployOzSmartAccount,
  deploySimpleAccount,
  deploySpendingLimitPolicy,
  ozSmartAccountSigner,
  requirementsFor,
  simpleAccountSigner,
  smartAccountPayment,
  spendingLimitParams,
  type EntrySigner,
  type PaymentRequirementsLike,
} from "@rail402.dev/testkit";
import { sacTransferEvents } from "@rail402.dev/stellar";
import {
  NETWORK,
  TESTNET_FRIENDBOT_URL,
  TESTNET_RPC_URL,
  Treasury,
  USDC_TESTNET_ADDRESS,
  gitCommit,
  log,
  usdcPayment,
  versions,
} from "./testnet.ts";
import { harnessProvenance, recheckProvenance, writeEvidence, type CheckId } from "./evidence.ts";
import { decodeBase64Json } from "./forwarder.ts";
import {
  CaseRecorder,
  buildEvidence,
  readTarget,
  settledTransaction,
  supportedSigners,
  type CaseContext,
  type CaseSpec,
} from "./harness.ts";

const { values: args } = parseArgs({
  options: {
    facilitator: { type: "string", default: "http://localhost:8080" },
    rpc: { type: "string", default: TESTNET_RPC_URL },
    friendbot: { type: "string", default: TESTNET_FRIENDBOT_URL },
    scheme: { type: "string", default: "exact" },
    asset: { type: "string", default: "usdc" },
    only: { type: "string" },
    write: { type: "boolean", default: false },
    "allow-branch": { type: "string" },
  },
});

// Rail402 settles `exact` and `upto` in USDC here; anything else is refused before any funds are spent.
const SCHEMES = [...new Set(args.scheme.split(",").map((scheme) => scheme.trim()))];
if (SCHEMES.length === 0 || SCHEMES.some((scheme) => scheme !== "exact" && scheme !== "upto")) {
  throw new Error(`--scheme ${args.scheme}: expected exact, upto or both`);
}
if (args.asset.toLowerCase() !== "usdc") throw new Error(`--asset ${args.asset}: only usdc is supported`);

// Evidence is recorded only from a clean commit on main, checked before any testnet funds are spent.
const provenance = args.write ? harnessProvenance({ allowBranch: args["allow-branch"] }) : undefined;

const FACILITATOR = args.facilitator.replace(/\/+$/, "");
const net = new LocalNetwork(args.rpc, args.friendbot);
/** Each payer starts with 2 USDC, in base units. */
const STARTING_USDC = 20_000_000n;

// ---------------------------------------------------------------------------------------------
// Results

const recorder = new CaseRecorder(args.only?.split(",").map((id) => id.trim()));
let current: CaseContext | undefined;

/** Runs one case; `call`, `settleAndProve` and `observe` record into it while it runs. */
async function check(
  id: string,
  title: string,
  checks: readonly CheckId[],
  run: () => Promise<void>,
  parties: Pick<CaseSpec, "payer" | "payTo"> = { payer: "G", payTo: "G" },
  scheme: "exact" | "upto" = "exact",
): Promise<void> {
  const spec: CaseSpec = { id, title, checks, scheme, asset: "USDC", ...parties };
  await recorder.run(spec, async (context) => {
    current = context;
    try {
      await run();
    } finally {
      current = undefined;
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Facilitator HTTP

type Payload = Awaited<ReturnType<LocalNetwork["payment"]>> | Record<string, unknown>;

interface VerifyBody {
  isValid: boolean;
  payer?: string;
  invalidReason?: string;
  invalidMessage?: string;
}
interface SettleBody {
  success: boolean;
  transaction: string;
  network: string;
  payer?: string;
  amount?: string;
  errorReason?: string;
  errorMessage?: string;
}

type Outcome = Partial<VerifyBody> & Partial<SettleBody>;

async function call(operation: "verify" | "settle", body: unknown, contentType = "application/json") {
  const response = await fetch(`${FACILITATOR}/${operation}`, {
    method: "POST",
    headers: { "content-type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const parsed = (await response.json()) as Outcome;
  const code = parsed.invalidReason ?? parsed.errorReason;
  const failed = operation === "verify" ? parsed.isValid !== true : parsed.success !== true;
  if (failed) {
    // Every rejection: a spec-shaped body with a registered code and a non-empty reason.
    const reason = parsed.invalidMessage ?? parsed.errorMessage ?? "";
    ok(typeof code === "string" && /^[a-z0-9_]+$/.test(code), `${operation}: rejection without a code`);
    ok(reason.trim() !== "", `${operation}: rejection ${code} has an empty reason`);
    if (operation === "verify") strictEqual(parsed.isValid, false);
    else strictEqual(parsed.success, false);
    current?.rejection({
      surface: "facilitator",
      operation: `POST /${operation}`,
      httpStatus: response.status,
      code,
      reason,
    });
  }
  return {
    status: response.status,
    body: parsed,
    extensions: decodeBase64Json(response.headers.get("extension-responses")) as
      { rail402?: { settlement?: { repeat?: boolean; settledBy?: string } } } | undefined,
  };
}

type Requirements = PaymentRequirementsLike | UptoRequirements | Record<string, unknown>;

const verify = (payload: Payload, requirements: Requirements) =>
  call("verify", { x402Version: 2, paymentPayload: payload, paymentRequirements: requirements });
const settle = (payload: Payload, requirements: Requirements) =>
  call("settle", { x402Version: 2, paymentPayload: payload, paymentRequirements: requirements });

async function expectRejected(
  operation: "verify" | "settle",
  payload: Payload,
  requirements: Requirements,
  codes: string[],
) {
  const { body } = await (operation === "verify" ? verify : settle)(payload, requirements);
  const code = body.invalidReason ?? body.errorReason ?? "";
  ok(
    codes.includes(code),
    `${operation}: expected ${codes.join(" | ")}, got ${code || JSON.stringify(body)}`,
  );
  if (operation === "settle") strictEqual(body.transaction, "", "a refused settlement names no transaction");
}

// ---------------------------------------------------------------------------------------------
// Chain helpers

let treasury: Treasury;

const balance = (holder: string) => net.tokenBalance(USDC_TESTNET_ADDRESS, holder);

const pay = (payer: Keypair, payTo: string, amount: bigint, expirationLedger?: number) =>
  usdcPayment(net, payer, payTo, amount, expirationLedger);

/** A transfer built offline and signed by the payer, for payers the client could not simulate. */
const offline = async (payer: Keypair, payTo: string, amount: bigint) => {
  const built = await buildTransfer({
    payer,
    asset: USDC_TESTNET_ADDRESS,
    to: payTo,
    amount,
    nonce: BigInt(Math.floor(Math.random() * 2 ** 40)),
    expirationLedger: (await net.latestLedger()) + 10,
  });
  const requirements = requirementsFor(USDC_TESTNET_ADDRESS, payTo, amount);
  const payload = {
    x402Version: 2,
    resource: { url: "https://seller.example/resource" },
    accepted: requirements,
    payload: { transaction: built.xdr },
  };
  return { payload, requirements };
};

/**
 * Settles over HTTP and proves the outcome on chain: one transfer event payer → payTo for the exact
 * amount, balances moved by exactly that amount, the fee paid by a facilitator signer that is
 * neither party, and no facilitator account holding or moving the asset.
 */
async function settleAndProve(
  payload: Payload,
  requirements: PaymentRequirementsLike | UptoRequirements,
  payer: string,
  /** For `upto`: the requirements with the cap, which verify checks; settle uses `requirements`. */
  published: PaymentRequirementsLike | UptoRequirements = requirements,
) {
  const { payTo, scheme } = requirements;
  const amount = BigInt(requirements.amount);
  const before = { payer: await balance(payer), payTo: await balance(payTo) };
  const signersBefore = await signerBalances();

  const verified = await verify(payload, published);
  deepStrictEqual(verified.body, { isValid: true, payer });
  const settled = await settle(payload, requirements);
  strictEqual(settled.status, 200);
  strictEqual(settled.body.success, true, `settle failed: ${JSON.stringify(settled.body)}`);
  strictEqual(settled.body.network, NETWORK);
  strictEqual(settled.body.payer, payer);
  const hash = settled.body.transaction ?? "";
  ok(/^[0-9a-f]{64}$/.test(hash), "settlement names its transaction");
  if (scheme === "upto")
    strictEqual(settled.body.amount, amount.toString(), "the settlement names the amount");

  const onChain = await net.server.getTransaction(hash);
  if (onChain.status !== rpc.Api.GetTransactionStatus.SUCCESS)
    throw new Error(`${hash} is ${onChain.status}`);
  const fee = onChain.resultXdr.feeCharged().toBigInt();
  current?.transaction(
    await settledTransaction(net, hash, {
      scheme,
      asset: USDC_TESTNET_ADDRESS,
      decimals: 7,
      amount,
      payerType: payer.startsWith("C") ? "C" : "G",
    }),
  );

  // Who paid and who sourced: a fee bump by one facilitator signer around a channel's transaction.
  const envelope = TransactionBuilder.fromXDR(onChain.envelopeXdr.toXDR("base64"), net.passphrase);
  ok(envelope instanceof FeeBumpTransaction, "settlement is a fee bump");
  const feeSource = envelope.feeSource;
  const channel = envelope.innerTransaction.source;
  ok(signers.has(feeSource), `fee source ${feeSource} is not a facilitator signer`);
  ok(signers.has(channel), `transaction source ${channel} is not a facilitator signer`);
  ok(feeSource !== payer && channel !== payer && feeSource !== payTo && channel !== payTo);

  // Exactly one transfer, payer → payTo, for the exact amount of the required asset (none when an
  // upto payment settles zero).
  const transfers = sacTransferEvents(onChain);
  deepStrictEqual(
    transfers,
    amount === 0n ? [] : [{ contract: USDC_TESTNET_ADDRESS, from: payer, to: payTo, amount }],
    "one transfer event for the amount",
  );

  // Balances: payer debited, payTo credited, facilitator accounts hold none of the asset.
  strictEqual(await balance(payer), before.payer - amount, "payer debited by the amount");
  strictEqual(await balance(payTo), before.payTo + amount, "payTo credited with the amount");
  strictEqual(await balance(feeSource), 0n, "fee sponsor holds no USDC");
  strictEqual(await balance(channel), 0n, "channel holds no USDC");

  // The facilitator's only cost is the fee, charged to the sponsor; every other signer is untouched.
  // (Read from balances: exact while no other settlement runs on the service at the same time.)
  const signersAfter = await signerBalances();
  for (const [signer, xlm] of signersAfter) {
    const expected = (signersBefore.get(signer) ?? 0n) - (signer === feeSource ? fee : 0n);
    strictEqual(xlm, expected, `${signer === feeSource ? "sponsor" : "signer"} ${signer} XLM`);
  }
  return { hash, fee };
}

/** Native XLM of every facilitator signer, in stroops. */
async function signerBalances(): Promise<Map<string, bigint>> {
  const entries = await Promise.all(
    [...signers].map(async (signer) => [signer, await net.nativeBalance(signer)] as const),
  );
  return new Map(entries);
}

// ---------------------------------------------------------------------------------------------

let signers = new Set<string>();

async function main() {
  const target = await readTarget(FACILITATOR);
  log(`facilitator ${FACILITATOR} (version ${target.healthVersion})`);
  signers = new Set(supportedSigners(target.supported));
  if (signers.size === 0) throw new Error("cannot continue without the facilitator's signers");

  await check(
    "supported",
    "/supported: stellar:testnet, exact, extra.areFeesSponsored true",
    ["supported", "fees-sponsored"],
    async () => {
      const response = await fetch(`${FACILITATOR}/supported`);
      strictEqual(response.status, 200);
      const body = (await response.json()) as {
        kinds: unknown[];
        extensions: string[];
        signers: Record<string, string[]>;
      };
      deepStrictEqual(
        body.kinds.find((kind) => (kind as { scheme?: unknown }).scheme === "exact"),
        { x402Version: 2, scheme: "exact", network: NETWORK, extra: { areFeesSponsored: true } },
      );
      ok(
        body.kinds.every((kind) => ["exact", "upto"].includes(String((kind as { scheme?: unknown }).scheme))),
        "only exact and upto are advertised",
      );
      ok(body.extensions.includes("bazaar"));
      deepStrictEqual(new Set(body.signers["stellar:*"] ?? []), signers);
      ok(signers.size >= 2, "sponsor and channel signers advertised");
    },
    {},
  );

  const exactRun = SCHEMES.includes("exact");
  // Exact payers hold 2 USDC each; upto payers and smart accounts 1 each; the seller 2.
  const usdc = String((exactRun ? 40 : 0) + (SCHEMES.includes("upto") ? 12 : 0));
  log(`opening a treasury: Friendbot XLM, then ${usdc} USDC from the testnet XLM/USDC pool`);
  treasury = await new Treasury(net).open(usdc);
  const [seller] = (await treasury.accounts(1, "2")) as [Keypair];
  if (exactRun) await exactCases(seller);
  if (SCHEMES.includes("upto")) await uptoCases(target.supported, seller);

  // ---------------------------------------------------------------------------------------------
  const evidence = buildEvidence(
    {
      kind: "live-matrix",
      // Without --write the document is printed only; its commit may then describe a dirty tree.
      provenance: provenance ?? { commit: gitCommit().replace(/-dirty$/, ""), dirty: false },
      network: NETWORK,
      target,
      packages: versions([
        "@x402/core",
        "@x402/stellar",
        "@stellar/stellar-sdk",
        ...(SCHEMES.includes("upto") ? ["@rail402.dev/upto"] : []),
      ]),
      command: `node tools/conformance/src/live-matrix.ts --facilitator ${FACILITATOR} --scheme ${SCHEMES.join(",")} --asset usdc`,
      config: { apiKey: "none", scheme: SCHEMES.join(","), asset: USDC_TESTNET_ADDRESS },
      accounts: { payTo: seller.publicKey(), treasury: treasury.keypair.publicKey() },
      startedAt: recorder.startedAt,
    },
    recorder.cases,
  );
  if (provenance === undefined) {
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } else {
    recheckProvenance(provenance, { allowBranch: args["allow-branch"] });
    log(`evidence written to ${writeEvidence(evidence, { allowBranch: args["allow-branch"] })}`);
  }
  if (recorder.failed > 0) process.exit(1);
}

/** Every `exact` case, paying `seller`. */
async function exactCases(seller: Keypair) {
  const [payerA, payerB, payerC, payerD, payerE, payerF, payerG, payerH, payerI, payerJ] =
    (await treasury.accounts(10, "2")) as [
      Keypair,
      Keypair,
      Keypair,
      Keypair,
      Keypair,
      Keypair,
      Keypair,
      Keypair,
      Keypair,
      Keypair,
    ];

  await check(
    "g-payer-settles",
    "G… payer, 7-decimal amount (1.2345678 USDC); non-custody on chain",
    ["scheme-exact", "payload-transaction", "fees-sponsored"],
    async () => {
      const { payload, requirements } = await pay(payerA, seller.publicKey(), 12_345_678n);
      await settleAndProve(payload, requirements, payerA.publicKey());
    },
  );

  await check(
    "smallest-unit",
    "SEP-41 amount of one base unit (0.0000001 USDC)",
    ["scheme-exact"],
    async () => {
      const { payload, requirements } = await pay(payerB, seller.publicKey(), 1n);
      await settleAndProve(payload, requirements, payerB.publicKey());
    },
  );

  await check(
    "replay-idempotent",
    "the same payment settled twice moves funds once, same result",
    ["idempotency"],
    async () => {
      const { payload, requirements } = await pay(payerC, seller.publicKey(), 1_000_000n);
      const { hash } = await settleAndProve(payload, requirements, payerC.publicKey());
      const before = await balance(payerC.publicKey());
      const again = await settle(payload, requirements);
      strictEqual(again.body.success, true);
      strictEqual(again.body.transaction, hash, "the repeat answers with the original transaction");
      deepStrictEqual(
        again.extensions?.rail402?.settlement,
        { repeat: true, settledBy: "rail402" },
        "the repeat is marked in EXTENSION-RESPONSES",
      );
      strictEqual(await balance(payerC.publicKey()), before, "no second debit");
    },
  );

  await check(
    "replay-concurrent",
    "the same payment settled twice at once moves funds once; both answers name one transaction",
    ["idempotency", "concurrency"],
    async () => {
      const { payload, requirements } = await pay(payerI, seller.publicKey(), 1_000_000n);
      const before = await balance(payerI.publicKey());
      const answers = await Promise.all([settle(payload, requirements), settle(payload, requirements)]);
      for (const answer of answers) strictEqual(answer.body.success, true, JSON.stringify(answer.body));
      const [first, second] = answers;
      strictEqual(first.body.transaction, second.body.transaction, "one transaction for both");
      strictEqual(
        answers.filter((answer) => answer.extensions?.rail402?.settlement?.repeat === true).length,
        1,
        "exactly one answer is marked as a repeat",
      );
      strictEqual(await balance(payerI.publicKey()), before - 1_000_000n, "debited once");
      current?.transaction(
        await settledTransaction(net, first.body.transaction ?? "", {
          scheme: "exact",
          asset: USDC_TESTNET_ADDRESS,
          decimals: 7,
          amount: 1_000_000n,
          payerType: "G",
        }),
      );
    },
  );

  await check(
    "replay-rejected",
    "a settled authorization in a new envelope is refused; verify names the replay",
    ["idempotency", "rejection-codes"],
    async () => {
      const { payload, requirements } = await pay(payerD, seller.publicKey(), 1_000_000n);
      await settleAndProve(payload, requirements, payerD.publicKey());
      const before = await balance(payerD.publicKey());
      const original = TransactionBuilder.fromXDR(payload.payload.transaction, net.passphrase) as Transaction;
      const envelope = original.toEnvelope();
      envelope.v1().tx().fee(999);
      const repackaged = { ...payload, payload: { transaction: envelope.toXDR("base64") } };
      await expectRejected("settle", repackaged, requirements, ["settle_exact_stellar_idempotency_conflict"]);
      await expectRejected("verify", payload, requirements, [
        "invalid_exact_stellar_payload_nonce_already_used",
      ]);
      strictEqual(await balance(payerD.publicKey()), before, "no second debit");
    },
  );

  await check(
    "tamper-amount",
    "a changed amount fails the payer's signed authorization",
    ["rejection-codes"],
    async () => {
      const { payload } = await pay(payerE, seller.publicKey(), 1_000_000n);
      const tampered = requirementsFor(USDC_TESTNET_ADDRESS, seller.publicKey(), 9_000_000n);
      const envelope = xdr.TransactionEnvelope.fromXDR(payload.payload.transaction, "base64");
      const operation = envelope.v1().tx().operations()[0]?.body().invokeHostFunctionOp();
      if (operation === undefined) throw new Error("fixture");
      operation.hostFunction().invokeContract().args()[2] = nativeToScVal(9_000_000n, { type: "i128" });
      const opOnly = { ...payload, accepted: tampered, payload: { transaction: envelope.toXDR("base64") } };
      await expectRejected("verify", opOnly, tampered, [
        "invalid_exact_stellar_payload_auth_invocation_mismatch",
      ]);
      const signed = operation.auth()[0]?.rootInvocation().function().contractFn();
      if (signed === undefined) throw new Error("fixture");
      signed.args()[2] = nativeToScVal(9_000_000n, { type: "i128" });
      const both = { ...opOnly, payload: { transaction: envelope.toXDR("base64") } };
      await expectRejected("verify", both, tampered, ["invalid_exact_stellar_payload_invalid_signature"]);
      await expectRejected("settle", both, tampered, ["invalid_exact_stellar_payload_invalid_signature"]);
      strictEqual(await balance(payerE.publicKey()), STARTING_USDC, "nothing moved");
    },
  );

  await check(
    "tamper-recipient",
    "a redirected payTo fails the payer's signed authorization",
    ["rejection-codes"],
    async () => {
      const attacker = Keypair.random().publicKey();
      const { payload } = await pay(payerE, seller.publicKey(), 1_000_000n);
      const redirected = requirementsFor(USDC_TESTNET_ADDRESS, attacker, 1_000_000n);
      const envelope = xdr.TransactionEnvelope.fromXDR(payload.payload.transaction, "base64");
      const operation = envelope.v1().tx().operations()[0]?.body().invokeHostFunctionOp();
      const signed = operation?.auth()[0]?.rootInvocation().function().contractFn();
      if (operation === undefined || signed === undefined) throw new Error("fixture");
      const to = nativeToScVal(attacker, { type: "address" });
      operation.hostFunction().invokeContract().args()[1] = to;
      signed.args()[1] = to;
      const both = { ...payload, accepted: redirected, payload: { transaction: envelope.toXDR("base64") } };
      await expectRejected("settle", both, redirected, ["invalid_exact_stellar_payload_invalid_signature"]);
      strictEqual(await balance(payerE.publicKey()), STARTING_USDC, "nothing moved");
    },
  );

  await check(
    "mismatched-requirements",
    "a payment that does not match the requirements is refused",
    ["rejection-codes"],
    async () => {
      const { payload } = await pay(payerE, seller.publicKey(), 1_000_000n);
      const other = requirementsFor(USDC_TESTNET_ADDRESS, seller.publicKey(), 2_000_000n);
      await expectRejected("verify", payload, other, [
        "invalid_exact_stellar_payload_accepted_mismatch",
        "invalid_exact_stellar_payload_wrong_amount",
      ]);
    },
  );

  await check(
    "payer-no-trustline",
    "a payer without a USDC trustline is named",
    ["rejection-codes"],
    async () => {
      const [bare] = (await treasury.accounts(1, "0", false)) as [Keypair];
      const { payload, requirements } = await offline(bare, seller.publicKey(), 1_000n);
      await expectRejected("verify", payload, requirements, [
        "invalid_exact_stellar_payload_payer_trustline_missing",
      ]);
      await expectRejected("settle", payload, requirements, [
        "invalid_exact_stellar_payload_payer_trustline_missing",
      ]);
    },
  );

  await check(
    "payto-no-trustline",
    "a payTo without a USDC trustline is named",
    ["rejection-codes"],
    async () => {
      const [bare] = (await treasury.accounts(1, "0", false)) as [Keypair];
      const { payload, requirements } = await offline(payerF, bare.publicKey(), 1_000n);
      await expectRejected("verify", payload, requirements, [
        "invalid_exact_stellar_payload_recipient_trustline_missing",
      ]);
      await expectRejected("settle", payload, requirements, [
        "invalid_exact_stellar_payload_recipient_trustline_missing",
      ]);
    },
  );

  await check(
    "insufficient-balance",
    "a payer holding less than the amount is refused",
    ["rejection-codes"],
    async () => {
      const [poor] = (await treasury.accounts(1, "0.0000001")) as [Keypair];
      const { payload, requirements } = await offline(poor, seller.publicKey(), 1_000n);
      await expectRejected("verify", payload, requirements, ["insufficient_funds"]);
      await expectRejected("settle", payload, requirements, ["insufficient_funds"]);
    },
  );

  await check(
    "expired",
    "expired and about-to-expire authorizations are refused, nothing moves",
    ["expiration", "rejection-codes"],
    async () => {
      const latest = await net.latestLedger();
      const expired = await pay(payerF, seller.publicKey(), 1_000n, latest - 1);
      await expectRejected("verify", expired.payload, expired.requirements, [
        "invalid_exact_stellar_signature_expired",
      ]);
      await expectRejected("settle", expired.payload, expired.requirements, [
        "invalid_exact_stellar_signature_expired",
      ]);
      const tooSoon = await pay(payerF, seller.publicKey(), 1_000n, await net.latestLedger());
      await expectRejected("settle", tooSoon.payload, tooSoon.requirements, [
        "invalid_exact_stellar_signature_expiration_too_soon",
        "invalid_exact_stellar_signature_expired",
      ]);
      strictEqual(await balance(payerF.publicKey()), STARTING_USDC, "nothing moved");
    },
  );

  await check(
    "expiry-window",
    "the stock client's expiry from maxTimeoutSeconds: refused once passed, nothing moves; a fresh payment settles",
    ["expiration"],
    async () => {
      // Signed by the unmodified client: expiration = latest + ceil(maxTimeoutSeconds / est).
      const client = new ExactStellarClient(createEd25519Signer(payerH.secret(), NETWORK));
      const stock = async (maxTimeoutSeconds: number) => {
        const requirements = requirementsFor(
          USDC_TESTNET_ADDRESS,
          seller.publicKey(),
          1_000_000n,
          maxTimeoutSeconds,
        );
        const before = await net.latestLedger();
        const signed = await client.createPaymentPayload(2, requirements);
        const after = await net.latestLedger();
        const payload = {
          ...signed,
          resource: { url: "https://seller.example/resource" },
          accepted: requirements,
        } as Payload & { payload: { transaction: string } };
        const envelope = xdr.TransactionEnvelope.fromXDR(payload.payload.transaction, "base64");
        const entry = envelope.v1().tx().operations()[0]?.body().invokeHostFunctionOp().auth()[0];
        const expiration = entry?.credentials().address().signatureExpirationLedger();
        if (expiration === undefined) throw new Error("the stock client signed no address credential");
        return { payload, requirements, expiration, before, after };
      };

      const estimate = await getEstimatedLedgerCloseTimeSeconds(NETWORK);
      const short = await stock(10);
      // The client read the latest ledger somewhere between `before` and `after`.
      const offset = Math.ceil(10 / estimate);
      ok(
        short.expiration >= short.before + offset && short.expiration <= short.after + offset,
        `expiration ${short.expiration} is not latest + ceil(10 / ${estimate}) (latest ${short.before}–${short.after})`,
      );
      const verified = await verify(short.payload, short.requirements);
      deepStrictEqual(verified.body, { isValid: true, payer: payerH.publicKey() });

      const deadline = Date.now() + 120_000;
      while ((await net.latestLedger()) <= short.expiration) {
        if (Date.now() > deadline) throw new Error("the network did not pass the expiration ledger in time");
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      await expectRejected("verify", short.payload, short.requirements, [
        "invalid_exact_stellar_signature_expired",
      ]);
      await expectRejected("settle", short.payload, short.requirements, [
        "invalid_exact_stellar_signature_expired",
      ]);
      strictEqual(await balance(payerH.publicKey()), STARTING_USDC, "nothing moved");

      const fresh = await stock(60);
      await settleAndProve(fresh.payload, fresh.requirements, payerH.publicKey());
      for (const [key, value] of Object.entries({
        estimatedLedgerSeconds: estimate,
        shortTimeoutSeconds: 10,
        shortExpirationLedger: short.expiration,
        shortLatestLedgerAtSigning: short.before,
        freshTimeoutSeconds: 60,
        freshExpirationOffset: fresh.expiration - fresh.before,
        upperEdge:
          "not run on testnet: it depends on the facilitator's and the client's Horizon readings agreeing",
      })) {
        current?.observe(key, value);
      }
    },
  );

  await check(
    "replay-late",
    "a repeat after the authorization expired returns the original success and moves nothing",
    ["idempotency", "expiration"],
    async () => {
      const expiration = (await net.latestLedger()) + 6;
      const { payload, requirements } = await pay(payerJ, seller.publicKey(), 1_000_000n, expiration);
      const { hash } = await settleAndProve(payload, requirements, payerJ.publicKey());
      const deadline = Date.now() + 120_000;
      while ((await net.latestLedger()) <= expiration) {
        if (Date.now() > deadline) throw new Error("the network did not pass the expiration ledger in time");
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      const before = await balance(payerJ.publicKey());
      const late = await settle(payload, requirements);
      deepStrictEqual(
        late.body,
        { success: true, transaction: hash, network: NETWORK, payer: payerJ.publicKey() },
        "the late repeat returns the original success",
      );
      strictEqual(late.extensions?.rail402?.settlement?.repeat, true, "the late repeat is marked");
      strictEqual(await balance(payerJ.publicKey()), before, "no second debit");
      current?.observe("expirationLedger", expiration);
    },
  );

  await check(
    "self-payment",
    "a payer paying its own account is refused; the sponsor pays nothing",
    ["rejection-codes"],
    async () => {
      const { payload, requirements } = await pay(payerF, payerF.publicKey(), 1_000n);
      await expectRejected("verify", payload, requirements, ["invalid_exact_stellar_payload_self_payment"]);
      await expectRejected("settle", payload, requirements, ["invalid_exact_stellar_payload_self_payment"]);
      strictEqual(await balance(payerF.publicKey()), STARTING_USDC, "nothing moved");
    },
  );

  // --- smart accounts ----------------------------------------------------------------------
  const owner = Keypair.random();
  let smartAccount = "";
  await check(
    "c-payer-settles",
    "C… payer (contract account, __check_auth); non-custody on chain",
    ["scheme-exact", "fees-sponsored"],
    async () => {
      smartAccount = await deploySimpleAccount(net, treasury.keypair, owner);
      await treasury.transfer(smartAccount, 5_000_000n);
      const requirements = requirementsFor(USDC_TESTNET_ADDRESS, seller.publicKey(), 1_234_567n);
      const payload = await smartAccountPayment(net, {
        account: smartAccount,
        owner,
        source: treasury.keypair,
        requirements,
      });
      await settleAndProve(payload, requirements, smartAccount);
    },
    { payer: "C", payTo: "G" },
  );

  await check(
    "c-payer-wrong-key",
    "a C… payment signed by the wrong key is refused",
    ["rejection-codes"],
    async () => {
      if (smartAccount === "") throw new Error("no smart account");
      const requirements = requirementsFor(USDC_TESTNET_ADDRESS, seller.publicKey(), 1_000n);
      const payload = await smartAccountPayment(net, {
        account: smartAccount,
        owner,
        signWith: Keypair.random(),
        source: treasury.keypair,
        requirements,
      });
      const codes = [
        "invalid_exact_stellar_payload_invalid_signature",
        "invalid_exact_stellar_payload_smart_account_rejected",
      ];
      await expectRejected("verify", payload, requirements, codes);
      await expectRejected("settle", payload, requirements, codes);
    },
    { payer: "C", payTo: "G" },
  );

  await check(
    "c-payto",
    "a C… payTo (contract address) is credited",
    ["scheme-exact"],
    async () => {
      if (smartAccount === "") throw new Error("no smart account");
      const { payload, requirements } = await pay(payerG, smartAccount, 2_500_000n);
      await settleAndProve(payload, requirements, payerG.publicKey());
    },
    { payer: "G", payTo: "C" },
  );

  // --- refused before the chain --------------------------------------------------------------
  await check(
    "refusals",
    "malformed or unserviceable requests get coded, reasoned refusals",
    ["rejection-codes"],
    async () => {
      const { payload, requirements } = await pay(payerG, seller.publicKey(), 1_000n);
      const garbled = await call("verify", "{not json");
      strictEqual(garbled.status, 400);
      strictEqual(garbled.body.invalidReason, "invalid_payload");
      const wrongType = await call("verify", "x", "text/plain");
      strictEqual(wrongType.status, 415);
      await expectRejected("verify", payload, { ...requirements, network: "stellar:pubnet" }, [
        "invalid_network",
      ]);
      await expectRejected("settle", payload, { ...requirements, scheme: "escrow" }, ["unsupported_scheme"]);
      const foreignAsset = new Asset("TEST", Keypair.random().publicKey()).contractId(net.passphrase);
      await expectRejected("verify", payload, { ...requirements, asset: foreignAsset }, [
        "invalid_exact_stellar_requirements_asset_not_accepted",
      ]);
      await expectRejected("verify", payload, { ...requirements, extra: { areFeesSponsored: false } }, [
        "invalid_exact_stellar_requirements_fees_not_sponsored",
      ]);
      await expectRejected("verify", payload, { ...requirements, maxTimeoutSeconds: 86_400 }, [
        "invalid_exact_stellar_requirements_timeout_out_of_range",
      ]);
    },
  );
}

// ---------------------------------------------------------------------------------------------
// upto

/** A smart-account payer: its address and how its entries are signed. */
interface SmartPayer {
  readonly address: string;
  readonly sign: EntrySigner;
}

interface UptoRequirements {
  readonly scheme: "upto";
  readonly network: typeof NETWORK;
  readonly asset: string;
  readonly payTo: string;
  readonly amount: string;
  readonly maxTimeoutSeconds: number;
  readonly extra: { readonly areFeesSponsored: true; readonly facilitatorAddress: string };
}

/** Every `upto` case, paying `seller` in USDC with `@rail402.dev/upto`'s client. */
async function uptoCases(supported: unknown, seller: Keypair) {
  const CAP = 1_000_000n; // 0.1 USDC
  const kind = (
    supported as { kinds?: { scheme?: string; network?: string; extra?: Record<string, unknown> }[] }
  ).kinds?.find((entry) => entry.scheme === "upto" && entry.network === NETWORK);
  const authority = kind?.extra?.["facilitatorAddress"];
  const upto = (id: string, title: string, checks: readonly CheckId[], run: () => Promise<void>) =>
    check(id, title, checks, run, { payer: "G", payTo: "G" }, "upto");

  await upto(
    "upto-supported",
    "/supported: upto on stellar:testnet with areFeesSponsored and a settlement authority among the signers",
    ["supported", "fees-sponsored", "scheme-upto"],
    () => {
      ok(kind !== undefined, "the facilitator advertises upto on stellar:testnet");
      strictEqual(kind.extra?.["areFeesSponsored"], true);
      ok(typeof authority === "string" && signers.has(authority), "the settlement authority is a signer");
      return Promise.resolve();
    },
  );
  if (typeof authority !== "string") return;

  const requirementsOf = (payTo: string, cap: bigint, maxTimeoutSeconds = 60): UptoRequirements => ({
    scheme: "upto",
    network: NETWORK,
    asset: USDC_TESTNET_ADDRESS,
    payTo,
    amount: cap.toString(),
    maxTimeoutSeconds,
    extra: { areFeesSponsored: true, facilitatorAddress: authority },
  });
  /**
   * A payment signed by the scheme's client, whose expiry comes from maxTimeoutSeconds: the stock
   * ed25519 signer for a G… payer, the account's own entry signer for a smart account.
   */
  const payUpto = async (payer: Keypair | SmartPayer, maxTimeoutSeconds = 60) => {
    const client =
      payer instanceof Keypair
        ? new UptoStellarClient(createEd25519Signer(payer.secret(), NETWORK), {
            rpcConfig: { url: args.rpc },
          })
        : new UptoStellarClient(
            {
              address: payer.address,
              signAuthEntry: () => Promise.reject(new Error("a smart account signs through authorizeEntry")),
            },
            {
              rpcConfig: { url: args.rpc },
              authorizeEntry: (entry, context) => payer.sign(entry, context.networkPassphrase),
            },
          );
    const published = requirementsOf(seller.publicKey(), CAP, maxTimeoutSeconds);
    const before = await net.latestLedger();
    const created = await client.createPaymentPayload(2, published);
    const after = await net.latestLedger();
    const payload = {
      x402Version: 2,
      resource: { url: "https://seller.example/metered" },
      accepted: published,
      payload: created.payload,
    };
    const inspected = inspectUptoAuthorization(
      (created.payload as { authorization?: unknown }).authorization,
      contractOf(created.payload),
    );
    const expiration = inspected.ok ? inspected.authorization.terms.expirationLedger : undefined;
    const at = (amount: bigint): UptoRequirements => ({ ...published, amount: amount.toString() });
    return { payload, published, at, expiration, before, after };
  };
  const payers = (await treasury.accounts(7, "1")) as [
    Keypair,
    Keypair,
    Keypair,
    Keypair,
    Keypair,
    Keypair,
    Keypair,
  ];
  const [partial, max, zero, overCap, repeat, window, concurrent] = payers;
  const START = 10_000_000n; // 1 USDC

  await upto(
    "upto-partial",
    "upto: settles part of the cap; only that amount moves",
    ["scheme-upto", "fees-sponsored"],
    async () => {
      const { payload, published, at } = await payUpto(partial);
      await settleAndProve(payload, at(400_000n), partial.publicKey(), published);
    },
  );

  await upto("upto-max", "upto: settles the whole cap", ["scheme-upto"], async () => {
    const { payload, published, at } = await payUpto(max);
    await settleAndProve(payload, at(CAP), max.publicKey(), published);
  });

  /**
   * Settles zero: on chain (the default) a transaction with no transfer, proven like any settlement;
   * off chain (UPTO_ZERO_SETTLEMENT=offchain) no transaction. Either way nothing moves and the
   * authorization is used up.
   */
  const settleZero = async (payer: Keypair | SmartPayer) => {
    const address = payer instanceof Keypair ? payer.publicKey() : payer.address;
    const { payload, published, at } = await payUpto(payer);
    const before = await balance(address);
    const settled = await settle(payload, at(0n));
    strictEqual(settled.body.success, true, JSON.stringify(settled.body));
    strictEqual(settled.body.amount, "0");
    const hash = settled.body.transaction ?? "";
    if (hash !== "") {
      const onChain = await net.server.getTransaction(hash);
      if (onChain.status !== rpc.Api.GetTransactionStatus.SUCCESS)
        throw new Error(`${hash} is ${onChain.status}`);
      deepStrictEqual(sacTransferEvents(onChain), [], "no transfer");
      current?.transaction(
        await settledTransaction(net, hash, {
          scheme: "upto",
          asset: USDC_TESTNET_ADDRESS,
          decimals: 7,
          amount: 0n,
          payerType: address.startsWith("C") ? "C" : "G",
        }),
      );
    }
    current?.observe("zeroSettlement", hash === "" ? "offchain" : "onchain");
    strictEqual(await balance(address), before, "nothing moved");
    await expectRejected("verify", payload, published, ["invalid_upto_stellar_payload_nonce_already_used"]);
  };

  await upto(
    "upto-zero",
    "upto: settles zero; nothing moves and the authorization is used up",
    ["scheme-upto", "idempotency"],
    () => settleZero(zero),
  );

  await upto(
    "upto-over-cap",
    "upto: a charge above the cap is refused and nothing moves",
    ["scheme-upto", "rejection-codes"],
    async () => {
      const { payload, at } = await payUpto(overCap);
      await expectRejected("settle", payload, at(CAP + 1n), [
        "invalid_upto_stellar_payload_settlement_exceeds_amount",
      ]);
      strictEqual(await balance(overCap.publicKey()), START, "nothing moved");
    },
  );

  await upto(
    "upto-repeat-different-amount",
    "upto: a repeat for the same amount answers the original; another amount is a conflict, never a second charge",
    ["scheme-upto", "idempotency", "rejection-codes"],
    async () => {
      const { payload, published, at } = await payUpto(repeat);
      const { hash } = await settleAndProve(payload, at(300_000n), repeat.publicKey(), published);
      const again = await settle(payload, at(300_000n));
      strictEqual(again.body.transaction, hash, "the repeat answers the original transaction");
      deepStrictEqual(again.extensions?.rail402?.settlement, { repeat: true, settledBy: "rail402" });
      const other = await settle(payload, at(500_000n));
      strictEqual(other.body.errorReason, "settle_upto_stellar_idempotency_conflict");
      ok((other.body.errorMessage ?? "").includes(hash), "the conflict names the recorded transaction");
      strictEqual(await balance(repeat.publicKey()), START - 300_000n, "debited once");
    },
  );

  await upto(
    "upto-concurrent-same-authorization",
    "upto: one authorization settled five times at once lands one transaction and moves the amount once",
    ["scheme-upto", "idempotency", "concurrency"],
    async () => {
      const { payload, published, at } = await payUpto(concurrent);
      const answers = await Promise.all(Array.from({ length: 5 }, () => settle(payload, at(250_000n))));
      for (const answer of answers) strictEqual(answer.body.success, true, JSON.stringify(answer.body));
      const hashes = new Set(answers.map((answer) => answer.body.transaction));
      strictEqual(hashes.size, 1, "every answer names the same transaction");
      const [hash = ""] = hashes;
      const onChain = await net.server.getTransaction(hash);
      if (onChain.status !== rpc.Api.GetTransactionStatus.SUCCESS)
        throw new Error(`${hash} is ${onChain.status}`);
      deepStrictEqual(
        sacTransferEvents(onChain),
        [
          {
            contract: USDC_TESTNET_ADDRESS,
            from: concurrent.publicKey(),
            to: seller.publicKey(),
            amount: 250_000n,
          },
        ],
        "one transfer",
      );
      strictEqual(await balance(concurrent.publicKey()), START - 250_000n, "debited once");
      current?.transaction(
        await settledTransaction(net, hash, {
          scheme: "upto",
          asset: USDC_TESTNET_ADDRESS,
          decimals: 7,
          amount: 250_000n,
          payerType: "G",
        }),
      );
      current?.observe(
        "repeats",
        answers.filter((answer) => answer.extensions?.rail402?.settlement?.repeat === true).length,
      );
      await expectRejected("verify", payload, published, ["invalid_upto_stellar_payload_nonce_already_used"]);
    },
  );

  // A smart account (C…): a simple custom account whose owner key signs its entries.
  const owner = Keypair.random();
  const smart: SmartPayer = {
    address: await deploySimpleAccount(net, treasury.keypair, owner),
    sign: simpleAccountSigner(owner),
  };
  await treasury.transfer(smart.address, START);
  const cUpto = (id: string, title: string, checks: readonly CheckId[], run: () => Promise<void>) =>
    check(id, title, checks, run, { payer: "C", payTo: "G" }, "upto");

  await cUpto(
    "upto-c-partial",
    "upto from a smart account (C…): settles part of the cap; only that amount moves",
    ["scheme-upto", "fees-sponsored"],
    async () => {
      const { payload, published, at } = await payUpto(smart);
      await settleAndProve(payload, at(400_000n), smart.address, published);
    },
  );
  await cUpto(
    "upto-c-max",
    "upto from a smart account (C…): settles the whole cap",
    ["scheme-upto"],
    async () => {
      const { payload, published, at } = await payUpto(smart);
      await settleAndProve(payload, at(CAP), smart.address, published);
    },
  );
  await cUpto(
    "upto-c-zero",
    "upto from a smart account (C…): settles zero; nothing moves and the authorization is used up",
    ["scheme-upto", "idempotency"],
    () => settleZero(smart),
  );
  await cUpto(
    "upto-c-over-limit",
    "upto from a smart account whose spending limit is below the cap: the account refuses, nothing moves",
    ["scheme-upto", "rejection-codes"],
    async () => {
      // An OpenZeppelin smart account whose agent key pays USDC under a spending limit of half the cap.
      const contract = resolveUptoContract(NETWORK);
      if (contract === undefined) throw new Error("no upto contract on stellar:testnet");
      const account = await deployOzSmartAccount(net, treasury.keypair, Keypair.random());
      const agent = Keypair.random();
      const policy = await deploySpendingLimitPolicy(net, treasury.keypair);
      const tokenRule = await addOzContextRule(net, account, {
        submitter: treasury.keypair,
        context: { kind: "callContract", contract: USDC_TESTNET_ADDRESS },
        name: "agent payments",
        signers: [agent],
        policies: new Map([
          [policy, spendingLimitParams({ spendingLimit: CAP / 2n, periodLedgers: 17_280 })],
        ]),
      });
      const uptoRule = await addOzContextRule(net, account, {
        submitter: treasury.keypair,
        context: { kind: "callContract", contract },
        name: "agent upto terms",
        signers: [agent],
      });
      await treasury.transfer(account.address, START);
      const limited: SmartPayer = {
        address: account.address,
        sign: ozSmartAccountSigner({
          verifier: account.verifier,
          key: agent,
          contextRuleIds: [uptoRule, tokenRule],
        }),
      };
      const { payload, published, at } = await payUpto(limited);
      await expectRejected("verify", payload, published, [
        "invalid_upto_stellar_payload_smart_account_rejected",
      ]);
      await expectRejected("settle", payload, at(100_000n), [
        "invalid_upto_stellar_payload_smart_account_rejected",
      ]);
      strictEqual(await balance(account.address), START, "nothing moved");
      current?.observe("spendingLimit", (CAP / 2n).toString());
      current?.observe("cap", CAP.toString());
    },
  );

  await upto(
    "upto-expiry-window",
    "upto: the client's expiry from maxTimeoutSeconds: refused once passed, nothing moves; a fresh payment settles",
    ["scheme-upto", "expiration"],
    async () => {
      const estimate = await getEstimatedLedgerCloseTimeSeconds(NETWORK);
      const short = await payUpto(window, 10);
      if (short.expiration === undefined) throw new Error("the payment carries no expiration");
      const offset = Math.ceil(10 / estimate);
      ok(
        short.expiration >= short.before + offset && short.expiration <= short.after + offset,
        `expiration ${short.expiration} is not latest + ceil(10 / ${estimate}) (latest ${short.before}–${short.after})`,
      );
      const verified = await verify(short.payload, short.published);
      deepStrictEqual(verified.body, { isValid: true, payer: window.publicKey() });

      const deadline = Date.now() + 120_000;
      while ((await net.latestLedger()) <= short.expiration) {
        if (Date.now() > deadline) throw new Error("the network did not pass the expiration ledger in time");
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      await expectRejected("verify", short.payload, short.published, [
        "invalid_upto_stellar_signature_expired",
      ]);
      await expectRejected("settle", short.payload, short.at(100_000n), [
        "invalid_upto_stellar_signature_expired",
      ]);
      strictEqual(await balance(window.publicKey()), START, "nothing moved");

      const fresh = await payUpto(window, 60);
      await settleAndProve(fresh.payload, fresh.at(100_000n), window.publicKey(), fresh.published);
      for (const [key, value] of Object.entries({
        estimatedLedgerSeconds: estimate,
        shortTimeoutSeconds: 10,
        shortExpirationLedger: short.expiration,
        shortLatestLedgerAtSigning: short.before,
        freshTimeoutSeconds: 60,
        freshExpirationOffset: (fresh.expiration ?? 0) - fresh.before,
      })) {
        current?.observe(key, value);
      }
    },
  );
}

/** The settlement contract an upto payload's authorization entry calls. */
function contractOf(payload: Record<string, unknown>): string {
  const authorization = payload["authorization"];
  if (typeof authorization !== "string") throw new Error("no authorization");
  const entry = xdr.SorobanAuthorizationEntry.fromXDR(authorization, "base64");
  return Address.fromScAddress(entry.rootInvocation().function().contractFn().contractAddress()).toString();
}

main().catch((error: unknown) => {
  log(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
