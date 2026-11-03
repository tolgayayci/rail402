import { Account, Address, MuxedAccount, scValToNative, rpc, xdr } from "@stellar/stellar-sdk";
import { networkPassphrase, type AssetFacts, type StellarNetwork } from "@rail402.dev/stellar";
import {
  envelopeHashes,
  networkId,
  operationEvents,
  readEnvelope,
  signedByPayer,
  transferOf,
  verifySacAsset,
  x402Shape,
  type AddressView,
  type AuthorizationView,
} from "@rail402.dev/x402-index";
import { REGISTRIES } from "@rail402.dev/x402-index/registry";
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
  const envelope = response.envelopeXdr;
  const view = readEnvelope(envelope);
  if (view === undefined) {
    throw paymentError("transaction_unreadable");
  }
  const hashes = envelopeHashes(envelope, networkId(passphrase));
  const feeBump = view.feeBump
    ? {
        outerHash: hashes.hash,
        innerHash: hashes.innerHash ?? hashes.hash,
        feeSource: strkeyOf(view.feePayer),
        feeCharged: response.resultXdr.feeCharged().toString(),
      }
    : null;

  const operations: TransactionReport["operations"][number][] = [];
  const authorizations: TransactionReport["authorizations"][number][] = [];
  /** The entries behind `authorizations`, in the same order. */
  const entries: AuthorizationView[] = [];
  let otherCredentials = 0;
  const invocations: { contract: string; fn: string; subInvocations: number }[] = [];
  for (const operation of view.operations) {
    const call = operation.invocation;
    if (call === null) {
      operations.push(
        operation.hostFunction === null
          ? { type: operation.type }
          : { type: operation.type, function: operation.hostFunction },
      );
      continue;
    }
    operations.push({
      type: operation.type,
      contract: call.contract,
      function: call.fn,
      args: call.args.slice(0, MAX_ARGS).map(readableArg),
    });
    for (const entry of operation.authorizations) {
      if ((entry.credential !== "address" && entry.credential !== "address_v2") || entry.address === null) {
        otherCredentials++;
        continue;
      }
      authorizations.push({
        address: strkeyOf(entry.address),
        credential: entry.credential,
        nonce: entry.nonce ?? "0",
        expirationLedger: entry.expirationLedger ?? 0,
        signed: entry.signed,
        subInvocations: entry.subInvocations,
      });
      entries.push(entry);
      if (entry.root !== null) {
        invocations.push({
          contract: entry.root.contract,
          fn: entry.root.fn,
          subInvocations: entry.subInvocations,
        });
      }
    }
  }

  const transfers: TransactionReport["transfers"][number][] = [];
  /** `contract:from` of transfers by a Stellar Asset Contract, which always requires `from`'s authorization. */
  const assetContractSenders = new Set<string>();
  if (response.status === SUCCESS) {
    for (const event of operationEvents(response.resultMetaXdr).flat()) {
      const transfer = transferOf(event);
      if (transfer === undefined) continue;
      if (verifySacAsset(transfer.contract, transfer.assetTopic, passphrase).verified)
        assetContractSenders.add(`${transfer.contract}:${transfer.from}`);
      const facts = await deps.describe?.(transfer.contract).catch(() => undefined);
      transfers.push({
        contract: transfer.contract,
        ...(facts === undefined ? {} : { symbol: sanitizeText(facts.symbol, 16) }),
        from: transfer.from,
        to: topicAddress(event.topics[2]) ?? transfer.to,
        amount: {
          atomic: transfer.amount.toString(),
          ...(facts === undefined ? {} : { decimal: toDecimal(transfer.amount, facts.decimals) }),
        },
      });
    }
  }

  // An authorization is proven when the chain shows it was checked: a Stellar Asset Contract's transfer
  // from that address, or a valid signature by the address's own key (check E7 of the indexing rules).
  const network = networkId(passphrase);
  const x402 = x402Shape({
    operations,
    authorizations: authorizations.map((authorization, index) => {
      const entry = entries[index];
      const address = entry?.address ?? null;
      const proven =
        entry !== undefined &&
        address !== null &&
        ((entry.root?.fn === "transfer" &&
          assetContractSenders.has(`${entry.root.contract}:${address.base}`)) ||
          signedByPayer(entry.entry, address, network, response.ledger));
      return { ...authorization, proven };
    }),
    invocations,
    otherCredentials,
    transfers,
    status: response.status,
  });
  return {
    hash: normalized,
    network: deps.network,
    status: response.status,
    ledger: response.ledger,
    closedAt: new Date(response.createdAt * 1_000).toISOString(),
    feeBump,
    source: strkeyOf(view.innerSource),
    operations,
    authorizations,
    transfers,
    x402: { shape: x402.shape, checks: [...x402.checks] },
    facilitator: await attribute(deps, response.ledger, view.feePayer.base, view.innerSource.base),
    explorerUrl: explorerUrl(deps.network, normalized, deps.explorer),
  };
}

/**
 * Whether the fee source or the inner source is one of the configured facilitator's accounts. The
 * published registry answers first, for the ledger of the transaction, so a settlement from before a
 * sponsor rotation still counts; the facilitator's current `/supported` signers answer otherwise.
 */
/** An account as the network shows it: the `M…` strkey of a muxed account, otherwise the base `G…`. */
function strkeyOf(address: AddressView): string {
  if (address.muxedId === null) return address.base;
  return new MuxedAccount(new Account(address.base, "0"), address.muxedId).accountId();
}

/** The address in an event topic exactly as written (an `M…` topic stays `M…`). */
function topicAddress(topic: xdr.ScVal | undefined): string | undefined {
  if (topic?.switch() !== xdr.ScValType.scvAddress()) return undefined;
  try {
    return Address.fromScAddress(topic.address()).toString();
  } catch {
    return undefined;
  }
}

async function attribute(
  deps: InspectDependencies,
  ledger: number,
  feeSource: string,
  innerSource: string,
): Promise<TransactionReport["facilitator"]> {
  if (deps.facilitator === undefined) return null;
  const url = deps.facilitator.url.replace(/\/+$/, "");
  if (registryAttributes(deps.network, url, ledger, [feeSource, innerSource]))
    return { url, attributed: true };
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
    return { url, attributed: signers.has(feeSource) || signers.has(innerSource) };
  } catch {
    return { url, attributed: false };
  }
}

/** Whether the registry lists one of `accounts` for the facilitator at `url` in `ledger` of the current epoch. */
function registryAttributes(
  network: StellarNetwork,
  url: string,
  ledger: number,
  accounts: readonly string[],
): boolean {
  const registry = REGISTRIES[network];
  const facilitator = registry.document.facilitators.find((entry) =>
    entry.urls?.some((candidate) => candidate.replace(/\/+$/, "") === url),
  );
  // The RPC keeps about a week of ledgers, so a transaction it returns is in the latest epoch.
  const epoch = registry.document.epochs.at(-1)?.id;
  if (facilitator === undefined || epoch === undefined) return false;
  return accounts.some(
    (account) => registry.accountAt(account, epoch, ledger)?.facilitator.id === facilitator.id,
  );
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
