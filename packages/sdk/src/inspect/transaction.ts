import {
  Address,
  FeeBumpTransaction,
  TransactionBuilder,
  scValToNative,
  xdr,
  type Transaction,
  rpc,
} from "@stellar/stellar-sdk";
import { getAddressCredentials } from "@x402/stellar";
import {
  baseAccount,
  networkPassphrase,
  sacTransferEvents,
  type AssetFacts,
  type StellarNetwork,
} from "@rail402.dev/stellar";
import { paymentError } from "../codes.ts";
import { explorerUrl, type ExplorerProvider } from "../explorer.ts";
import { toDecimal } from "../money.ts";
import { sanitizeText } from "../redact.ts";

/**
 * A Stellar transaction explained for an x402 buyer: who paid the fee, what was invoked, which
 * authorizations it carried and what moved. It never includes signature bytes or envelope XDR.
 */
export interface TransactionReport {
  readonly hash: string;
  readonly network: StellarNetwork;
  readonly status: "SUCCESS" | "FAILED";
  readonly ledger: number;
  readonly closedAt: string;
  /** Set when a fee-bump wrapped the payment, as an x402 facilitator sponsoring fees does. */
  readonly feeBump: {
    readonly outerHash: string;
    readonly innerHash: string;
    readonly feeSource: string;
    readonly feeCharged: string;
  } | null;
  /** The inner transaction's source account. */
  readonly source: string;
  readonly operations: readonly {
    readonly type: string;
    readonly contract?: string;
    readonly function?: string;
    readonly args?: readonly unknown[];
  }[];
  readonly authorizations: readonly {
    readonly address: string;
    readonly credential: "address" | "address_v2";
    readonly nonce: string;
    readonly expirationLedger: number;
    readonly signed: boolean;
    readonly subInvocations: number;
  }[];
  readonly transfers: readonly {
    readonly contract: string;
    readonly symbol?: string;
    readonly from: string;
    readonly to: string;
    readonly amount: { readonly atomic: string; readonly decimal?: string };
  }[];
  /** Whether the transaction has the shape of an x402 payment, and the checks behind the verdict. */
  readonly x402: { readonly shape: "exact" | "upto" | "unknown"; readonly checks: readonly string[] };
  /** Whether the fee source is one of the configured facilitator's advertised signers. */
  readonly facilitator: { readonly url: string; readonly attributed: boolean } | null;
  readonly explorerUrl: string;
}

export interface InspectDependencies {
  readonly network: StellarNetwork;
  readonly server: Pick<rpc.Server, "getTransaction">;
  readonly explorer?: ExplorerProvider;
  /** Reads a token's symbol and decimals, for readable amounts. */
  readonly describe?: (contract: string) => Promise<AssetFacts | undefined>;
  /** A facilitator whose `/supported` signers attribute the fee source. */
  readonly facilitator?: { readonly url: string; readonly fetch?: typeof fetch };
}

const HASH = /^[0-9a-f]{64}$/;
const MAX_ARGS = 8;
const MAX_ARG_TEXT = 200;

