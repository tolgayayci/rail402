import { Buffer } from "buffer";
import { xdr } from "@stellar/stellar-sdk";
import { UnsupportedMetaError } from "@rail402.dev/stellar";
import { addressOf, contractStrkey, i128Of, stringOf, symbolMapOf, symbolOf } from "./xdr.ts";

/** A contract event: the emitting contract, its topics and its data. */
export interface ContractEventView {
  readonly contract: string;
  readonly topics: readonly xdr.ScVal[];
  readonly data: xdr.ScVal;
}

/**
 * A SEP-41 `transfer` event. `to` is the base account; a muxed destination sets `toMuxedId`, a u64 in
 * decimal. A CAP-67 `to_muxed_id` of another form (a text or hash memo, which only classic payments
 * produce) sets `toMemo` instead: no x402 settlement has one, and its bytes are never kept.
 */
export interface TransferView {
  readonly contract: string;
  readonly from: string;
  readonly fromKind: "G" | "C";
  readonly to: string;
  readonly toMuxedId: string | null;
  readonly toMemo: "text" | "hash" | null;
  readonly amount: bigint;
  /** The fourth topic of a Stellar Asset Contract event (`CODE:ISSUER` or `native`), unverified. */
  readonly assetTopic: string | null;
}

/**
 * The contract events of a transaction, one list per operation. Meta version 4 keeps events per
 * operation; version 3 keeps the Soroban events of its single operation. Versions 0 to 2 cannot carry
 * Soroban events. Any other version throws `UnsupportedMetaError`, so a caller never reads an unknown
 * shape as "nothing happened".
 */
export function operationEvents(meta: xdr.TransactionMeta): ContractEventView[][] {
  const version = meta.switch();
  switch (version) {
    case 0:
    case 1:
    case 2:
      return [];
    case 3:
      return [contractEvents(meta.v3().sorobanMeta()?.events() ?? [])];
    case 4:
      return meta
        .v4()
        .operations()
        .map((operation) => contractEvents(operation.events()));
    default:
      throw new UnsupportedMetaError(version);
  }
}

function contractEvents(events: readonly xdr.ContractEvent[]): ContractEventView[] {
  const views: ContractEventView[] = [];
  for (const event of events) {
    if (event.type() !== xdr.ContractEventType.contract()) continue;
    const contractId = event.contractId();
    if (contractId === null) continue;
    const body = event.body().v0();
    views.push({ contract: contractStrkey(contractId), topics: body.topics(), data: body.data() });
  }
  return views;
}

/** The event as a SEP-41 transfer, or `undefined` when it is not one. Never throws. */
export function transferOf(event: ContractEventView): TransferView | undefined {
  const { topics } = event;
  if (topics.length < 3 || topics.length > 4 || symbolOf(topics[0]) !== "transfer") return undefined;
  const from = addressOf(topics[1]);
  const to = addressOf(topics[2]);
  if (from === undefined || to === undefined) return undefined;
  // A custom token may put anything in a fourth topic; only a string can name a SAC asset.
  const assetTopic = topics.length === 4 ? (stringOf(topics[3]) ?? null) : null;
  let amount = i128Of(event.data);
  let toMuxedId = to.muxedId;
  let toMemo: TransferView["toMemo"] = null;
  if (amount === undefined) {
    // CAP-67: a transfer to a muxed address carries `{ amount, to_muxed_id }`.
    const fields = symbolMapOf(event.data);
    amount = i128Of(fields?.get("amount"));
    if (amount === undefined) return undefined;
    const muxed = fields?.get("to_muxed_id");
    if (muxed !== undefined) {
      const id = muxedIdOf(muxed);
      if (id === undefined) return undefined;
      if (id.form === "u64") toMuxedId = id.value;
      else toMemo = id.form;
    }
  }
  return {
    contract: event.contract,
    from: from.base,
    fromKind: from.kind,
    to: to.base,
    toMuxedId,
    toMemo,
    amount,
    assetTopic,
  };
}

/** A CAP-67 `to_muxed_id` and its form. */
export type MuxedId =
  | { readonly form: "u64"; readonly value: string }
  | { readonly form: "text" | "hash"; readonly bytes: number };

/**
 * A CAP-67 `to_muxed_id`: a u64 (an M… address or an id memo, as decimal), a string (a text memo) or
 * bytes (a hash memo). Text and hash forms report only their length: their bytes are chosen by whoever
 * emitted the event (any NUL or invalid UTF-8 included), so they are never stored.
 */
export function muxedIdOf(value: xdr.ScVal): MuxedId | undefined {
  try {
    switch (value.switch()) {
      case xdr.ScValType.scvU64():
        return { form: "u64", value: value.u64().toString() };
      case xdr.ScValType.scvString(): {
        const text = stringOf(value);
        return text === undefined ? undefined : { form: "text", bytes: text.length };
      }
      case xdr.ScValType.scvBytes():
        return { form: "hash", bytes: Buffer.from(value.bytes()).length };
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

/**
 * The WASM hashes that contract instances have in the transaction's ledger entry changes, per contract.
 * An instance that appears here runs that WASM at this transaction.
 */
export function instanceWasmHashes(meta: xdr.TransactionMeta): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const changes: xdr.LedgerEntryChange[] = [];
  try {
    switch (meta.switch()) {
      case 3: {
        const v3 = meta.v3();
        changes.push(...v3.txChangesBefore(), ...v3.txChangesAfter());
        for (const operation of v3.operations()) changes.push(...operation.changes());
        break;
      }
      case 4: {
        const v4 = meta.v4();
        changes.push(...v4.txChangesBefore(), ...v4.txChangesAfter());
        for (const operation of v4.operations()) changes.push(...operation.changes());
        break;
      }
      default:
        return found;
    }
  } catch {
    return found;
  }
  for (const change of changes) {
    let entry: xdr.LedgerEntry | undefined;
    switch (change.switch()) {
      case xdr.LedgerEntryChangeType.ledgerEntryCreated():
        entry = change.created();
        break;
      case xdr.LedgerEntryChangeType.ledgerEntryUpdated():
        entry = change.updated();
        break;
      case xdr.LedgerEntryChangeType.ledgerEntryState():
        entry = change.state();
        break;
      case xdr.LedgerEntryChangeType.ledgerEntryRestored():
        entry = change.restored();
        break;
      default:
        entry = undefined;
    }
    if (entry?.data().switch() !== xdr.LedgerEntryType.contractData()) continue;
    const data = entry.data().contractData();
    if (data.key().switch() !== xdr.ScValType.scvLedgerKeyContractInstance()) continue;
    const contract = data.contract();
    if (contract.switch() !== xdr.ScAddressType.scAddressTypeContract()) continue;
    const value = data.val();
    if (value.switch() !== xdr.ScValType.scvContractInstance()) continue;
    const executable = value.instance().executable();
    if (executable.switch() !== xdr.ContractExecutableType.contractExecutableWasm()) continue;
    const id = contractStrkey(contract.contractId());
    const set = found.get(id) ?? new Set<string>();
    set.add(executable.wasmHash().toString("hex"));
    found.set(id, set);
  }
  return found;
}
