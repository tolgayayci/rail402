/**
 * Live facilitator matrix: every documented facilitator behaviour exercised over HTTP against a
 * deployed Rail402, on the public Stellar testnet, in Circle USDC. No API key is sent.
 *
 *   node tools/conformance/src/live-matrix.ts --facilitator https://… [--write]
 *
 * Covers G… and C… payers, a C… payTo, 7-decimal SEP-41 amounts down to one base unit, missing
 * trustlines on either side, insufficient balance, expired and about-to-expire authorizations,
 * tampering, replay and idempotency, and requests the service must refuse before touching the chain.
 * Every settlement is checked on chain: the payer is debited, payTo is credited, one transfer event
 * moves the funds, and the facilitator's accounts only pay the network fee. Every rejection must
 * carry a registered code and a non-empty reason. Fresh accounts are created for each run, so the
 * script needs no secrets.
 */
import { mkdirSync, writeFileSync } from "node:fs";
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
  scValToNative,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import {
  LocalNetwork,
  buildTransfer,
  deploySimpleAccount,
  requirementsFor,
  smartAccountPayment,
  type PaymentRequirementsLike,
} from "@rail402.dev/testkit";
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

const { values: args } = parseArgs({
  options: {
    facilitator: { type: "string", default: "http://localhost:8080" },
    rpc: { type: "string", default: TESTNET_RPC_URL },
    friendbot: { type: "string", default: TESTNET_FRIENDBOT_URL },
    write: { type: "boolean", default: false },
  },
});

const FACILITATOR = args.facilitator.replace(/\/+$/, "");
const net = new LocalNetwork(args.rpc, args.friendbot);
/** Each payer starts with 2 USDC, in base units. */
const STARTING_USDC = 20_000_000n;

// ---------------------------------------------------------------------------------------------
// Results

interface CaseResult {
  id: string;
  criterion: string;
  passed: boolean;
  elapsedMs: number;
  /** Codes and reasons of every rejection the case received. */
  rejections: { operation: string; httpStatus: number; code: string; reason: string }[];
  transactions: { hash: string; feeChargedStroops: string; explorer: string }[];
  error?: string;
}

const results: CaseResult[] = [];
let current: CaseResult | undefined;

async function check(id: string, criterion: string, run: () => Promise<void>): Promise<void> {
  const result: CaseResult = { id, criterion, passed: false, elapsedMs: 0, rejections: [], transactions: [] };
  current = result;
  const started = performance.now();
  try {
    await run();
    result.passed = true;
    log(`PASS ${id}`);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    log(`FAIL ${id}: ${result.error}`);
  }
  result.elapsedMs = Math.round(performance.now() - started);
  results.push(result);
  current = undefined;
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
    current?.rejections.push({ operation, httpStatus: response.status, code, reason });
  }
  return { status: response.status, body: parsed };
}

const verify = (payload: Payload, requirements: PaymentRequirementsLike | Record<string, unknown>) =>
  call("verify", { x402Version: 2, paymentPayload: payload, paymentRequirements: requirements });
const settle = (payload: Payload, requirements: PaymentRequirementsLike | Record<string, unknown>) =>
  call("settle", { x402Version: 2, paymentPayload: payload, paymentRequirements: requirements });

