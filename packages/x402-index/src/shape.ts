/**
 * The x402 shape of a single transaction without a registry: the structural part of R-EXACT and R-UPTO
 * that a buyer can check for any transaction, on any network, including a private one. It explains a
 * transaction (the SDK's `inspectTransaction` and the CLI's `tx`); it never counts one. Counting needs
 * `classifyTransaction`, which adds the event proofs, the upto registry and attribution.
 */
export interface ShapeInput {
  readonly operations: readonly { readonly function?: string; readonly contract?: string }[];
  /**
   * Address (and AddressV2) authorizations, in order. `proven` is whether the chain proves that the
   * address authorized the call, as check E7 of the indexing rules asks: a Stellar Asset Contract's
   * transfer by that address authenticated it, or the address's own key signed it. Unset is unproven.
   */
  readonly authorizations: readonly {
    readonly address: string;
    readonly subInvocations: number;
    readonly proven?: boolean;
  }[];
  /** The root contract invocations of those authorizations. */
  readonly invocations: readonly {
    readonly contract: string;
    readonly fn: string;
    readonly subInvocations: number;
  }[];
  /** Authorization entries with other credentials: source account or delegated. */
  readonly otherCredentials: number;
  /** Token transfers the transaction emitted. */
  readonly transfers: readonly { readonly from: string }[];
  readonly status: "SUCCESS" | "FAILED";
}

export interface Shape {
  readonly shape: "exact" | "upto" | "unknown";
  readonly checks: readonly string[];
}

/**
 * `exact` is one token transfer authorized by its payer alone; `upto` is one `settle` call authorized by
 * the payer (with its one approval) and by the settlement authority as the operation's source. An `exact`
 * check says the payer authorized the transfer only when `proven` says the chain proves it.
 */
export function x402Shape(input: ShapeInput): Shape {
  const { operations, authorizations, invocations, otherCredentials, transfers, status } = input;
  const checks: string[] = [];
  const [operation, ...moreOperations] = operations;
  const [authorization, ...moreAuthorizations] = authorizations;
  const [invocation] = invocations;
  if (operation?.function === "settle") {
    const upto =
      moreOperations.length === 0 &&
      authorization !== undefined &&
      moreAuthorizations.length === 0 &&
      otherCredentials === 1 &&
      invocation?.fn === "settle" &&
      invocation.contract === operation.contract &&
      invocation.subInvocations === 1;
    checks.push(moreOperations.length === 0 ? "one settle invocation" : "expected exactly one operation");
    if (authorization === undefined || moreAuthorizations.length > 0) {
      checks.push("expected exactly one payer authorization");
    } else {
      checks.push(`authorized by ${authorization.address} for its terms`);
      checks.push(
        authorization.subInvocations === 1 ? "one approval under the terms" : "unexpected sub-invocations",
      );
    }
    checks.push(
      otherCredentials === 1
        ? "the settlement authority authorized the amount as the operation source"
        : "no single settlement-authority authorization",
    );
    if (status === "SUCCESS") {
      const moved = transfers.filter(
        (transfer) => authorization !== undefined && transfer.from === authorization.address,
      );
      checks.push(
        moved.length === 0
          ? "no transfer from the payer (a zero settlement)"
          : moved.length === 1
            ? "one transfer from the payer"
            : "more than one transfer from the payer",
      );
      return { shape: upto && moved.length <= 1 ? "upto" : "unknown", checks };
    }
    checks.push("the transaction failed");
    return { shape: upto ? "upto" : "unknown", checks };
  }
  const exact =
    operation !== undefined &&
    moreOperations.length === 0 &&
    operation.function === "transfer" &&
    authorization !== undefined &&
    moreAuthorizations.length === 0 &&
    otherCredentials === 0 &&
    invocation?.fn === "transfer" &&
    invocation.contract === operation.contract &&
    invocation.subInvocations === 0;
  if (operation === undefined || moreOperations.length > 0) checks.push("expected exactly one operation");
  else if (operation.function !== "transfer") checks.push("the operation is not a token transfer");
  else checks.push("one token transfer invocation");
  if (authorization === undefined || moreAuthorizations.length > 0 || otherCredentials > 0) {
    checks.push("expected exactly one address authorization");
  } else {
    // A token that is not a Stellar Asset Contract can succeed without checking the entry at all.
    checks.push(
      authorization.proven === true
        ? `authorized by ${authorization.address} alone`
        : `an authorization entry for ${authorization.address} alone, not proven by the chain`,
    );
    if (authorization.subInvocations === 0) checks.push("no sub-invocations");
    else checks.push("the authorization has sub-invocations");
  }
  if (status === "SUCCESS") {
    const matching = transfers.filter(
      (transfer) => authorization !== undefined && transfer.from === authorization.address,
    );
    checks.push(matching.length === 1 ? "one transfer from the payer" : "no single transfer from the payer");
  } else {
    checks.push("the transaction failed");
  }
  return { shape: exact ? "exact" : "unknown", checks };
}