/** Looks a transaction up through the RPC and explains it. */
export async function inspectTransaction(
  hash: string,
  deps: InspectDependencies,
): Promise<TransactionReport> {
  const normalized = typeof hash === "string" ? hash.trim().toLowerCase() : "";
  if (!HASH.test(normalized)) throw paymentError("transaction_hash_invalid");
  let response: rpc.Api.GetTransactionResponse;
  try {
    response = await deps.server.getTransaction(normalized);
  } catch {
    throw paymentError("rpc_unavailable", {
      reason: "The transaction could not be read from the Stellar RPC.",
    });
  }
  const { SUCCESS, FAILED } = rpc.Api.GetTransactionStatus;
  if (response.status !== SUCCESS && response.status !== FAILED) {
    throw paymentError("transaction_not_found", {
      reason: `The RPC has no transaction ${normalized}; it keeps ledgers ${String(response.oldestLedger)} to ${String(response.latestLedger)} only.`,
    });
  }

  const passphrase = networkPassphrase(deps.network);
  const envelope = TransactionBuilder.fromXDR(response.envelopeXdr, passphrase);
  const inner: Transaction = envelope instanceof FeeBumpTransaction ? envelope.innerTransaction : envelope;
  const feeBump =
    envelope instanceof FeeBumpTransaction
      ? {
          outerHash: envelope.hash().toString("hex"),
          innerHash: inner.hash().toString("hex"),
          feeSource: envelope.feeSource,
          feeCharged: response.resultXdr.feeCharged().toString(),
        }
      : null;

  const operations: TransactionReport["operations"][number][] = [];
  const authorizations: TransactionReport["authorizations"][number][] = [];
  let otherCredentials = 0;
  const invocations: { contract: string; fn: string; subInvocations: number }[] = [];
  for (const operation of inner.operations) {
    if (operation.type !== "invokeHostFunction") {
      operations.push({ type: operation.type });
      continue;
    }
    const func = operation.func;
    if (func.switch() !== xdr.HostFunctionType.hostFunctionTypeInvokeContract()) {
      operations.push({ type: operation.type, function: func.switch().name });
      continue;
    }
    const call = func.invokeContract();
    const contract = Address.fromScAddress(call.contractAddress()).toString();
    const fn = call.functionName().toString();
    operations.push({
      type: operation.type,
      contract,
      function: fn,
      args: call.args().slice(0, MAX_ARGS).map(readableArg),
    });
    for (const entry of operation.auth ?? []) {
      const credentials = getAddressCredentials(entry.credentials());
      if (credentials === undefined) {
        otherCredentials++;
        continue;
      }
      const root = entry.rootInvocation();
      authorizations.push({
        address: Address.fromScAddress(credentials.address()).toString(),
        credential:
          entry.credentials().switch() === xdr.SorobanCredentialsType.sorobanCredentialsAddressV2()
            ? "address_v2"
            : "address",
        nonce: credentials.nonce().toString(),
        expirationLedger: credentials.signatureExpirationLedger(),
        signed: credentials.signature().switch() !== xdr.ScValType.scvVoid(),
        subInvocations: root.subInvocations().length,
      });
      if (
        root.function().switch() ===
        xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn()
      ) {
        const args = root.function().contractFn();
        invocations.push({
          contract: Address.fromScAddress(args.contractAddress()).toString(),
          fn: args.functionName().toString(),
          subInvocations: root.subInvocations().length,
        });
      }
    }
  }

  const transfers: TransactionReport["transfers"][number][] = [];
  if (response.status === SUCCESS) {
    for (const event of sacTransferEvents(response)) {
      const facts = await deps.describe?.(event.contract).catch(() => undefined);
      transfers.push({
        contract: event.contract,
        ...(facts === undefined ? {} : { symbol: sanitizeText(facts.symbol, 16) }),
        from: event.from,
        to: event.to,
        amount: {
          atomic: event.amount.toString(),
          ...(facts === undefined ? {} : { decimal: toDecimal(event.amount, facts.decimals) }),
        },
      });
    }
  }

  const x402 = classify(
    operations,
    authorizations,
    invocations,
    otherCredentials,
    transfers,
    response.status,
  );
  return {
    hash: normalized,
    network: deps.network,
    status: response.status,
    ledger: response.ledger,
    closedAt: new Date(response.createdAt * 1_000).toISOString(),
    feeBump,
    source: inner.source,
    operations,
    authorizations,
    transfers,
    x402,
    facilitator: await attribute(deps, feeBump?.feeSource ?? inner.source, inner.source),
    explorerUrl: explorerUrl(deps.network, normalized, deps.explorer),
  };
}

/**
 * Whether the transaction is an x402 payment: `exact` is one SAC transfer authorized by its payer
 * alone; `upto` is one `settle` call on a settlement contract, authorized by the payer (with its one
 * approval) and by the settlement authority as the operation's source.
 */
function classify(
  operations: TransactionReport["operations"],
  authorizations: TransactionReport["authorizations"],
  invocations: readonly { contract: string; fn: string; subInvocations: number }[],
  otherCredentials: number,
  transfers: TransactionReport["transfers"],
  status: "SUCCESS" | "FAILED",
): TransactionReport["x402"] {
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
    checks.push(`authorized by ${authorization.address} alone`);
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

async function attribute(
  deps: InspectDependencies,
  feeSource: string,
  innerSource: string,
): Promise<TransactionReport["facilitator"]> {
  if (deps.facilitator === undefined) return null;
  const url = deps.facilitator.url.replace(/\/+$/, "");
  try {
    const response = await (deps.facilitator.fetch ?? fetch)(`${url}/supported`, {
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { url, attributed: false };
    const body = (await response.json()) as { signers?: Record<string, unknown> };
    const signers = new Set<string>();
    for (const [pattern, list] of Object.entries(body.signers ?? {})) {
      if (!pattern.startsWith("stellar:") || !Array.isArray(list)) continue;
      for (const signer of list) if (typeof signer === "string") signers.add(signer);
    }
    const fee = baseAccount(feeSource) ?? feeSource;
    const source = baseAccount(innerSource) ?? innerSource;
    return { url, attributed: signers.has(fee) || signers.has(source) };
  } catch {
    return { url, attributed: false };
  }
}

/** An argument as plain JSON: addresses as strkeys, integers as strings, long values cut. */
function readableArg(value: xdr.ScVal): unknown {
  let native: unknown;
  try {
    native = scValToNative(value);
  } catch {
    return `[${value.switch().name}]`;
  }
  return bounded(native, 0);
}

function bounded(value: unknown, depth: number): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return sanitizeText(value, MAX_ARG_TEXT);
  if (value instanceof Uint8Array) return `[${String(value.byteLength)} bytes]`;
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, MAX_ARGS).map((item) => bounded(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, MAX_ARGS)
      .map(([key, item]) => [sanitizeText(key, 64), bounded(item, depth + 1)]),
  );
}
