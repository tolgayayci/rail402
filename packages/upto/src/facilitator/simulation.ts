import { Address, scValToNative, xdr } from "@stellar/stellar-sdk";
import { SETTLED_EVENT, UptoContractError } from "../constants.ts";
import { reject, type UptoRejection } from "../errors.ts";
import { accountOrContractOf } from "../terms.ts";

/** A host error recorded as a diagnostic event: `topics = ["error", ScError]`, `data = message [, args…]`. */
export interface HostError {
  /** Contract that raised the error, when the event is contract-scoped. */
  readonly contract: string | undefined;
  /** Error type as the host names it: Contract, Auth, Crypto, Budget, Storage, Value, … */
  readonly type: string;
  /** The contract error number for Contract errors, otherwise the ScErrorCode name (e.g. ExistingValue). */
  readonly code: number | string;
  readonly message: string | undefined;
  readonly args: readonly unknown[];
}

/** Who is who in a settlement, for classifying failures and checking events. */
export interface SettlementParties {
  /** The settlement contract. */
  readonly contract: string;
  /** Hex sha256 of the settlement contract's WASM, when known. */
  readonly contractWasmHash?: string | undefined;
  readonly token: string;
  readonly payer: string;
  readonly recipient: string;
  readonly authority: string;
  readonly facilitatorAddresses: ReadonlySet<string>;
}

/**
 * Extracts the host errors from diagnostic events, oldest first. Unparseable events are skipped.
 *
 * @param events - A simulation's diagnostic events
 * @returns The host errors
 */
export function hostErrors(events: readonly xdr.DiagnosticEvent[]): HostError[] {
  const errors: HostError[] = [];
  for (const diagnostic of events) {
    try {
      const event = diagnostic.event();
      const body = event.body().v0();
      const [topic, errorTopic] = body.topics();
      if (topic?.switch() !== xdr.ScValType.scvSymbol() || topic.sym().toString() !== "error") continue;
      if (errorTopic?.switch() !== xdr.ScValType.scvError()) continue;
      const scError = errorTopic.error();
      const type = scError.switch().name.replace(/^sce/, "");
      const code =
        scError.switch() === xdr.ScErrorType.sceContract()
          ? scError.contractCode()
          : scError.code().name.replace(/^scec/, "");
      const data = body.data();
      let message: string | undefined;
      let args: unknown[] = [];
      if (data.switch() === xdr.ScValType.scvVec()) {
        const [first, ...rest] = data.vec() ?? [];
        message = first?.switch() === xdr.ScValType.scvString() ? first.str().toString() : undefined;
        args = rest.map(safeNative);
      } else if (data.switch() === xdr.ScValType.scvString()) {
        message = data.str().toString();
      }
      errors.push({ contract: contractOf(event), type, code, message, args });
    } catch {
      // A malformed or unfamiliar event carries no classification signal.
    }
  }
  return errors;
}

/**
 * Host errors named in a simulation's error string, for RPC responses that carry no diagnostic
 * events. The string starts with the error that ended the simulation (`HostError: Error(Auth,
 * InvalidAction)`) and may append the host's event log, newest first, one event per line:
 * `[Diagnostic Event] contract:C…, topics:[error, Error(Contract, #5)], data:["message", …]`. Errors
 * of the log keep their contract and message and are returned oldest first, like {@link hostErrors};
 * without a log, the leading error is returned without a contract.
 *
 * @param message - The simulation's error string
 * @returns The host errors it names
 */