async function expectRejected(
  operation: "verify" | "settle",
  payload: Payload,
  requirements: PaymentRequirementsLike | Record<string, unknown>,
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
async function settleAndProve(payload: Payload, requirements: PaymentRequirementsLike, payer: string) {
  const { payTo } = requirements;
  const amount = BigInt(requirements.amount);
  const before = { payer: await balance(payer), payTo: await balance(payTo) };
  const signersBefore = await signerBalances();

  const verified = await verify(payload, requirements);
  deepStrictEqual(verified.body, { isValid: true, payer });
  const settled = await settle(payload, requirements);
  strictEqual(settled.status, 200);
  strictEqual(settled.body.success, true, `settle failed: ${JSON.stringify(settled.body)}`);
  strictEqual(settled.body.network, NETWORK);
  strictEqual(settled.body.payer, payer);
  const hash = settled.body.transaction ?? "";
  ok(/^[0-9a-f]{64}$/.test(hash), "settlement names its transaction");

  const onChain = await net.server.getTransaction(hash);
  if (onChain.status !== rpc.Api.GetTransactionStatus.SUCCESS)
    throw new Error(`${hash} is ${onChain.status}`);
  const fee = onChain.resultXdr.feeCharged().toBigInt();
  current?.transactions.push({
    hash,
    feeChargedStroops: fee.toString(),
    explorer: `https://stellar.expert/explorer/testnet/tx/${hash}`,
  });

  // Who paid and who sourced: a fee bump by one facilitator signer around a channel's transaction.
  const envelope = TransactionBuilder.fromXDR(onChain.envelopeXdr.toXDR("base64"), net.passphrase);
  ok(envelope instanceof FeeBumpTransaction, "settlement is a fee bump");
  const feeSource = envelope.feeSource;
  const channel = envelope.innerTransaction.source;
  ok(signers.has(feeSource), `fee source ${feeSource} is not a facilitator signer`);
  ok(signers.has(channel), `transaction source ${channel} is not a facilitator signer`);
  ok(feeSource !== payer && channel !== payer && feeSource !== payTo && channel !== payTo);

  // Exactly one transfer, payer → payTo, for the exact amount of the required asset.
  const transfers = transferEvents(onChain);
  strictEqual(transfers.length, 1, "one transfer event");
  deepStrictEqual(transfers[0], { contract: USDC_TESTNET_ADDRESS, from: payer, to: payTo, amount });

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

interface TransferEvent {
  contract: string;
  from: string;
  to: string;
  amount: bigint;
}

function transferEvents(transaction: rpc.Api.GetSuccessfulTransactionResponse): TransferEvent[] {
  const meta = transaction.resultMetaXdr;
  const events =
    meta.switch() === 4
      ? meta
          .v4()
          .operations()
          .flatMap((operation) => operation.events())
      : [];
  return events
    .filter((event) => event.body().v0().topics()[0]?.sym().toString() === "transfer")
    .map((event) => {
      const topics = event.body().v0().topics();
      const data = scValToNative(event.body().v0().data()) as bigint | { amount: bigint };
      const contractId = event.contractId();
      return {
        contract:
          contractId === null
            ? ""
            : Address.fromScAddress(xdr.ScAddress.scAddressTypeContract(contractId)).toString(),
        from: String(scValToNative(topics[1] as xdr.ScVal)),
        to: String(scValToNative(topics[2] as xdr.ScVal)),
        amount: typeof data === "bigint" ? data : data.amount,
      };
    });
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
  const health = (await (await fetch(`${FACILITATOR}/health`)).json()) as { version?: string };
  log(`facilitator ${FACILITATOR} (version ${health.version ?? "unknown"})`);

  await check("supported", "/supported: stellar:testnet, exact, extra.areFeesSponsored true", async () => {
    const response = await fetch(`${FACILITATOR}/supported`);
    strictEqual(response.status, 200);
    const body = (await response.json()) as {
      kinds: unknown[];
      extensions: string[];
      signers: Record<string, string[]>;
    };
    deepStrictEqual(body.kinds, [
      { x402Version: 2, scheme: "exact", network: NETWORK, extra: { areFeesSponsored: true } },
    ]);
    ok(body.extensions.includes("bazaar"));
    signers = new Set(body.signers["stellar:*"] ?? []);
    ok(signers.size >= 2, "sponsor and channel signers advertised");
  });
  if (signers.size === 0) throw new Error("cannot continue without the facilitator's signers");

  log("opening a treasury: Friendbot XLM, then 30 USDC from the testnet XLM/USDC pool");
  treasury = await new Treasury(net).open("30");
  const [seller, payerA, payerB, payerC, payerD, payerE, payerF, payerG] = (await treasury.accounts(
    8,
    "2",
  )) as [Keypair, Keypair, Keypair, Keypair, Keypair, Keypair, Keypair, Keypair];

  await check(
    "g-payer-settles",
    "G… payer, 7-decimal amount (1.2345678 USDC); non-custody on chain",
    async () => {
      const { payload, requirements } = await pay(payerA, seller.publicKey(), 12_345_678n);
      await settleAndProve(payload, requirements, payerA.publicKey());
    },
  );

  await check("smallest-unit", "SEP-41 amount of one base unit (0.0000001 USDC)", async () => {
    const { payload, requirements } = await pay(payerB, seller.publicKey(), 1n);
    await settleAndProve(payload, requirements, payerB.publicKey());
  });

  await check(
    "replay-idempotent",
    "the same payment settled twice moves funds once, same result",
    async () => {
      const { payload, requirements } = await pay(payerC, seller.publicKey(), 1_000_000n);
      const { hash } = await settleAndProve(payload, requirements, payerC.publicKey());
      const before = await balance(payerC.publicKey());
      const again = await settle(payload, requirements);
      strictEqual(again.body.success, true);
      strictEqual(again.body.transaction, hash, "the repeat answers with the original transaction");
      strictEqual(await balance(payerC.publicKey()), before, "no second debit");
    },
  );

  await check(
    "replay-rejected",
    "a settled authorization in a new envelope is refused; verify names the replay",
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

  await check("tamper-amount", "a changed amount fails the payer's signed authorization", async () => {
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
  });

  await check("tamper-recipient", "a redirected payTo fails the payer's signed authorization", async () => {
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
  });

  await check(
    "mismatched-requirements",
    "a payment that does not match the requirements is refused",
    async () => {
      const { payload } = await pay(payerE, seller.publicKey(), 1_000_000n);
      const other = requirementsFor(USDC_TESTNET_ADDRESS, seller.publicKey(), 2_000_000n);
      await expectRejected("verify", payload, other, [
        "invalid_exact_stellar_payload_accepted_mismatch",
        "invalid_exact_stellar_payload_wrong_amount",
      ]);
    },
  );

  await check("payer-no-trustline", "a payer without a USDC trustline is named", async () => {
    const [bare] = (await treasury.accounts(1, "0", false)) as [Keypair];
    const { payload, requirements } = await offline(bare, seller.publicKey(), 1_000n);
    await expectRejected("verify", payload, requirements, [
      "invalid_exact_stellar_payload_payer_trustline_missing",
    ]);
    await expectRejected("settle", payload, requirements, [
      "invalid_exact_stellar_payload_payer_trustline_missing",
    ]);
  });

  await check("payto-no-trustline", "a payTo without a USDC trustline is named", async () => {
    const [bare] = (await treasury.accounts(1, "0", false)) as [Keypair];
    const { payload, requirements } = await offline(payerF, bare.publicKey(), 1_000n);
    await expectRejected("verify", payload, requirements, [
      "invalid_exact_stellar_payload_recipient_trustline_missing",
    ]);
    await expectRejected("settle", payload, requirements, [
      "invalid_exact_stellar_payload_recipient_trustline_missing",
    ]);
  });

  await check("insufficient-balance", "a payer holding less than the amount is refused", async () => {
    const [poor] = (await treasury.accounts(1, "0.0000001")) as [Keypair];
    const { payload, requirements } = await offline(poor, seller.publicKey(), 1_000n);
    await expectRejected("verify", payload, requirements, ["insufficient_funds"]);
    await expectRejected("settle", payload, requirements, ["insufficient_funds"]);
  });

  await check(
    "expired",
    "expired and about-to-expire authorizations are refused, nothing moves",
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
    "self-payment",
    "a payer paying its own account is refused; the sponsor pays nothing",
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
  );

  await check("c-payer-wrong-key", "a C… payment signed by the wrong key is refused", async () => {
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
  });

  await check("c-payto", "a C… payTo (contract address) is credited", async () => {
    if (smartAccount === "") throw new Error("no smart account");
    const { payload, requirements } = await pay(payerG, smartAccount, 2_500_000n);
    await settleAndProve(payload, requirements, payerG.publicKey());
  });

  // --- refused before the chain --------------------------------------------------------------
  await check("refusals", "malformed or unserviceable requests get coded, reasoned refusals", async () => {
    const { payload, requirements } = await pay(payerG, seller.publicKey(), 1_000n);
    const garbled = await call("verify", "{not json");
    strictEqual(garbled.status, 400);
    strictEqual(garbled.body.invalidReason, "invalid_payload");
    const wrongType = await call("verify", "x", "text/plain");
    strictEqual(wrongType.status, 415);
    await expectRejected("verify", payload, { ...requirements, network: "stellar:pubnet" }, [
      "invalid_network",
    ]);
    await expectRejected("settle", payload, { ...requirements, scheme: "upto" }, ["unsupported_scheme"]);
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
  });

  // ---------------------------------------------------------------------------------------------
  const passed = results.filter((result) => result.passed).length;
  const evidence = {
    run: "live-matrix",
    date: new Date().toISOString(),
    network: NETWORK,
    facilitator: FACILITATOR,
    facilitatorVersion: health.version ?? "unknown",
    apiKey: "none",
    harnessCommit: gitCommit(),
    packages: versions(["@x402/core", "@x402/stellar", "@stellar/stellar-sdk"]),
    command: `node tools/conformance/src/live-matrix.ts --facilitator ${FACILITATOR}`,
    summary: {
      cases: results.length,
      passed,
      failed: results.length - passed,
      settlements: results.flatMap((result) => result.transactions).length,
      rejections: results.flatMap((result) => result.rejections).length,
    },
    cases: results,
  };
  const output = `${JSON.stringify(evidence, null, 2)}\n`;
  process.stdout.write(output);
  if (args.write) {
    const directory = new URL("../evidence/", import.meta.url);
    mkdirSync(directory, { recursive: true });
    writeFileSync(new URL("live-matrix-stellar-testnet.json", directory), output);
    log("evidence written to tools/conformance/evidence/live-matrix-stellar-testnet.json");
  }
  if (passed !== results.length) process.exit(1);
}

main().catch((error: unknown) => {
  log(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
