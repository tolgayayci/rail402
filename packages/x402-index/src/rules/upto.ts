import { xdr } from "@stellar/stellar-sdk";
import { transferOf, type ContractEventView } from "../events.ts";
import type { RegistryUptoContract } from "../registry.ts";
import { addressOf, i128Of, symbolMapOf, symbolOf, type AddressView } from "../xdr.ts";
import { excluded, isSource, NONE, operationSource, type RuleFacts, type RuleOutcome } from "./common.ts";

/**
 * The `upto_settled` events of the operation that the given contract emitted. Any contract can emit an
 * event with that name, so only the registry contract's own events are ever read.
 */
export function fromRegistryContract(
  events: readonly ContractEventView[],
  contract: string,
): readonly ContractEventView[] {
  return events.filter(
    (event) => event.contract === contract && symbolOf(event.topics[0]) === "upto_settled",
  );
}

/**
 * R-UPTO and R-UPTO-BETA (rules/v2.md section 4). `entry` is the registry entry of the invoked contract
 * for this ledger, if any. With `success: false` only U2 and U3 run, which decides whether a failed
 * transaction is a failed attempt.
 */
export function uptoRule(
  facts: RuleFacts,
  entry: RegistryUptoContract | undefined,
  success: boolean,
): RuleOutcome {
  const { view, operation } = facts;
  const invocation = operation.invocation;
  if (invocation?.fn !== "settle") return NONE;
  const emitted = fromRegistryContract(facts.events, invocation.contract).length > 0;
  // Only settle calls on registry contracts, or contracts that themselves emitted upto_settled, are
  // candidates; an upto_settled from another contract in the same call does not make one.
  if (entry === undefined && !emitted) return NONE;
  // U2 / B2: one operation.
  if (view.operations.length !== 1) return excluded("multi_operation");
  // U3: the contract is in the registry for this ledger.
  if (entry === undefined) return excluded("upto_unregistered_contract");
  // U4: if its instance shows in the meta, it runs the registered WASM.
  const wasm = facts.instanceWasm.get(invocation.contract);
  if (wasm !== undefined && (wasm.size !== 1 || !wasm.has(entry.wasmSha256)))
    return excluded("upto_wasm_mismatch");
  const authority = operationSource(facts).base;

  if (!success) {
    return {
      kind: "match",
      scheme: "upto",
      ruleId: entry.rule,
      payer: view.innerSource,
      payTo: "",
      payToMuxedId: null,
      amount: 0n,
      maxAmount: null,
      assetContract: "",
      assetTopic: null,
      upto: { contract: invocation.contract, authority },
      checks: entry.rule === "R-UPTO" ? ["U2", "U3", "U4"] : ["B2"],
    };
  }
  return entry.rule === "R-UPTO"
    ? canonical(facts, invocation.contract, invocation.args)
    : beta(facts, invocation.contract, authority);
}

/** The signed `settle(payer, terms, amount)` arguments of the canonical contract. */
interface SettleArguments {
  readonly payer: AddressView;
  readonly recipient: AddressView;
  readonly token: AddressView;
  readonly maxAmount: bigint;
  readonly facilitator: AddressView;
  readonly amount: bigint;
}

/** Reads `settle(payer: Address, terms: UptoTerms, amount: i128)`, or `undefined` when it does not read. */
export function settleArguments(args: readonly xdr.ScVal[]): SettleArguments | undefined {
  if (args.length !== 3) return undefined;
  const [payerArg, termsArg, amountArg] = args;
  const payer = addressOf(payerArg);
  const terms = symbolMapOf(termsArg);
  const amount = i128Of(amountArg);
  const recipient = addressOf(terms?.get("recipient"));
  const token = addressOf(terms?.get("token"));
  const maxAmount = i128Of(terms?.get("max_amount"));
  const facilitator = addressOf(terms?.get("facilitator"));
  if (
    payer === undefined ||
    amount === undefined ||
    recipient === undefined ||
    token === undefined ||
    maxAmount === undefined ||
    facilitator === undefined
  ) {
    return undefined;
  }
  return { payer, recipient, token, maxAmount, facilitator, amount };
}

const sameAddress = (a: AddressView, b: AddressView) =>
  a.base === b.base && a.kind === b.kind && a.muxedId === b.muxedId;