export function hostErrorsFromMessage(message: string): HostError[] {
  const logged: HostError[] = [];
  for (const line of message.split("\n")) {
    const topic = /topics:\[error, Error\((\w+), #?(\w+)\)\]/.exec(line);
    if (topic === null) continue;
    const [, type = "", code = ""] = topic;
    logged.push({
      contract: /contract:(C[A-Z2-7]{55})\b/.exec(line)?.[1],
      type,
      code: parseCode(code),
      message: /data:\[?"([^"]*)"/.exec(line)?.[1],
      args: [],
    });
  }
  if (logged.length > 0) return logged.reverse();
  const leading = /Error\((\w+), #?(\w+)\)/.exec(message);
  if (leading === null) return [];
  const [, type = "", code = ""] = leading;
  return [{ contract: undefined, type, code: parseCode(code), message: undefined, args: [] }];
}

/**
 * A host error code: the contract error number, or the error code's name.
 *
 * @param code - The code as the host prints it, without `#`
 * @returns The number or the name
 */
function parseCode(code: string): number | string {
  return /^\d+$/.test(code) ? Number(code) : code;
}

/**
 * Whether the host failed to authenticate an address in the settlement: a `G…` account's signature,
 * weights or thresholds, or a contract account's `__check_auth`, refused the payer's entry. The host
 * reports it as `Error(Auth, InvalidAction)` "failed account authentication", raised in the frame
 * that required the authorization, after the account's own error. For a `G…` account that own error
 * is `Error(Contract, #5)` (the host's AuthenticationError, e.g. "signer does not belong to
 * account"), in the settlement contract's frame: the same number as the contract's `Expired`, which
 * is why authentication is decided first.
 *
 * @param errors - The host errors
 * @returns Whether an account failed authentication
 */
function accountAuthenticationFailed(errors: readonly HostError[]): boolean {
  return errors.some(
    (e) => e.type === "Auth" && e.message?.includes("failed account authentication") === true,
  );
}

/**
 * Maps the host errors of a failed settlement simulation to a stable code, attributing contract
 * errors by the contract that raised them: the settlement contract and a Stellar Asset Contract
 * share error numbers.
 *
 * @param errors - The simulation's host errors
 * @param parties - Who is who in the settlement
 * @param simulationError - The simulation's error string
 * @returns The refusal
 */
export function classifySimulationFailure(
  errors: readonly HostError[],
  parties: SettlementParties,
  simulationError: string,
): UptoRejection {
  const payerIsContract = parties.payer.startsWith("C");

  if (errors.some((e) => e.type === "Auth" && e.code === "ExistingValue")) {
    return reject("invalid_upto_stellar_payload_nonce_already_used");
  }

  const authenticationFailed = accountAuthenticationFailed(errors);

  // A contract error of the settlement contract's frame is the contract's own only when no account
  // failed authentication there. With an RPC that returns neither events nor an event log, the
  // error that ended the simulation has no contract; the settlement contract's numbers 1–5 are
  // still read as its own (a token's errors in a settlement are trustline, balance and account
  // errors, and #6 is also the Stellar Asset Contract's missing account).
  const fromContract = authenticationFailed
    ? undefined
    : errors.find(
        (e) =>
          e.type === "Contract" &&
          (e.contract === parties.contract ||
            (e.contract === undefined &&
              errors.length === 1 &&
              typeof e.code === "number" &&
              e.code >= UptoContractError.InvalidMaxAmount &&
              e.code <= UptoContractError.Expired)),
      );
  if (fromContract !== undefined) {
    const mapped = contractErrorRejection(fromContract.code);
    if (mapped !== undefined) return mapped;
  }

  // A smart-account payer, or a verifier or policy it calls from __check_auth, refused.
  const accountError = errors.find(
    (e) =>
      payerIsContract &&
      e.contract !== undefined &&
      e.contract !== parties.token &&
      e.contract !== parties.contract &&
      (e.type === "Contract" || e.type === "Crypto"),
  );
  if (accountError !== undefined) {
    return reject(
      "invalid_upto_stellar_payload_smart_account_rejected",
      `The payer's smart account rejected the authorization: Error(${accountError.type}, ${describeCode(accountError.code)}) from ${
        accountError.contract === parties.payer ? "the account" : String(accountError.contract)
      }.`,
    );
  }

  if (errors.some((e) => e.type === "Crypto")) {
    return payerIsContract
      ? reject("invalid_upto_stellar_payload_smart_account_rejected")
      : reject("invalid_upto_stellar_payload_invalid_signature");
  }

  const tokenError = errors.find((e) => e.type === "Contract" && e.contract === parties.token);
  if (tokenError !== undefined) {
    const mapped = tokenErrorRejection(tokenError, parties);
    if (mapped !== undefined) return mapped;
  }

  for (const error of errors) {
    if (error.type !== "Auth") continue;
    if (error.message?.includes("expired") === true) return reject("invalid_upto_stellar_signature_expired");
  }
  if (authenticationFailed) {
    const cause = errors.find((e) => e.type === "Contract" && e.message !== undefined);
    return payerIsContract
      ? reject("invalid_upto_stellar_payload_smart_account_rejected")
      : reject(
          "invalid_upto_stellar_payload_invalid_signature",
          cause?.message === undefined
            ? undefined
            : `The payer's account rejected the signature: ${cause.message}.`,
        );
  }

  const unauthorized = errors.find((e) => e.type === "Auth" && e.code === "InvalidAction");
  if (unauthorized !== undefined) {
    return reject(
      "invalid_upto_stellar_payload_invalid_signature",
      `The settlement is not authorized: ${unauthorized.message ?? "Error(Auth, InvalidAction)"}.`,
    );
  }

  const first = errors[0];
  const detail =
    first === undefined
      ? simulationError.split("\n")[0]?.trim()
      : `Error(${first.type}, ${describeCode(first.code)})${first.message === undefined ? "" : `: ${first.message}`}`;
  return reject(
    "invalid_upto_stellar_payload_simulation_failed",
    detail === undefined || detail === "" ? undefined : `Simulating the settlement failed with ${detail}.`,
  );
}

/**
 * Maps a settlement contract error to its refusal.
 *
 * @param code - The contract error number
 * @returns The refusal, or `undefined` for an unknown number
 */
function contractErrorRejection(code: number | string): UptoRejection | undefined {
  switch (code) {
    case UptoContractError.InvalidMaxAmount:
      return reject(
        "invalid_upto_stellar_payload_invalid_terms",
        "The authorized cap must be positive (contract error #1).",
      );
    case UptoContractError.NegativeAmount:
      return reject(
        "invalid_upto_stellar_requirements_invalid_amount",
        "The settlement amount is negative (contract error #2).",
      );
    case UptoContractError.AmountExceedsMax:
      return reject(
        "invalid_upto_stellar_payload_settlement_exceeds_amount",
        "The settlement amount exceeds the authorized cap (contract error #3).",
      );
    case UptoContractError.NotYetValid:
      return reject(
        "invalid_upto_stellar_payload_not_yet_valid",
        "The terms are not valid yet (contract error #4).",
      );
    case UptoContractError.Expired:
      return reject("invalid_upto_stellar_signature_expired", "The terms have expired (contract error #5).");
    case UptoContractError.InvalidRecipient:
      return reject(
        "invalid_upto_stellar_requirements_invalid_pay_to",
        "The recipient is the settlement contract (contract error #6).",
      );
    default:
      return undefined;
  }
}

/**
 * Token errors. Stellar Asset Contract numbers come from soroban-env-host `contract_error.rs`;
 * 100 is the OpenZeppelin fungible token's `InsufficientBalance`.
 *
 * @param error - A contract error raised by the token
 * @param parties - Who is who in the settlement
 * @returns The refusal, or `undefined` for an unknown error
 */
function tokenErrorRejection(error: HostError, parties: SettlementParties): UptoRejection | undefined {
  const subject = typeof error.args[0] === "string" ? error.args[0] : undefined;
  switch (error.code) {
    case 10:
    case 100:
      return reject("insufficient_funds");
    case 13:
      return subject === parties.recipient
        ? reject(
            "invalid_upto_stellar_payload_recipient_trustline_missing",
            `payTo ${parties.recipient} has no trustline for this asset and cannot receive it.`,
          )
        : reject(
            "invalid_upto_stellar_payload_payer_trustline_missing",
            `The payer ${parties.payer} has no trustline for this asset.`,
          );
    case 11:
      return reject(
        "invalid_upto_stellar_payload_trustline_not_authorized",
        `The trustline of ${subject ?? "an account in the settlement"} is not authorized by the asset issuer.`,
      );
    case 6:
      return reject(
        "invalid_upto_stellar_payload_account_missing",
        `Account ${subject ?? "in the settlement"} does not exist on this network.`,
      );
    default:
      return undefined;
  }
}

/**
 * Refuses a simulation that needs archived ledger entries restored. Since protocol 23 a freshly
 * simulated invocation restores archived entries itself (listed in `archivedSorobanEntries`), which
 * would make the fee payer rent them inside a payment. The settlement contract's own instance or
 * code has its own code so operators can act on it.
 *
 * @param data - The simulated transaction data
 * @param parties - Who is who in the settlement
 * @returns The refusal, or `undefined` when nothing is archived
 */
export function archivedStateRejection(
  data: xdr.SorobanTransactionData,
  parties: SettlementParties,
): UptoRejection | undefined {
  const ext = data.ext();
  if (ext.switch() !== 1) return undefined;
  const indices = ext.resourceExt().archivedSorobanEntries();
  if (indices.length === 0) return undefined;
  const readWrite = data.resources().footprint().readWrite();
  const archived = indices.map((index) => readWrite[index]);
  if (archived.some((key) => key !== undefined && isContractKey(key, parties))) {
    return reject("invalid_upto_stellar_settlement_contract_archived");
  }
  return reject(
    "invalid_upto_stellar_payload_archived_state",
    `The settlement needs ${indices.length} archived ledger entr${indices.length === 1 ? "y" : "ies"} restored first.`,
  );
}

/**
 * Whether a ledger key is the settlement contract's instance or code.
 *
 * @param key - The ledger key
 * @param parties - Who is who in the settlement
 * @returns Whether it belongs to the settlement contract
 */
function isContractKey(key: xdr.LedgerKey, parties: SettlementParties): boolean {
  if (key.switch() === xdr.LedgerEntryType.contractData()) {
    const data = key.contractData();
    return (
      Address.fromScAddress(data.contract()).toString() === parties.contract &&
      data.key().switch() === xdr.ScValType.scvLedgerKeyContractInstance()
    );
  }
  if (key.switch() === xdr.LedgerEntryType.contractCode()) {
    return (
      parties.contractWasmHash !== undefined &&
      key.contractCode().hash().toString("hex") === parties.contractWasmHash.toLowerCase()
    );
  }
  return false;
}

const BALANCE_EVENTS = new Set(["transfer", "mint", "burn", "clawback"]);

/**
 * Checks the contract events of a successful simulation: exactly one balance change, a `transfer`
 * of `amount` from the payer to payTo by the token (none when `amount` is zero), no balance event
 * involving a facilitator address, and exactly one matching `upto_settled` from the settlement
 * contract. Other events, such as `approve` or a smart-account policy's own events, are allowed.
 *
 * Both token event shapes are accepted: Stellar Asset Contracts publish
 * `[name, from, to, asset]` and SEP-41 contracts `[name, from, to]`; the data is the `i128` amount
 * or a map holding `amount` (and `to_muxed_id`). Nothing assumes a number of decimals.
 *
 * @param events - The simulation's diagnostic events
 * @param parties - Who is who in the settlement
 * @param amount - The amount being settled
 * @param maxAmount - The authorized cap
 * @returns The refusal, or `undefined` when the events are as expected
 */
export function checkSimulationEvents(
  events: readonly xdr.DiagnosticEvent[],
  parties: SettlementParties,
  amount: bigint,
  maxAmount: bigint,
): UptoRejection | undefined {
  const balanceChanges: {
    contract: string | undefined;
    name: string;
    topics: xdr.ScVal[];
    data: xdr.ScVal;
  }[] = [];
  const settled: { topics: xdr.ScVal[]; data: xdr.ScVal }[] = [];

  for (const diagnostic of events) {
    if (!diagnostic.inSuccessfulContractCall()) continue;
    const event = diagnostic.event();
    if (event.type() !== xdr.ContractEventType.contract()) continue;
    const body = event.body().v0();
    const topics = body.topics();
    const [first] = topics;
    if (first?.switch() !== xdr.ScValType.scvSymbol()) continue;
    const name = first.sym().toString();
    const contract = contractOf(event);
    if (BALANCE_EVENTS.has(name)) balanceChanges.push({ contract, name, topics, data: body.data() });
    else if (name === SETTLED_EVENT && contract === parties.contract)
      settled.push({ topics, data: body.data() });
  }

  const unexpected = (reason: string) =>
    reject("invalid_upto_stellar_payload_unexpected_balance_change", reason);
  for (const change of balanceChanges) {
    const involved = change.topics.slice(1).map((topic) => accountOrContractOf(topic));
    if (involved.some((address) => address !== undefined && parties.facilitatorAddresses.has(address))) {
      return unexpected(`A simulated ${change.name} event involves a facilitator account.`);
    }
  }
  if (amount === 0n) {
    if (balanceChanges.length > 0) {
      return unexpected(
        `A zero settlement must not move funds; the simulation emitted ${balanceChanges.length} balance event(s).`,
      );
    }
  } else {
    if (balanceChanges.length !== 1) {
      return unexpected(
        `The simulation emitted ${balanceChanges.length} balance events; exactly one transfer is expected.`,
      );
    }
    const [change] = balanceChanges;
    if (change === undefined || change.name !== "transfer") {
      return unexpected(`The simulation emitted a ${change?.name ?? "missing"} event instead of a transfer.`);
    }
    if (change.contract !== parties.token) {
      return unexpected(
        `The transfer event comes from ${String(change.contract)}, not the asset ${parties.token}.`,
      );
    }
    const from = accountOrContractOf(change.topics[1]);
    const to = accountOrContractOf(change.topics[2]);
    const moved = amountOf(change.data);
    if (from !== parties.payer || to !== parties.recipient || moved !== amount) {
      return unexpected(
        `The simulated transfer is ${String(moved)} from ${String(from)} to ${String(to)}; expected ${amount} from ${parties.payer} to ${parties.recipient}.`,
      );
    }
  }

  if (settled.length !== 1) {
    return reject(
      "invalid_upto_stellar_payload_settlement_event_mismatch",
      `The simulation emitted ${settled.length} upto_settled events; exactly one is expected.`,
    );
  }
  const [event] = settled;
  const fields = event === undefined ? undefined : mapOf(event.data);
  if (
    event === undefined ||
    fields === undefined ||
    accountOrContractOf(event.topics[1]) !== parties.payer ||
    accountOrContractOf(event.topics[2]) !== parties.recipient ||
    accountOrContractOf(fields.get("token")) !== parties.token ||
    accountOrContractOf(fields.get("facilitator")) !== parties.authority ||
    amountOf(fields.get("amount")) !== amount ||
    amountOf(fields.get("max_amount")) !== maxAmount
  ) {
    return reject("invalid_upto_stellar_payload_settlement_event_mismatch");
  }
  return undefined;
}

/**
 * An `i128` amount, or the `amount` field of a map; `undefined` for anything else.
 *
 * @param value - The event data
 * @returns The amount
 */
function amountOf(value: xdr.ScVal | undefined): bigint | undefined {
  if (value === undefined) return undefined;
  if (value.switch() === xdr.ScValType.scvI128()) {
    const parts = value.i128();
    return (parts.hi().toBigInt() << 64n) | parts.lo().toBigInt();
  }
  const fields = mapOf(value);
  return fields === undefined ? undefined : amountOf(fields.get("amount"));
}

/**
 * The symbol-keyed fields of a map `ScVal`.
 *
 * @param value - The value
 * @returns The fields, or `undefined` when it is not a map
 */
function mapOf(value: xdr.ScVal): Map<string, xdr.ScVal> | undefined {
  if (value.switch() !== xdr.ScValType.scvMap()) return undefined;
  const fields = new Map<string, xdr.ScVal>();
  for (const entry of value.map() ?? []) {
    const key = entry.key();
    if (key.switch() === xdr.ScValType.scvSymbol()) fields.set(key.sym().toString(), entry.val());
  }
  return fields;
}

/**
 * The contract that emitted an event.
 *
 * @param event - The event
 * @returns Its contract address, or `undefined` for a host event
 */
function contractOf(event: xdr.ContractEvent): string | undefined {
  const id = event.contractId();
  return id ? Address.fromScAddress(xdr.ScAddress.scAddressTypeContract(id)).toString() : undefined;
}

/**
 * A host error code as the host prints it.
 *
 * @param code - A contract error number or an error code name
 * @returns `#n` or the name
 */
function describeCode(code: number | string): string {
  return typeof code === "number" ? `#${code}` : code;
}

/**
 * Converts an `ScVal` to a native value, if it can.
 *
 * @param value - The value
 * @returns The native value, or `undefined`
 */
function safeNative(value: xdr.ScVal): unknown {
  try {
    return scValToNative(value);
  } catch {
    return undefined;
  }
}
