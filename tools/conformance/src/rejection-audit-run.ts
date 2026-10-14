/**
 * The rejection audit: every way a running Rail402 refuses a request, sent over HTTP, each answer
 * checked for a registered code the case expects and a non-empty reason. Used by `rejection-audit.ts`
 * (public testnet) and by its integration test (private network), which differ only in how accounts
 * and the accepted asset are provided.
 *
 * A refusal takes one of three wire shapes: `{isValid:false, invalidReason, invalidMessage}` from
 * `/verify`, `{success:false, errorReason, errorMessage}` from `/settle`, and
 * `{error:{code, reason, retryable}}` from every other route and transport-level refusal. A body may
 * carry an x402 shape and `error` together; every code in it is checked.
 */
import {
  Asset,
  FeeBumpTransaction,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import {
  buildTransfer,
  deploySimpleAccount,
  requirementsFor,
  smartAccountPayment,
  type LocalNetwork,
  type PaymentRequirementsLike,
} from "@rail402.dev/testkit";
import type { EvidenceRejection } from "./evidence.ts";
import { CaseRecorder, baseUrl, supportedSigners, type CaseContext } from "./harness.ts";

/** Longest reason a refusal may carry. */
export const MAX_REASON_LENGTH = 300;

export interface AuditOptions {
  readonly facilitator: string;
  /** `/supported` of the facilitator, verbatim. */
  readonly supported: unknown;
  readonly net: LocalNetwork;
  /** The asset contract the facilitator accepts. */
  readonly asset: string;
  /** Registered codes; anything else fails the case. */
  readonly isRegistered: (code: string) => boolean;
  readonly accounts: AuditAccounts;
  /** A second deployment of the same service that requires an API key. */
  readonly keyedFacilitator?: string;
  /** A second deployment whose per-client rate limit is small (3 per minute or less). */
  readonly limitedFacilitator?: string;
  /** Deploy a smart account for the C… wrong-key case. */
  readonly smartAccount?: boolean;
  /** Run only these case ids. */
  readonly only?: readonly string[];
  readonly log?: (message: string) => void;
}

/** Accounts the audit needs, funded by the caller. */
export interface AuditAccounts {
  /** G… accounts with a trustline and at least 0.1 of the asset each; three are used. */
  readonly payers: readonly Keypair[];
  /** payTo: a G… account with a trustline. */
  readonly payTo: string;
  /** A funded G… account without a trustline to the asset. */
  readonly untrusted: Keypair;
  /** A G… account with a trustline and one base unit. */
  readonly poor: Keypair;
  /** A funded G… account that pays for the smart-account deployment and sources its payments. */
  readonly deployer: Keypair;
  /** Moves `amount` base units of the asset to any address. */
  readonly fund: (to: string, amount: bigint) => Promise<void>;
}

/** One request that must be refused. */
interface Probe {
  readonly surface: EvidenceRejection["surface"];
  readonly operation: string;
  readonly url: string;
  readonly init?: RequestInit;
  /** Codes the answer may carry; every code it carries must be one of them. */
  readonly expected: readonly string[];
  readonly status?: number;
}

interface Refusal {
  readonly codes: string[];
  readonly reasons: string[];
}

/** The codes and reasons of a refusal body in any of the three wire shapes; `undefined` if it is none. */
export function refusalOf(value: unknown): Refusal | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const codes: string[] = [];
  const reasons: string[] = [];
  if (record["isValid"] === false) {
    codes.push(text(record["invalidReason"]));
    reasons.push(text(record["invalidMessage"]));
  }
  if (record["success"] === false) {
    codes.push(text(record["errorReason"]));
    reasons.push(text(record["errorMessage"]));
  }
  const error = record["error"];
  if (error !== null && typeof error === "object") {
    const coded = error as Record<string, unknown>;
    codes.push(text(coded["code"]));
    reasons.push(text(coded["reason"]));
    if (typeof coded["retryable"] !== "boolean") reasons.push("");
  }
  return codes.length === 0 ? undefined : { codes, reasons };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Sends a probe and checks its refusal: the status when the case fixes one, at least one code, every
 * code registered and expected, every reason non-blank and at most MAX_REASON_LENGTH characters.
 * Records each code as a rejection and throws on the first violation.
 */
export async function probe(
  context: CaseContext,
  isRegistered: (code: string) => boolean,
  request: Probe,
): Promise<string[]> {
  const response = await fetch(request.url, request.init);
  const body: unknown = await response.json().catch(() => undefined);
  const refusal = refusalOf(body);
  const where = `${request.operation} (HTTP ${String(response.status)})`;
  if (refusal === undefined) throw new Error(`${where} is not a refusal: ${JSON.stringify(body)}`);
  refusal.codes.forEach((code, index) => {
    context.rejection({
      surface: request.surface,
      operation: request.operation,
      httpStatus: response.status,
      code: code === "" ? "missing_code" : code,
      reason: refusal.reasons[index]?.trim() || "(empty)",
    });
  });
  if (request.status !== undefined && response.status !== request.status) {
    throw new Error(`${where}: expected HTTP ${String(request.status)}`);
  }
  for (const code of refusal.codes) {
    if (!isRegistered(code)) throw new Error(`${where}: code "${code}" is not registered`);
    if (!request.expected.includes(code)) {
      throw new Error(`${where}: code ${code}, expected ${request.expected.join(" | ")}`);
    }
  }
  for (const reason of refusal.reasons) {
    if (reason.trim() === "")
      throw new Error(`${where}: a refusal without a reason (or without error.retryable)`);
    if (reason.length > MAX_REASON_LENGTH)
      throw new Error(`${where}: reason longer than ${String(MAX_REASON_LENGTH)}`);
  }
  context.observe("expectedCodes", request.expected);
  return refusal.codes;
}

const json = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

/** Runs every audit case and returns the recorder holding their evidence. */
export async function runRejectionAudit(options: AuditOptions): Promise<CaseRecorder> {
  const recorder = new CaseRecorder(options.only);
  const base = baseUrl(options.facilitator);
  const { net, asset, accounts, isRegistered } = options;
  const [payerA, payerB, payerC] = accounts.payers;
  if (payerA === undefined || payerB === undefined || payerC === undefined) {
    throw new Error("the audit needs three funded payers");
  }
  const signers = supportedSigners(options.supported);
  const facilitatorAccount = signers[0];
  if (facilitatorAccount === undefined) throw new Error("/supported advertises no Stellar signers");

  const call = (
    context: CaseContext,
    operation: "verify" | "settle",
    paymentPayload: unknown,
    paymentRequirements: unknown,
    expected: readonly string[],
    extra: Record<string, unknown> = {},
  ) =>
    probe(context, isRegistered, {
      surface: "facilitator",
      operation: `POST /${operation}`,
      url: `${base}/${operation}`,
      init: json({ x402Version: 2, paymentPayload, paymentRequirements, ...extra }),
      expected,
      status: 200,
    });
  /** Verify and settle must both refuse with one of `expected`. */
  const both = async (
    context: CaseContext,
    payload: unknown,
    requirements: unknown,
    expected: readonly string[],
  ) => {
    await call(context, "verify", payload, requirements, expected);
    await call(context, "settle", payload, requirements, expected);
  };
  const wrap = (requirements: PaymentRequirementsLike, transaction: string, payloadBody?: unknown) => ({
    x402Version: 2,
    resource: { url: "https://seller.example/resource" },
    accepted: requirements,
    payload: payloadBody ?? { transaction },
  });
  const terms = (amount = 1_000n, payTo = accounts.payTo, maxTimeoutSeconds = 60) =>
    requirementsFor(asset, payTo, amount, maxTimeoutSeconds);
  /** An offline-built transfer signed by the payer (the stock client's shape without simulation). */
  const offline = async (
    payer: Keypair,
    options: Parameters<typeof buildTransfer>[0] & { requirements?: PaymentRequirementsLike } = {},
  ) => {
    const requirements =
      options.requirements ?? terms(options.amount ?? 1_000n, options.to ?? accounts.payTo);
    const built = await buildTransfer({
      payer,
      asset,
      to: requirements.payTo,
      amount: BigInt(requirements.amount),
      nonce: BigInt(Math.floor(Math.random() * 2 ** 40)),
      expirationLedger: (await net.latestLedger()) + 10,
      ...options,
    });
    return { payload: wrap(requirements, built.xdr), requirements, xdr: built.xdr };
  };
  const signed = async (payer: Keypair, requirements = terms(), expirationLedger?: number) => {
    const payload = await net.payment(
      payer,
      requirements,
      expirationLedger === undefined ? {} : { expirationLedger },
    );
    return { payload, requirements, xdr: payload.payload.transaction };
  };
  const facilitatorCase = (id: string, title: string, run: (context: CaseContext) => Promise<void>) =>
    recorder.run({ id, title, checks: ["rejection-codes"], scheme: "exact" }, run);

  // --- transport ------------------------------------------------------------------------------------
  const transport = (id: string, title: string, run: (context: CaseContext) => Promise<void>) =>
    recorder.run({ id, title, checks: ["rejection-codes"] }, run);

  await transport(
    "body-too-large",
    "a request body over the limit is refused before parsing",
    async (context) => {
      for (const operation of ["verify", "settle"]) {
        await probe(context, isRegistered, {
          surface: "http",
          operation: `POST /${operation}`,
          url: `${base}/${operation}`,
          init: json({ padding: "x".repeat(200_000) }),
          expected: ["payload_too_large"],
          status: 413,
        });
      }
    },
  );
  await transport("unsupported-media-type", "a body that is not JSON is refused", async (context) => {
    await probe(context, isRegistered, {
      surface: "http",
      operation: "POST /verify",
      url: `${base}/verify`,
      init: { method: "POST", headers: { "content-type": "text/plain" }, body: "x" },
      expected: ["unsupported_media_type"],
      status: 415,
    });
  });
  await transport(
    "malformed-json",
    "malformed JSON and a body of the wrong shape are refused",
    async (context) => {
      for (const body of ["{not json", "[]", JSON.stringify({ x402Version: 2 })]) {
        await probe(context, isRegistered, {
          surface: "http",
          operation: "POST /verify",
          url: `${base}/verify`,
          init: json(body),
          expected: ["invalid_payload", "bad_request"],
          status: 400,
        });
      }
    },
  );
  await transport("unknown-route", "unknown routes and methods are refused", async (context) => {
    for (const [path, method] of [
      ["/nope", "GET"],
      ["/verify", "GET"],
      ["/supported", "POST"],
    ] as const) {
      await probe(context, isRegistered, {
        surface: "http",
        operation: `${method} ${path}`,
        url: `${base}${path}`,
        init: { method },
        expected: ["not_found"],
        status: 404,
      });
    }
  });
  if (options.keyedFacilitator === undefined) {
    recorder.skip(
      {
        id: "api-key-required",
        title: "a deployment that requires an API key refuses requests without one",
        checks: ["rejection-codes"],
      },
      "no deployment with REQUIRE_API_KEY=true was given (--keyed); pnpm evidence starts one locally",
    );
  } else {
    const keyed = baseUrl(options.keyedFacilitator);
    await transport(
      "api-key-required",
      "a deployment that requires an API key refuses requests without one",
      async (context) => {
        const { payload, requirements } = await offline(payerA);
        for (const headers of [{}, { authorization: "Bearer wrong" }] as Record<string, string>[]) {
          await probe(context, isRegistered, {
            surface: "http",
            operation: "POST /verify",
            url: `${keyed}/verify`,
            init: json(
              { x402Version: 2, paymentPayload: payload, paymentRequirements: requirements },
              headers,
            ),
            expected: ["unauthorized"],
            status: 401,
          });
        }
      },
    );
  }
  if (options.limitedFacilitator === undefined) {
    recorder.skip(
      { id: "rate-limited", title: "a client over the rate limit is refused", checks: ["rejection-codes"] },
      "no deployment with a small RATE_LIMIT_PER_MINUTE was given (--limited); pnpm evidence starts one locally",
    );
  } else {
    const limited = baseUrl(options.limitedFacilitator);
    await transport("rate-limited", "a client over the rate limit is refused", async (context) => {
      for (let attempt = 0; attempt < 20; attempt++) {
        const response = await fetch(`${limited}/supported`);
        await response.body?.cancel();
        if (response.status === 429) break;
      }
      await probe(context, isRegistered, {
        surface: "http",
        operation: "GET /supported",
        url: `${limited}/supported`,
        expected: ["rate_limited"],
        status: 429,
      });
    });
  }

  // --- protocol and requirements ------------------------------------------------------------------------
  await facilitatorCase("x402-version-1", "an x402 v1 request is refused", async (context) => {
    const { payload, requirements } = await offline(payerA);
    for (const operation of ["verify", "settle"] as const) {
      await probe(context, isRegistered, {
        surface: "facilitator",
        operation: `POST /${operation}`,
        url: `${base}/${operation}`,
        init: json({
          x402Version: 1,
          paymentPayload: { ...payload, x402Version: 1 },
          paymentRequirements: requirements,
        }),
        expected: ["invalid_payload", "bad_request"],
        status: 400,
      });
    }
  });
  await facilitatorCase("unknown-network", "an unknown or unserved network is refused", async (context) => {
    const { payload, requirements } = await offline(payerA);
    for (const network of ["stellar:pubnet", "eip155:8453"]) {
      await both(context, payload, { ...requirements, network }, ["invalid_network"]);
    }
  });
  await facilitatorCase("unknown-scheme", "an unknown scheme is refused", async (context) => {
    const { payload, requirements } = await offline(payerA);
    for (const scheme of ["escrow", "deferred"]) {
      await both(context, payload, { ...requirements, scheme }, ["unsupported_scheme"]);
    }
  });
  await facilitatorCase(
    "asset-not-accepted",
    "an asset the facilitator does not accept is refused",
    async (context) => {
      const other = new Asset("TEST", Keypair.random().publicKey()).contractId(net.passphrase);
      const { payload, requirements } = await offline(payerA, {
        requirements: requirementsFor(other, accounts.payTo, 1_000n),
      });
      await both(context, payload, requirements, ["invalid_exact_stellar_requirements_asset_not_accepted"]);
    },
  );
  await facilitatorCase(
    "fees-not-sponsored",
    "requirements without areFeesSponsored are refused",
    async (context) => {
      const { payload, requirements } = await offline(payerA);
      await both(context, payload, { ...requirements, extra: { areFeesSponsored: false } }, [
        "invalid_exact_stellar_requirements_fees_not_sponsored",
      ]);
    },
  );
  await facilitatorCase(
    "timeout-out-of-range",
    "maxTimeoutSeconds outside the accepted range is refused",
    async (context) => {
      const { payload, requirements } = await offline(payerA);
      for (const maxTimeoutSeconds of [86_400, 1]) {
        await both(context, payload, { ...requirements, maxTimeoutSeconds }, [
          "invalid_exact_stellar_requirements_timeout_out_of_range",
        ]);
      }
    },
  );
  await facilitatorCase(
    "amount-invalid",
    "a zero, negative or non-integer amount is refused",
    async (context) => {
      const { payload, requirements } = await offline(payerA);
      for (const amount of ["0", "-5", "1.5", "abc"]) {
        await both(context, payload, { ...requirements, amount }, [
          "invalid_exact_stellar_requirements_invalid_amount",
          "invalid_exact_stellar_requirements_amount_out_of_range",
          "invalid_payload",
        ]);
      }
    },
  );
  await facilitatorCase(
    "payto-invalid",
    "a payTo that is not a Stellar address is refused",
    async (context) => {
      const { payload, requirements } = await offline(payerA);
      await both(context, payload, { ...requirements, payTo: "GNOTANADDRESS" }, [
        "invalid_exact_stellar_requirements_invalid_pay_to",
        "invalid_payload",
      ]);
    },
  );

  // --- payload structure ------------------------------------------------------------------------------
  await facilitatorCase(
    "payload-wrong-key",
    "a payload that is not { transaction } is refused",
    async (context) => {
      const { requirements, xdr: transaction } = await offline(payerA);
      await both(context, wrap(requirements, "", { tx: transaction }), requirements, [
        "invalid_exact_stellar_payload_malformed",
        "invalid_payload",
      ]);
    },
  );
  await facilitatorCase(
    "payload-not-xdr",
    "a transaction that is not base64 XDR is refused",
    async (context) => {
      const requirements = terms();
      await both(context, wrap(requirements, "!!not-base64!!"), requirements, [
        "invalid_exact_stellar_payload_malformed",
      ]);
    },
  );
  await facilitatorCase("payload-too-large", "a transaction over 64 KiB is refused", async (context) => {
    const requirements = terms();
    await both(context, wrap(requirements, "A".repeat(66_000)), requirements, [
      "invalid_exact_stellar_payload_too_large",
      "payload_too_large",
    ]);
  });
  await facilitatorCase(
    "fee-bump-envelope",
    "a fee-bump envelope instead of the signed transaction is refused",
    async (context) => {
      const { requirements, xdr: transaction } = await offline(payerA);
      const inner = TransactionBuilder.fromXDR(transaction, net.passphrase);
      if (inner instanceof FeeBumpTransaction) throw new Error("fixture");
      const bump = TransactionBuilder.buildFeeBumpTransaction(payerA, "200", inner, net.passphrase);
      bump.sign(payerA);
      await both(context, wrap(requirements, bump.toXDR()), requirements, [
        "invalid_exact_stellar_payload_malformed",
      ]);
    },
  );
  await facilitatorCase(
    "multiple-operations",
    "a transaction with more than one operation is refused",
    async (context) => {
      const { payload, requirements } = await offline(payerA, { extraOperation: true });
      await both(context, payload, requirements, ["invalid_exact_stellar_payload_wrong_operation"]);
    },
  );
  await facilitatorCase("not-a-transfer", "a call other than transfer is refused", async (context) => {
    const { requirements, xdr: transaction } = await offline(payerA);
    const envelope = xdr.TransactionEnvelope.fromXDR(transaction, "base64");
    const operation = envelope.v1().tx().operations()[0]?.body().invokeHostFunctionOp();
    if (operation === undefined) throw new Error("fixture");
    operation.hostFunction().invokeContract().functionName("approve");
    await both(context, wrap(requirements, envelope.toXDR("base64")), requirements, [
      "invalid_exact_stellar_payload_wrong_function_name",
    ]);
  });
  await facilitatorCase(
    "unsigned-authorization",
    "an authorization without the payer's signature is refused",
    async (context) => {
      const { payload, requirements } = await offline(payerA, { sign: false });
      await both(context, payload, requirements, [
        "invalid_exact_stellar_payload_missing_payer_signature",
        "invalid_exact_stellar_payload_invalid_signature",
      ]);
    },
  );
  await facilitatorCase(
    "facilitator-as-cosigner",
    "an authorization entry for a facilitator account is refused",
    async (context) => {
      const { payload, requirements } = await offline(payerA, {
        extraAuthorization: { signer: Keypair.fromPublicKey(facilitatorAccount), sign: false },
      });
      await both(context, payload, requirements, ["invalid_exact_stellar_payload_facilitator_in_auth"]);
    },
  );
  await facilitatorCase(
    "sub-invocations",
    "an authorization with sub-invocations is refused",
    async (context) => {
      const { payload, requirements } = await offline(payerA, { subInvocation: true });
      await both(context, payload, requirements, ["invalid_exact_stellar_payload_has_subinvocations"]);
    },
  );
  await facilitatorCase(
    "source-account-credential",
    "a source-account credential is refused",
    async (context) => {
      const { payload, requirements } = await offline(payerA, { credential: "source_account" });
      await both(context, payload, requirements, [
        "invalid_exact_stellar_payload_unsupported_credential_type",
        "invalid_exact_stellar_payload_missing_payer_signature",
      ]);
    },
  );
  await facilitatorCase(
    "facilitator-as-source",
    "a transaction sourced from a facilitator account is refused",
    async (context) => {
      const { payload, requirements } = await offline(payerA, { source: facilitatorAccount });
      await both(context, payload, requirements, ["invalid_exact_stellar_payload_unsafe_tx_or_op_source"]);
    },
  );
  await facilitatorCase(
    "facilitator-as-payer",
    "a transfer from a facilitator account is refused",
    async (context) => {
      const { payload, requirements } = await offline(Keypair.fromPublicKey(facilitatorAccount), {
        sign: false,
        source: payerA.publicKey(),
      });
      await both(context, payload, requirements, [
        "invalid_exact_stellar_payload_facilitator_is_payer",
        "invalid_exact_stellar_payload_facilitator_in_auth",
      ]);
    },
  );
  await facilitatorCase(
    "mismatched-requirements",
    "a payment that differs from the requirements is refused",
    async (context) => {
      const { payload } = await offline(payerA);
      const other = Keypair.random().publicKey();
      for (const requirements of [terms(2_000n), terms(1_000n, other)]) {
        await both(context, { ...payload, accepted: requirements }, requirements, [
          "invalid_exact_stellar_payload_wrong_amount",
          "invalid_exact_stellar_payload_wrong_recipient",
        ]);
        await both(context, payload, requirements, [
          "invalid_exact_stellar_payload_accepted_mismatch",
          "invalid_exact_stellar_payload_wrong_amount",
          "invalid_exact_stellar_payload_wrong_recipient",
        ]);
      }
    },
  );
  await facilitatorCase(
    "tampered-amount",
    "a changed amount fails the payer's signed authorization",
    async (context) => {
      const { xdr: transaction } = await signed(payerA);
      const requirements = terms(9_000n);
      const envelope = xdr.TransactionEnvelope.fromXDR(transaction, "base64");
      const operation = envelope.v1().tx().operations()[0]?.body().invokeHostFunctionOp();
      const authorized = operation?.auth()[0]?.rootInvocation().function().contractFn();
      if (operation === undefined || authorized === undefined) throw new Error("fixture");
      const amount = nativeToScVal(9_000n, { type: "i128" });
      operation.hostFunction().invokeContract().args()[2] = amount;
      authorized.args()[2] = amount;
      await both(context, wrap(requirements, envelope.toXDR("base64")), requirements, [
        "invalid_exact_stellar_payload_invalid_signature",
      ]);
    },
  );

  // --- time -----------------------------------------------------------------------------------------------
  await facilitatorCase("expired", "an expired authorization is refused", async (context) => {
    const { payload, requirements } = await signed(payerB, terms(), (await net.latestLedger()) - 10);
    await both(context, payload, requirements, ["invalid_exact_stellar_signature_expired"]);
  });
  await facilitatorCase(
    "expires-too-soon",
    "an authorization expiring at the current ledger is refused",
    async (context) => {
      const { payload, requirements } = await signed(payerB, terms(), await net.latestLedger());
      await call(context, "settle", payload, requirements, [
        "invalid_exact_stellar_signature_expiration_too_soon",
        "invalid_exact_stellar_signature_expired",
      ]);
    },
  );
  await facilitatorCase(
    "expires-too-far",
    "an authorization expiring beyond maxTimeoutSeconds is refused",
    async (context) => {
      const { payload, requirements } = await signed(payerB, terms(), (await net.latestLedger()) + 5_000);
      await both(context, payload, requirements, ["invalid_exact_stellar_signature_expiration_too_far"]);
    },
  );

  // --- accounts and balances --------------------------------------------------------------------------------
  await facilitatorCase(
    "payer-no-trustline",
    "a payer without a trustline to the asset is named",
    async (context) => {
      const { payload, requirements } = await offline(accounts.untrusted);
      await both(context, payload, requirements, ["invalid_exact_stellar_payload_payer_trustline_missing"]);
    },
  );
  await facilitatorCase(
    "payto-no-trustline",
    "a payTo without a trustline to the asset is named",
    async (context) => {
      const { payload, requirements } = await offline(payerB, {
        requirements: terms(1_000n, accounts.untrusted.publicKey()),
      });
      await both(context, payload, requirements, [
        "invalid_exact_stellar_payload_recipient_trustline_missing",
      ]);
    },
  );
  await facilitatorCase(
    "insufficient-balance",
    "a payer holding less than the amount is refused",
    async (context) => {
      const { payload, requirements } = await offline(accounts.poor);
      await both(context, payload, requirements, ["insufficient_funds"]);
    },
  );
  await facilitatorCase(
    "payer-account-missing",
    "a payer account that does not exist is named",
    async (context) => {
      const { payload, requirements } = await offline(Keypair.random());
      await both(context, payload, requirements, ["invalid_exact_stellar_payload_account_missing"]);
    },
  );
  await facilitatorCase("self-payment", "a payer paying its own account is refused", async (context) => {
    const { payload, requirements } = await signed(payerB, terms(1_000n, payerB.publicKey()));
    await both(context, payload, requirements, ["invalid_exact_stellar_payload_self_payment"]);
  });
  if (options.smartAccount === false) {
    recorder.skip(
      {
        id: "c-payer-wrong-key",
        title: "a C… payment signed by the wrong key is refused",
        checks: ["rejection-codes"],
        scheme: "exact",
        payer: "C",
      },
      "smart-account cases were turned off for this run",
    );
  } else {
    await recorder.run(
      {
        id: "c-payer-wrong-key",
        title: "a C… payment signed by the wrong key is refused",
        checks: ["rejection-codes"],
        scheme: "exact",
        payer: "C",
      },
      async (context) => {
        const owner = Keypair.random();
        const account = await deploySimpleAccount(net, accounts.deployer, owner);
        await accounts.fund(account, 10_000n);
        const requirements = terms();
        const payload = await smartAccountPayment(net, {
          account,
          owner,
          signWith: Keypair.random(),
          source: accounts.deployer,
          requirements,
        });
        await both(context, payload, requirements, [
          "invalid_exact_stellar_payload_invalid_signature",
          "invalid_exact_stellar_payload_smart_account_rejected",
        ]);
      },
    );
  }

  // --- replay -----------------------------------------------------------------------------------------------
  await facilitatorCase(
    "replay",
    "a settled authorization is refused in a new envelope and by verify",
    async (context) => {
      const { payload, requirements, xdr: transaction } = await signed(payerC);
      const settled = await fetch(
        `${base}/settle`,
        json({ x402Version: 2, paymentPayload: payload, paymentRequirements: requirements }),
      );
      const answer = (await settled.json()) as { success?: boolean; transaction?: string };
      if (answer.success !== true)
        throw new Error(`the payment to replay did not settle: ${JSON.stringify(answer)}`);
      context.observe("settledTransaction", answer.transaction);
      const envelope = xdr.TransactionEnvelope.fromXDR(transaction, "base64");
      envelope
        .v1()
        .tx()
        .fee(envelope.v1().tx().fee() + 1);
      await call(context, "settle", wrap(requirements, envelope.toXDR("base64")), requirements, [
        "settle_exact_stellar_idempotency_conflict",
      ]);
      await call(context, "verify", payload, requirements, [
        "invalid_exact_stellar_payload_nonce_already_used",
      ]);
    },
  );

  // --- Bazaar discovery and search ------------------------------------------------------------------------
  const get = (
    surface: "bazaar" | "search",
    context: CaseContext,
    path: string,
    expected: readonly string[],
    status: number,
  ) =>
    probe(context, isRegistered, {
      surface,
      operation: `GET ${path.split("?")[0] ?? path}`,
      url: `${base}${path}`,
      expected,
      status,
    });
  await recorder.run(
    {
      id: "discovery-parameters",
      title: "invalid discovery parameters are refused",
      checks: ["rejection-codes", "discovery"],
    },
    async (context) => {
      for (const query of [
        "type=HTTP",
        "payTo=GNOTANADDRESS",
        "network=stellar",
        "limit=0",
        "limit=abc",
        "offset=-1",
        "unknown=1",
      ]) {
        await get("bazaar", context, `/discovery/resources?${query}`, ["discovery_invalid_parameter"], 400);
      }
    },
  );
  await recorder.run(
    {
      id: "discovery-not-found",
      title: "an unknown listing is refused",
      checks: ["rejection-codes", "discovery"],
    },
    async (context) => {
      for (const path of [
        "/discovery/resources/not-an-id",
        "/discovery/resources/00000000-0000-4000-8000-000000000000",
        "/discovery/resources/00000000-0000-4000-8000-000000000000/versions",
      ]) {
        await get("bazaar", context, path, ["discovery_listing_not_found"], 404);
      }
    },
  );
  recorder.skip(
    {
      id: "bazaar-cataloging",
      title: "cataloging outcomes reported in EXTENSION-RESPONSES",
      checks: ["rejection-codes", "discovery"],
    },
    "cataloging codes need sellers with Bazaar metadata; the live Bazaar run records them",
  );
  await recorder.run(
    {
      id: "search-query",
      title: "missing, blank and over-long queries are refused",
      checks: ["rejection-codes", "discovery"],
    },
    async (context) => {
      await get("search", context, "/discovery/search", ["discovery_invalid_parameter"], 400);
      await get("search", context, "/discovery/search?query=%20%20", ["search_query_required"], 400);
      await get(
        "search",
        context,
        `/discovery/search?query=${"a".repeat(501)}`,
        ["search_query_too_long"],
        400,
      );
      await get(
        "search",
        context,
        `/discovery/search?query=${"a".repeat(2_001)}`,
        ["discovery_invalid_parameter"],
        400,
      );
    },
  );
  await recorder.run(
    {
      id: "search-cursor",
      title: "malformed and foreign cursors are refused",
      checks: ["rejection-codes", "discovery"],
    },
    async (context) => {
      for (const cursor of ["abc", "x".repeat(200)]) {
        await get(
          "search",
          context,
          `/discovery/search?query=weather&cursor=${cursor}`,
          ["search_invalid_cursor"],
          400,
        );
      }
      await get(
        "search",
        context,
        `/discovery/search?query=weather&cursor=${"x".repeat(600)}`,
        ["discovery_invalid_parameter"],
        400,
      );
    },
  );
  await recorder.run(
    {
      id: "search-filters",
      title: "invalid search filters are refused",
      checks: ["rejection-codes", "discovery"],
    },
    async (context) => {
      for (const query of ["maxPrice=cheap", "asset=not-an-asset!", "limit=0", "sort=price"]) {
        await get(
          "search",
          context,
          `/discovery/search?query=weather&${query}`,
          ["discovery_invalid_parameter"],
          400,
        );
      }
    },
  );
  return recorder;
}
