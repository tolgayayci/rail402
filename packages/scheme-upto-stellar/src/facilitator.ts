import {
  Address,
  BASE_FEE,
  Operation,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { Api } from "@stellar/stellar-sdk/rpc";
import {
  gatherAuthEntrySignatureStatus,
  getNetworkPassphrase,
  getRpcClient,
  isStellarNetwork,
  type FacilitatorStellarSigner,
  type RpcConfig,
} from "@x402/stellar";
import { createError, type ErrorCode } from "@rail402/errors";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { ARG, SETTLE_ARG_COUNT, SETTLE_FN, uptoContractFor } from "./constants.js";
import type { UptoStellarPayloadV2 } from "./types.js";

/**
 * Facilitator side of `upto` on Stellar.
 *
 * ## The phase-dependent amount, which is the whole scheme
 *
 * `paymentRequirements.amount` means different things at different times:
 *
 * - at **verify**, it is the **ceiling** the client is being asked to authorize;
 * - at **settle**, it is the **actual metered charge**, set by the resource server.
 *
 * A facilitator that enforces `amount === maxAmount` at settle time rejects every partial
 * settlement and breaks `upto` entirely. The generic spec calls this out as a conformance note
 * precisely because it is the easy mistake.
 *
 * ## Why substitution is safe
 *
 * At settle we replace argument 6 (`actual_amount`) in an already-signed transaction. That would
 * normally be tampering — except the client's `require_auth_for_args` covers
 * `(token, to, max_amount, expiration_ledger, nonce)` and deliberately **not** `actual_amount`.
 * Substituting it therefore cannot invalidate the signature, while every value that protects the
 * client stays cryptographically bound. Verified on-ledger: 13 contract tests, including ones that
 * prove substituting the recipient or raising the ceiling *does* fail authorization.
 *
 * The contract re-asserts `actual <= max` on-ledger regardless, so a compromised facilitator still
 * cannot overcharge. We check it here as well to fail fast with a legible reason.
 */


/**
 * Detect a replayed authorization.
 *
 * Captured from a real testnet replay, not guessed. There are TWO independent replay defences and
 * they fire in a specific order:
 *
 *   1. **Soroban's own auth-entry nonce** — consumed by the host during `require_auth_for_args`.
 *      A straightforward replay dies here with `Error(Auth, ExistingValue)` /
 *      "nonce already exists for address", and the contract body never runs.
 *   2. **The contract's nonce map** (`AuthorizationAlreadyUsed`, error #3) — defence in depth,
 *      reached only if an authorization somehow clears the host check with a contract-level nonce
 *      that was already spent.
 *
 * We match both. An earlier version matched only #3 and mis-reported every ordinary replay as a
 * generic simulation failure — the host defence fires first, so #3 is the case you almost never see.
 */
export function isReplayForTest(simulationError: string): boolean {
  return isReplay(simulationError);
}

function isReplay(simulationError: string): boolean {
  return (
    /Error\(Auth, ExistingValue\)/.test(simulationError) ||
    /nonce already exists/i.test(simulationError) ||
    /Error\(Contract, #3\)/.test(simulationError)
  );
}

const SUPPORTED_X402_VERSION = 2;
const DEFAULT_TIMEOUT_SECONDS = 60;

/** Stellar's target close time. The same estimate `exact` and our client use. */
const ESTIMATED_LEDGER_SECONDS = 5;
/**
 * RPC-skew tolerance, mirroring `@x402/stellar`'s `maxLedger + 2` in the exact scheme.
 *
 * The spec states no tolerance, but the reference implementation allows two ledgers because
 * `getLatestLedger` can lag the network. Diverging here would reject payments every other
 * facilitator accepts, so we mirror it and note the disagreement.
 */
const LEDGER_SKEW_TOLERANCE = 2;

/**
 * Largest authorization window we will accept, in ledgers.
 *
 * Derived from the payment terms rather than fixed, so a resource server asking for a longer
 * `maxTimeoutSeconds` gets a proportionally longer window and nothing else does.
 */
function maxLedgerWindow(maxTimeoutSeconds: number | undefined): number {
  const seconds = maxTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  return Math.ceil(seconds / ESTIMATED_LEDGER_SECONDS) + LEDGER_SKEW_TOLERANCE;
}

/**
 * Parse an attacker-supplied atomic amount without throwing. `BigInt("NaN")`, `BigInt("1e9")` and
 * `BigInt("10.5")` all throw, and this runs on the echoed `payload.maxAmount` inside `decode` — which
 * is called OUTSIDE verify/settle's try block — so an unguarded throw surfaced as a retryable
 * HTTP 500 with a raw V8 message on the wire. Returns `null` for anything non-integer.
 */
function parseIntegerAmount(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return Number.isSafeInteger(value) ? BigInt(value) : null;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    try {
      return BigInt(value.trim());
    } catch {
      return null;
    }
  }
  return null;
}

function invalid(reason: ErrorCode, payer?: string, message?: string): VerifyResponse {
  const e = createError(reason, message === undefined ? {} : { reason: message });
  return { isValid: false, invalidReason: e.code, invalidMessage: e.reason, ...(payer ? { payer } : {}) };
}

interface DecodedSettle {
  transaction: Transaction;
  invokeOp: Operation.InvokeHostFunction;
  contract: string;
  token: string;
  from: string;
  to: string;
  maxAmount: bigint;
  expirationLedger: number;
  nonceHex: string;
}

export interface UptoStellarFacilitatorOptions {
  rpcConfig?: RpcConfig;
  areFeesSponsored?: boolean;
  /**
   * Largest total transaction fee (base + Soroban resource fee), in stroops, the facilitator will
   * sign and submit. The facilitator is the tx source and pays this from its own XLM, so it is the
   * operator's circuit breaker against an unexpectedly expensive settlement. `exact` enforces the
   * same ceiling; without it here, `upto` settlements — which for a smart-account payer cross-call a
   * verifier and a spending policy and cost several times a keypair payment — would submit uncapped.
   * Undefined means no ceiling (the caller opted out).
   */
  maxTransactionFeeStroops?: number;
}

export class UptoStellarFacilitatorScheme implements SchemeNetworkFacilitator {
  readonly scheme = "upto";
  readonly caipFamily = "stellar:*";

  private readonly signers: Map<string, FacilitatorStellarSigner>;
  private readonly addresses: ReadonlySet<string>;
  private readonly options: UptoStellarFacilitatorOptions;
  private next = 0;

  constructor(signers: FacilitatorStellarSigner[], options: UptoStellarFacilitatorOptions = {}) {
    if (!signers.length) throw new Error("At least one signer is required");
    this.signers = new Map(signers.map(s => [s.address, s]));
    this.addresses = new Set(this.signers.keys());
    this.options = options;
  }

  getExtra(network: Network): Record<string, unknown> | undefined {
    const contract = uptoContractFor(network);
    if (!contract) return undefined;
    return { uptoContract: contract, areFeesSponsored: this.options.areFeesSponsored ?? true };
  }

  getSigners(): string[] {
    return [...this.addresses];
  }

  /**
   * Verify at the CEILING phase: `requirements.amount` is the maximum the client authorizes.
   */
  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    const decoded = this.decode(payload, requirements);
    if ("error" in decoded) return decoded.error;
    const d = decoded.value;

    const requiredCeiling = parseIntegerAmount(requirements.amount);
    if (requiredCeiling === null) {
      return invalid(
        "invalid_payment_requirements",
        d.from,
        `requirements.amount (${String(requirements.amount)}) is not an integer.`,
      );
    }
    if (d.maxAmount !== requiredCeiling) {
      return invalid(
        "invalid_upto_stellar_payload_wrong_max_amount",
        d.from,
        `The signed ceiling is ${d.maxAmount} but the requirements ask to authorize ${requirements.amount}. At verification time these must match exactly.`,
      );
    }

    // Structural authorization check before any RPC: closes the zero-auth gap (a zero-auth payload
    // simulates successfully in recording mode, so simulation alone is not a signature check) and is
    // unit-testable without a ledger. The signature-presence and expiration checks that need the
    // simulation run below in `validateAuthEntries`.
    const structuralAuthError = this.structuralAuthCheck(d.invokeOp);
    if (structuralAuthError) return invalid(structuralAuthError, d.from);

    try {
      const server = getRpcClient(requirements.network, this.options.rpcConfig);

      const { sequence } = await server.getLatestLedger();
      if (d.expirationLedger < sequence) {
        return invalid(
          "invalid_upto_stellar_payload_expired",
          d.from,
          `The authorization expired at ledger ${d.expirationLedger}; the network is at ${sequence}.`,
        );
      }

      // …and an upper bound, which is the half that was missing. The exact scheme bounds validity by `maxTimeoutSeconds` (~12 ledgers at the 60s default); `upto` is our own
      // code and checked only that the authorization had not already expired. An unbounded window
      // is a standing claim on the payer's balance, and past ~24h it also outlives the contract's
      // consumed-nonce record.
      const maxLedgers = maxLedgerWindow(requirements.maxTimeoutSeconds);
      if (d.expirationLedger > sequence + maxLedgers) {
        return invalid(
          "invalid_upto_stellar_payload_expiration_too_far",
          d.from,
          `The authorization is valid until ledger ${d.expirationLedger}, which is ${d.expirationLedger - sequence} ledgers ahead; at most ${maxLedgers} are permitted for a maxTimeoutSeconds of ${requirements.maxTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS}. Sign a window that matches the payment terms.`,
        );
      }

      const sim = await server.simulateTransaction(d.transaction);
      if (!Api.isSimulationSuccess(sim)) {
        // The contract's own AuthorizationAlreadyUsed (error #3) surfaces here.
        const text = Api.isSimulationError(sim) ? (sim.error ?? "") : "";
        if (isReplay(text)) {
          return invalid(
            "invalid_upto_stellar_payload_authorization_used",
            d.from,
            "This authorization has already been settled. Each one is single-use; sign a fresh nonce.",
          );
        }
        return invalid("invalid_upto_stellar_payload_simulation_failed", d.from);
      }

      // Signature-presence and expiration, which need the simulated ledger. Together with the
      // pre-RPC structural check above this means a payload signed by nobody now fails
      // instead of verifying as valid.
      const authError = this.validateAuthEntries(d, sequence + maxLedgers, sim);
      if (authError) return authError;
    } catch (error) {
      return invalid(
        "unexpected_verify_error",
        d.from,
        error instanceof Error ? error.message : "Unexpected error verifying the authorization.",
      );
    }

    return { isValid: true, payer: d.from };
  }

  /**
   * Settle at the ACTUAL phase: `requirements.amount` is the metered charge.
   */
  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    const network = payload.accepted.network;
    const fail = (code: ErrorCode, payer?: string, message?: string): SettleResponse => {
      const e = createError(code, message === undefined ? {} : { reason: message });
      return {
        success: false,
        network,
        transaction: "",
        errorReason: e.code,
        // The field stock consumers read: `x402HTTPResourceServer` surfaces
        // `errorMessage || errorReason`, so without it a buyer is shown a bare code string.
        errorMessage: e.reason,
        ...(payer ? { payer } : {}),
        extra: { reason: e.reason, retryable: e.retryable },
      } as SettleResponse;
    };

    const decoded = this.decode(payload, requirements);
    if ("error" in decoded) {
      return fail(
        (decoded.error.invalidReason ?? "unexpected_settle_error") as ErrorCode,
        decoded.error.payer,
        decoded.error.invalidMessage,
      );
    }
    const d = decoded.value;

    // Re-verify against the SIGNED CEILING, never against requirements.amount. Comparing the
    // signature to the metered amount would reject every partial settlement.
    const actual = parseIntegerAmount(requirements.amount);
    if (actual === null) {
      return fail(
        "invalid_payment_requirements",
        d.from,
        `requirements.amount (${String(requirements.amount)}) is not an integer.`,
      );
    }
    if (actual < 0n) {
      return fail("invalid_upto_stellar_payload_settlement_exceeds_amount", d.from, "A negative settlement amount is not permitted.");
    }
    if (actual > d.maxAmount) {
      return fail(
        "invalid_upto_stellar_payload_settlement_exceeds_amount",
        d.from,
        `Attempted to settle ${actual} against a client-authorized ceiling of ${d.maxAmount}. The contract would reject this on-ledger; refusing here.`,
      );
    }

    // A zero-auth payload would simulate in recording mode and submit a doomed transaction that
    // burns the operator's sponsored fee. Reject it before any RPC. Positioned after the amount
    // checks so a wrong-amount settle still reports the wrong-amount reason.
    const structuralAuthError = this.structuralAuthCheck(d.invokeOp);
    if (structuralAuthError) return fail(structuralAuthError, d.from);

    // A zero charge still goes on-ledger, and deliberately so.
    //
    // Skipping the transaction saves a fee, and that is the wrong trade: it leaves the client's
    // authorization UNCONSUMED while telling the resource server the payment cycle completed. The
    // authorization then remains spendable up to the full ceiling until its expiration ledger, so
    // anyone holding the payload — a compromised or dishonest resource server, most obviously —
    // can come back and settle it for real. "Single-use" has to mean used.
    //
    // The contract's zero path is cheap by construction: it consumes the nonce and returns before
    // any `approve` or `transfer_from`, so this costs one sponsored fee and moves no tokens. That
    // is the correct price for making the guarantee true, and it also keeps the facilitator and the
    // contract telling the same story about what a zero settlement means.

    try {
      const server = getRpcClient(requirements.network, this.options.rpcConfig);
      const passphrase = getNetworkPassphrase(requirements.network);

      // Substitute the metered amount. Safe precisely because it sits outside the signed tuple.
      const withActual = this.substituteActualAmount(d, actual, passphrase);

      const sim = await server.simulateTransaction(withActual);
      if (!Api.isSimulationSuccess(sim)) {
        const text = Api.isSimulationError(sim) ? (sim.error ?? "") : "";
        if (isReplay(text)) {
          return fail("invalid_upto_stellar_payload_authorization_used", d.from);
        }
        if (/Error\(Contract, #1\)/.test(text)) {
          return fail("invalid_upto_stellar_payload_settlement_exceeds_amount", d.from);
        }
        return fail("invalid_upto_stellar_payload_simulation_failed", d.from);
      }

      // The operator's fee ceiling, enforced BEFORE signing so the facilitator never submits a
      // settlement more expensive than it agreed to sponsor. `exact` enforces the identical bound;
      // omitting it here (the previous state) meant a `MAX_TRANSACTION_FEE_STROOPS` circuit breaker
      // silently did not apply to `upto`, and a smart-account settlement at ~174k stroops would be
      // signed under a 100k ceiling regardless. The total fee is the base fee plus the simulated
      // Soroban resource fee, which is exactly what the rebuilt transaction below will charge.
      const max = this.options.maxTransactionFeeStroops;
      if (max !== undefined) {
        const totalFee = Number(BASE_FEE) + Number(sim.minResourceFee ?? 0);
        if (totalFee > max) {
          return fail(
            "invalid_upto_stellar_payload_fee_exceeds_maximum",
            d.from,
            `The settlement fee is ${totalFee} stroops (base ${BASE_FEE} + resource ${sim.minResourceFee}), above the configured maximum of ${max}. Raise MAX_TRANSACTION_FEE_STROOPS to serve this payer.`,
          );
        }
      }

      const signer = this.selectSigner();
      const source = await server.getAccount(signer.address);
      const rebuilt = new TransactionBuilder(source, {
        fee: BASE_FEE,
        networkPassphrase: passphrase,
        sorobanData: sim.transactionData.build(),
      })
        .setTimeout(requirements.maxTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS)
        .addOperation(Operation.invokeHostFunction(withActual.operations[0] as Operation.InvokeHostFunction))
        .build();

      const { signedTxXdr, error } = await signer.signTransaction(rebuilt.toXDR(), {
        networkPassphrase: passphrase,
      });
      if (error) return fail("settle_exact_stellar_transaction_signing_failed", d.from);

      const sent = await server.sendTransaction(
        TransactionBuilder.fromXDR(signedTxXdr, passphrase) as Transaction,
      );
      if (sent.status !== "PENDING") {
        return fail("settle_exact_stellar_transaction_submission_failed", d.from);
      }

      const confirmed = await this.poll(server, sent.hash, requirements.maxTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS);
      if (!confirmed) {
        // This path previously returned a bare code with no reason at all — the one shape the error contract
        // forbids outright. It also keeps the transaction hash, which `fail()` cannot express: the
        // transaction was submitted and may yet land, so discarding its hash would leave an
        // operator unable to reconcile a settlement dispute.
        const e = createError("settle_exact_stellar_transaction_failed");
        return {
          success: false,
          network,
          transaction: sent.hash,
          errorReason: e.code,
          errorMessage: e.reason,
          payer: d.from,
          extra: { reason: e.reason, retryable: e.retryable },
        } as SettleResponse;
      }

      return {
        success: true,
        transaction: sent.hash,
        network,
        payer: d.from,
        amount: actual.toString(),
      } as SettleResponse;
    } catch (error) {
      return fail(
        "unexpected_settle_error",
        d.from,
        error instanceof Error ? error.message : "Unexpected settlement error.",
      );
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** Decode and structurally validate. Everything here is attacker-controlled input. */
  private decode(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): { value: DecodedSettle } | { error: VerifyResponse } {
    if (payload.x402Version !== SUPPORTED_X402_VERSION) {
      return { error: invalid("invalid_x402_version") };
    }
    if (payload.accepted.scheme !== "upto" || requirements.scheme !== "upto") {
      return { error: invalid("unsupported_scheme") };
    }
    if (requirements.network !== payload.accepted.network) {
      return { error: invalid("network_mismatch") };
    }
    if (!isStellarNetwork(requirements.network)) {
      return { error: invalid("invalid_network") };
    }

    const expected = uptoContractFor(requirements.network);
    if (!expected) {
      return {
        error: invalid(
          "invalid_network",
          undefined,
          `No upto settlement contract is deployed for ${requirements.network}.`,
        ),
      };
    }

    const raw = payload.payload as unknown as UptoStellarPayloadV2 | undefined;
    if (!raw || typeof raw.transaction !== "string") {
      return { error: invalid("invalid_upto_stellar_payload_malformed") };
    }

    let transaction: Transaction;
    try {
      transaction = new Transaction(raw.transaction, getNetworkPassphrase(requirements.network));
    } catch {
      return { error: invalid("invalid_upto_stellar_payload_malformed") };
    }

    if (transaction.operations.length !== 1) {
      return { error: invalid("invalid_upto_stellar_payload_malformed", undefined, "Expected exactly one operation.") };
    }
    const op = transaction.operations[0];
    if (!op || op.type !== "invokeHostFunction") {
      return { error: invalid("invalid_upto_stellar_payload_malformed", undefined, "Expected an invokeHostFunction operation.") };
    }
    const invokeOp = op as Operation.InvokeHostFunction;

    // Facilitator safety, identical in spirit to `exact`: we must never be a party to the transfer.
    if (this.addresses.has(transaction.source) || this.addresses.has(invokeOp.source ?? "")) {
      return { error: invalid("invalid_exact_stellar_payload_unsafe_tx_or_op_source") };
    }

    let args: xdr.ScVal[];
    let contract: string;
    let fn: string;
    try {
      const invoke = invokeOp.func.invokeContract();
      contract = Address.fromScAddress(invoke.contractAddress()).toString();
      fn = invoke.functionName().toString();
      args = invoke.args();
    } catch {
      return { error: invalid("invalid_upto_stellar_payload_malformed") };
    }

    if (contract !== expected) {
      return {
        error: invalid(
          "invalid_upto_stellar_payload_wrong_contract",
          undefined,
          `The transaction invokes ${contract}, but the canonical upto contract for ${requirements.network} is ${expected}.`,
        ),
      };
    }
    if (fn !== SETTLE_FN || args.length !== SETTLE_ARG_COUNT) {
      return {
        error: invalid(
          "invalid_upto_stellar_payload_malformed",
          undefined,
          `Expected ${SETTLE_FN}() with ${SETTLE_ARG_COUNT} arguments; got ${fn}() with ${args.length}.`,
        ),
      };
    }

    let token: string, from: string, to: string, maxAmount: bigint, expirationLedger: number, nonceHex: string;
    try {
      token = scValToNative(args[ARG.TOKEN]!) as string;
      from = scValToNative(args[ARG.FROM]!) as string;
      to = scValToNative(args[ARG.TO]!) as string;
      maxAmount = scValToNative(args[ARG.MAX_AMOUNT]!) as bigint;
      expirationLedger = Number(scValToNative(args[ARG.EXPIRATION_LEDGER]!));
      nonceHex = Buffer.from(scValToNative(args[ARG.NONCE]!) as Buffer).toString("hex");
    } catch {
      return { error: invalid("invalid_upto_stellar_payload_malformed") };
    }

    if (this.addresses.has(from)) {
      return { error: invalid("invalid_exact_stellar_payload_facilitator_is_payer") };
    }
    if (token !== requirements.asset) {
      return { error: invalid("invalid_exact_stellar_payload_wrong_asset", from) };
    }
    if (to !== requirements.payTo) {
      return { error: invalid("invalid_exact_stellar_payload_wrong_recipient", from) };
    }

    // The echoed convenience fields are never authoritative — reject any disagreement with the XDR.
    // Parse defensively: `raw.maxAmount` is attacker-controlled and `BigInt()` throws on a
    // non-integer string, which `decode` (outside the try block) would turn into a retryable 500.
    if (raw.maxAmount !== undefined) {
      const echoed = parseIntegerAmount(raw.maxAmount);
      if (echoed === null) {
        return {
          error: invalid(
            "invalid_upto_stellar_payload_malformed",
            from,
            `payload.maxAmount (${String(raw.maxAmount)}) is not an integer amount.`,
          ),
        };
      }
      if (echoed !== maxAmount) {
        return {
          error: invalid(
            "invalid_upto_stellar_payload_malformed",
            from,
            `payload.maxAmount (${echoed}) disagrees with the signed transaction (${maxAmount}). The transaction is authoritative.`,
          ),
        };
      }
    }

    return {
      value: { transaction, invokeOp, contract, token, from, to, maxAmount, expirationLedger, nonceHex },
    };
  }

  /**
   * Structural authorization-entry checks that need no ledger, run before any RPC in both `verify`
   * and `settle`. The load-bearing one is non-emptiness: a payload with zero auth entries simulates
   * successfully in recording mode, so without this `/verify` returned `isValid: true` for a payload
   * signed by nobody and `/settle` would submit a doomed transaction that burns the
   * operator's sponsored fee. Returns the error code, or `undefined` if the entries are sound.
   */
  private structuralAuthCheck(invokeOp: Operation.InvokeHostFunction): ErrorCode | undefined {
    const auth = invokeOp.auth ?? [];
    if (auth.length === 0) {
      return "invalid_exact_stellar_payload_no_auth_entries";
    }
    for (const entry of auth) {
      if (entry.credentials().switch() !== xdr.SorobanCredentialsType.sorobanCredentialsAddress()) {
        return "invalid_exact_stellar_payload_unsupported_credential_type";
      }
      const authAddress = Address.fromScAddress(entry.credentials().address().address()).toString();
      if (this.addresses.has(authAddress)) {
        return "invalid_exact_stellar_payload_facilitator_in_auth";
      }
    }
    return undefined;
  }

  /**
   * The ledger-dependent half of authorization validation, run after a successful simulation.
   *
   * `@x402/stellar`'s exact scheme validates auth entries in `validateAuthEntries`; `upto` is our own
   * code and previously skipped it, establishing authorization from `Api.isSimulationSuccess` alone —
   * which is NOT a signature check, because an empty auth tree simulates in recording mode and
   * succeeds. The structural checks (present, address credentials, no facilitator in the
   * tree) run before the RPC in `structuralAuthCheck`; here we add the two that need the simulated
   * ledger: the auth-entry signature has not expired, and the payer actually signed. We deliberately
   * do NOT reject sub-invocations — the legitimate `upto` tree carries the token `approve` as a
   * sub-invocation of `settle` (see `client.ts`), where the exact scheme's single `transfer` never
   * has one.
   */
  private validateAuthEntries(
    d: DecodedSettle,
    maxLedger: number,
    sim: Api.SimulateTransactionResponse,
  ): VerifyResponse | undefined {
    // Every entry is an address credential by construction (checked in `structuralAuthCheck`), so
    // `.address()` is safe.
    for (const entry of d.invokeOp.auth ?? []) {
      if (entry.credentials().address().signatureExpirationLedger() > maxLedger) {
        return invalid("invalid_exact_stellar_signature_expiration_too_far", d.from);
      }
    }
    // Signature-presence is the load-bearing check: an unsigned entry has a void signature and lands
    // in `pendingSignature`, so requiring the payer in `alreadySigned` rejects a payload that
    // carries an entry structurally but was never signed.
    const status = gatherAuthEntrySignatureStatus({ transaction: d.transaction, simulationResponse: sim });
    if (!status.alreadySigned.includes(d.from)) {
      return invalid("invalid_exact_stellar_payload_missing_payer_signature", d.from);
    }
    return undefined;
  }

  /**
   * Rebuild the invocation with `actual_amount` replaced.
   *
   * Every other argument is carried across untouched, including the settlement `hook`, which sits
   * outside the client's signed tuple exactly as `actual_amount` does. The auth entries sign
   * `(token, to, max_amount, expiration_ledger, nonce)`, so replacing `actual_amount` and leaving
   * the hook in place cannot invalidate them.
   */
  private substituteActualAmount(d: DecodedSettle, actual: bigint, passphrase: string): Transaction {
    const invoke = d.invokeOp.func.invokeContract();
    const args = [...invoke.args()];
    args[ARG.ACTUAL_AMOUNT] = nativeToScVal(actual, { type: "i128" });

    const func = xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: invoke.contractAddress(),
        functionName: invoke.functionName(),
        args,
      }),
    );

    return new TransactionBuilder(
      { accountId: () => d.transaction.source, sequenceNumber: () => d.transaction.sequence, incrementSequenceNumber: () => {} } as never,
      { fee: BASE_FEE, networkPassphrase: passphrase },
    )
      .addOperation(Operation.invokeHostFunction({ func, auth: d.invokeOp.auth ?? [] }))
      .setTimeout(DEFAULT_TIMEOUT_SECONDS)
      .build();
  }

  private selectSigner(): FacilitatorStellarSigner {
    const list = [...this.signers.values()];
    return list[this.next++ % list.length]!;
  }

  private async poll(
    server: ReturnType<typeof getRpcClient>,
    hash: string,
    attempts: number,
  ): Promise<boolean> {
    for (let i = 0; i < attempts; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const got = await server.getTransaction(hash);
        if (got.status === "SUCCESS") return true;
        if (got.status === "FAILED") return false;
      } catch {
        /* keep polling */
      }
    }
    return false;
  }
}
