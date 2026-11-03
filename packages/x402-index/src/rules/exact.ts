import { verifySacAsset } from "../asset.ts";
import { signedByPayer } from "../authorization.ts";
import { transferOf } from "../events.ts";
import type { CheckId } from "../types.ts";
import { addressOf, i128Of } from "../xdr.ts";
import { excluded, isSource, NONE, sameScVal, type RuleFacts, type RuleOutcome } from "./common.ts";

/**
 * R-EXACT (rules/v2.md section 3). With `success: false` only the envelope checks E2 to E5 run, which
 * decides whether a failed transaction is a failed attempt.
 */
export function exactRule(facts: RuleFacts, success: boolean): RuleOutcome {
  const { view, operation } = facts;
  const invocation = operation.invocation;
  if (invocation?.fn !== "transfer" || invocation.args.length !== 3) return NONE;
  // E2: one operation, transfer(from: Address, to: Address, amount: i128 > 0).
  if (view.operations.length !== 1) return excluded("multi_operation");
  const [fromArg, toArg, amountArg] = invocation.args;
  const from = addressOf(fromArg);
  const to = addressOf(toArg);
  const amount = i128Of(amountArg);
  if (
    from === undefined ||
    from.muxedId !== null ||
    to === undefined ||
    amount === undefined ||
    amount <= 0n
  ) {
    return excluded("malformed");
  }
  // E3: exactly one authorization, Address or AddressV2 credentials naming `from`. Only E7 decides
  // whether the entry proves anything.
  const [authorization, ...more] = operation.authorizations;
  if (authorization === undefined || more.length > 0) return excluded("multi_auth");
  if (authorization.credential === "source_account") return excluded("self_paid_fee");
  if (authorization.credential === "address_with_delegates") return excluded("delegated_credentials");
  if (authorization.address?.base !== from.base || authorization.address.muxedId !== null) {
    return excluded("malformed");
  }
  // E4: the entry's root invocation is exactly this transfer, with no sub-invocations.
  const root = authorization.root;
  if (
    root === null ||
    root.contract !== invocation.contract ||
    root.fn !== "transfer" ||
    root.args.length !== 3 ||
    !root.args.every((arg, index) => {
      const own = invocation.args[index];
      return own !== undefined && sameScVal(arg, own);
    })
  ) {
    return excluded("malformed");
  }
  if (authorization.subInvocations > 0) return excluded("sub_invocations");
  // E5: someone other than the payer paid the fee.
  if (isSource(facts, from.base)) return excluded("self_paid_fee");

  const checks: CheckId[] = ["E2", "E3", "E4", "E5"];
  if (!success) {
    return {
      kind: "match",
      scheme: "exact",
      ruleId: "R-EXACT",
      payer: from,
      payTo: to.base,
      payToMuxedId: to.muxedId,
      amount,
      maxAmount: null,
      assetContract: invocation.contract,
      assetTopic: null,
      upto: null,
      checks,
    };
  }
  // E6: exactly one transfer event from the token, matching the arguments.
  const transfers = facts.events
    .filter((event) => event.contract === invocation.contract)
    .map(transferOf)
    .filter((transfer) => transfer !== undefined);
  const [event, ...others] = transfers;
  if (
    event === undefined ||
    others.length > 0 ||
    event.from !== from.base ||
    event.to !== to.base ||
    event.toMemo !== null ||
    event.toMuxedId !== to.muxedId ||
    event.amount !== amount
  ) {
    return excluded("transfer_event_mismatch");
  }
  // E7: consensus-bound data proves that `from` authorized this transfer. The network authenticates an
  // address entry only when a contract asks for it, and a token that is not a Stellar Asset Contract
  // decides that itself: one that never calls from.require_auth() succeeds with an entry nobody signed.
  const sac = verifySacAsset(invocation.contract, event.assetTopic, facts.passphrase).verified;
  if (!sac && !signedByPayer(authorization.entry, from, facts.networkId, facts.ledger)) {
    return excluded("unproven_authorization");
  }
  return {
    kind: "match",
    scheme: "exact",
    ruleId: "R-EXACT",
    payer: from,
    payTo: to.base,
    payToMuxedId: to.muxedId,
    amount: event.amount,
    maxAmount: null,
    assetContract: invocation.contract,
    assetTopic: event.assetTopic,
    upto: null,
    checks: ["E1", ...checks, "E6", "E7"],
  };
}