function canonical(facts: RuleFacts, contract: string, args: readonly xdr.ScVal[]): RuleOutcome {
  // U5: exactly one well-formed upto_settled event from the contract.
  const [event, ...more] = fromRegistryContract(facts.events, contract);
  if (event === undefined || more.length > 0 || event.topics.length !== 3)
    return excluded("transfer_event_mismatch");
  const payer = addressOf(event.topics[1]);
  const recipient = addressOf(event.topics[2]);
  const data = symbolMapOf(event.data);
  const token = addressOf(data?.get("token"));
  const amount = i128Of(data?.get("amount"));
  const maxAmount = i128Of(data?.get("max_amount"));
  const authority = addressOf(data?.get("facilitator"));
  if (
    payer === undefined ||
    recipient === undefined ||
    token?.kind !== "C" ||
    amount === undefined ||
    maxAmount === undefined ||
    authority === undefined ||
    amount < 0n ||
    amount > maxAmount
  ) {
    return excluded("transfer_event_mismatch");
  }
  // U5: the event reports exactly what the payer and the settlement authority signed.
  const signed = settleArguments(args);
  if (signed === undefined) return excluded("malformed");
  if (
    !sameAddress(signed.payer, payer) ||
    !sameAddress(signed.recipient, recipient) ||
    !sameAddress(signed.token, token) ||
    !sameAddress(signed.facilitator, authority) ||
    signed.amount !== amount ||
    signed.maxAmount !== maxAmount
  ) {
    return excluded("transfer_event_mismatch");
  }
  // U6: the token's transfers from the payer match the amount.
  const fromPayer = facts.events
    .filter((candidate) => candidate.contract === token.base)
    .map(transferOf)
    .filter((transfer) => transfer?.from === payer.base);
  let assetTopic: string | null = null;
  if (amount > 0n) {
    const [transfer, ...others] = fromPayer;
    if (
      transfer === undefined ||
      others.length > 0 ||
      transfer.to !== recipient.base ||
      transfer.toMemo !== null ||
      transfer.toMuxedId !== recipient.muxedId ||
      transfer.amount !== amount
    ) {
      return excluded("transfer_event_mismatch");
    }
    assetTopic = transfer.assetTopic;
  } else if (fromPayer.length > 0) return excluded("transfer_event_mismatch");
  // U7: the payer did not pay the fee.
  if (isSource(facts, payer.base)) return excluded("self_paid_fee");
  return {
    kind: "match",
    scheme: "upto",
    ruleId: "R-UPTO",
    payer,
    payTo: recipient.base,
    payToMuxedId: recipient.muxedId,
    amount,
    maxAmount,
    assetContract: token.base,
    assetTopic,
    upto: { contract, authority: authority.base },
    checks: ["U1", "U2", "U3", "U4", "U5", "U6", "U7"],
  };
}

function beta(facts: RuleFacts, contract: string, authority: string): RuleOutcome {
  // B3: exactly one transfer event, from someone other than the fee payer and the sources.
  const transfers = facts.events.map(transferOf).filter((transfer) => transfer !== undefined);
  const [transfer, ...others] = transfers;
  // Nothing signed names the seller here, so only a u64 muxed id (or none) is taken from the event: a
  // text or hash memo form never comes from a settle call, and its bytes are the emitter's choice.
  if (transfer === undefined || others.length > 0 || transfer.toMemo !== null)
    return excluded("transfer_event_mismatch");
  if (isSource(facts, transfer.from)) return excluded("self_paid_fee");
  const approvals = facts.events.filter(
    (event) =>
      event.contract === transfer.contract &&
      symbolOf(event.topics[0]) === "approve" &&
      addressOf(event.topics[1])?.base === transfer.from,
  );
  const [approval, ...moreApprovals] = approvals;
  const cap =
    approval !== undefined && moreApprovals.length === 0 ? approvedAmount(approval.data) : undefined;
  return {
    kind: "match",
    scheme: "upto",
    ruleId: "R-UPTO-BETA",
    payer: { base: transfer.from, kind: transfer.fromKind, muxedId: null },
    payTo: transfer.to,
    payToMuxedId: transfer.toMuxedId,
    amount: transfer.amount,
    maxAmount: cap ?? null,
    assetContract: transfer.contract,
    assetTopic: transfer.assetTopic,
    upto: { contract, authority },
    checks: ["B1", "B2", "B3"],
  };
}

/** The amount of a SEP-41 `approve` event: data `[amount: i128, expiration_ledger: u32]`. */
function approvedAmount(data: xdr.ScVal): bigint | undefined {
  if (data.switch() !== xdr.ScValType.scvVec()) return undefined;
  const items = data.vec();
  if (items?.length !== 2) return undefined;
  return i128Of(items[0]);
}
