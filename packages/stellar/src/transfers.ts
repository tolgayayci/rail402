import { Address, nativeToScVal, scValToNative, xdr, type rpc } from "@stellar/stellar-sdk";

/** A SEP-41 `transfer` event emitted by a token contract. */
export interface TransferEvent {
  /** C… address of the token contract that emitted the event. */
  readonly contract: string;
  readonly from: string;
  /** The receiving G… or C… address; a muxed destination appears as its base account plus `toMuxedId`. */
  readonly to: string;
  readonly amount: bigint;
  /** CAP-67: the muxed id of the destination, when the transfer was sent to an M… address. */
  readonly toMuxedId?: bigint;
}

/** A contract event of a successful transaction: the emitting contract, its topics and its data. */
export interface ContractEventRecord {
  /** C… address of the contract that emitted the event. */
  readonly contract: string;
  readonly topics: readonly xdr.ScVal[];
  readonly data: xdr.ScVal;
}

/**
 * Raised for a transaction meta version this package does not read. A proof must never read an
 * unknown shape as "nothing happened", so the caller cannot tell and has to try again later (after an
 * upgrade of this package).
 */
export class UnsupportedMetaError extends Error {
  readonly version: number;
  constructor(version: number) {
    super(`transaction meta version ${String(version)} is not supported`);
    this.name = "UnsupportedMetaError";
    this.version = version;
  }
}

/**
 * Every contract event of a successful transaction, in emission order. Reads both the per-operation
 * events of transaction meta v4 and the Soroban events of meta v3; system and diagnostic events are
 * left out. Throws `UnsupportedMetaError` for any other meta version.
 */
export function contractEventsOf(
  transaction: rpc.Api.GetSuccessfulTransactionResponse,
): ContractEventRecord[] {
  const events: xdr.ContractEvent[] = [];
  const meta = transaction.resultMetaXdr;
  switch (meta.switch()) {
    case 3:
      events.push(...(meta.v3().sorobanMeta()?.events() ?? []));
      break;
    case 4:
      events.push(
        ...meta
          .v4()
          .operations()
          .flatMap((operation) => operation.events()),
      );
      break;
    default:
      throw new UnsupportedMetaError(meta.switch());
  }
  const records: ContractEventRecord[] = [];
  for (const event of events) {
    if (event.type() !== xdr.ContractEventType.contract()) continue;
    const contractId = event.contractId();
    if (contractId === null) continue;
    const contract = Address.fromScAddress(xdr.ScAddress.scAddressTypeContract(contractId)).toString();
    const body = event.body().v0();
    records.push({ contract, topics: body.topics(), data: body.data() });
  }
  return records;
}

/** Every SEP-41 `transfer` event of a successful transaction, in emission order. */
export function sacTransferEvents(transaction: rpc.Api.GetSuccessfulTransactionResponse): TransferEvent[] {
  const transfers: TransferEvent[] = [];
  for (const event of contractEventsOf(transaction)) {
    const transfer = transferOf(event.contract, event.topics, event.data);
    if (transfer !== undefined) transfers.push(transfer);
  }
  return transfers;
}

export interface TransferQuery {
  /** C… address of the token contract. */
  readonly asset: string;
  /** The G… or C… address that sent the transfers. */
  readonly from: string;
  readonly startLedger: number;
  /** Last ledger searched, inclusive. */
  readonly endLedger: number;
}

export type FoundTransfer = TransferEvent & { readonly transaction: string; readonly ledger: number };

/** Largest page requested from getEvents. */
const PAGE = 200;

/**
 * Every `transfer` of `asset` sent by `from` in the ledger range, from the RPC's event store.
 * `"out_of_range"` when the start of the range is older than the RPC's retention window: absence can
 * only be proven for ledgers the RPC still holds, and pruned ledgers never come back. A range that
 * ends after the RPC's latest ledger throws a `RangeError` instead: those ledgers are not closed (or
 * not ingested by this RPC node) yet, so the question can be asked again later.
 */
export async function findTransfers(
  server: Pick<rpc.Server, "getEvents" | "getHealth">,
  query: TransferQuery,
): Promise<FoundTransfer[] | "out_of_range"> {
  if (!Number.isInteger(query.startLedger) || !Number.isInteger(query.endLedger)) {
    throw new RangeError("startLedger and endLedger must be integers");
  }
  if (query.endLedger < query.startLedger) throw new RangeError("endLedger precedes startLedger");
  const health = await server.getHealth();
  if (query.startLedger < health.oldestLedger) return "out_of_range";
  if (query.endLedger > health.latestLedger) {
    throw new RangeError(
      `the RPC has not ingested ledger ${String(query.endLedger)} yet (latest ${String(health.latestLedger)})`,
    );
  }

  const transferSymbol = nativeToScVal("transfer", { type: "symbol" }).toXDR("base64");
  const fromAddress = nativeToScVal(query.from, { type: "address" }).toXDR("base64");
  // SAC events carry a fourth topic (the asset name); custom SEP-41 tokens carry three.
  const filters: rpc.Api.EventFilter[] = [
    {
      type: "contract",
      contractIds: [query.asset],
      topics: [
        [transferSymbol, fromAddress, "*"],
        [transferSymbol, fromAddress, "*", "*"],
      ],
    },
  ];

  const found: FoundTransfer[] = [];
  const seen = new Set<string>();
  let response = await server.getEvents({
    filters,
    startLedger: query.startLedger,
    endLedger: query.endLedger + 1,
    limit: PAGE,
  });
  for (;;) {
    let beyond = false;
    for (const event of response.events) {
      if (event.ledger > query.endLedger) {
        beyond = true;
        continue;
      }
      if (seen.has(event.id) || !event.inSuccessfulContractCall) continue;
      seen.add(event.id);
      const contract = event.contractId?.contractId();
      if (contract === undefined) continue;
      const transfer = transferOf(contract, event.topic, event.value);
      if (transfer?.from !== query.from) continue;
      found.push({ ...transfer, transaction: event.txHash, ledger: event.ledger });
    }
    if (beyond || response.events.length < PAGE) return found;
    response = await server.getEvents({ filters, cursor: response.cursor, limit: PAGE });
  }
}

function transferOf(
  contract: string,
  topics: readonly xdr.ScVal[],
  data: xdr.ScVal,
): TransferEvent | undefined {
  const [name, fromTopic, toTopic] = topics;
  if (topics.length < 3 || topics.length > 4 || name === undefined || fromTopic === undefined)
    return undefined;
  if (toTopic === undefined) return undefined;
  if (name.switch() !== xdr.ScValType.scvSymbol() || name.sym().toString() !== "transfer") return undefined;
  if (fromTopic.switch() !== xdr.ScValType.scvAddress() || toTopic.switch() !== xdr.ScValType.scvAddress()) {
    return undefined;
  }
  try {
    const from = Address.fromScAddress(fromTopic.address()).toString();
    const to = Address.fromScAddress(toTopic.address()).toString();
    if (data.switch() === xdr.ScValType.scvI128()) {
      return { contract, from, to, amount: scValToNative(data) as bigint };
    }
    // CAP-67: a transfer to a muxed address carries `{ amount, to_muxed_id }`.
    if (data.switch() === xdr.ScValType.scvMap()) {
      const fields = scValToNative(data) as Record<string, unknown>;
      const amount = fields["amount"];
      const muxedId = fields["to_muxed_id"];
      if (typeof amount !== "bigint") return undefined;
      return typeof muxedId === "bigint"
        ? { contract, from, to, amount, toMuxedId: muxedId }
        : { contract, from, to, amount };
    }
  } catch {
    return undefined;
  }
  return undefined;
}
