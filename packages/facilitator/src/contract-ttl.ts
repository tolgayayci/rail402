import {
  Keypair,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
  rpc,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import { contractCodeKey, contractInstanceKey, type ContractTtl } from "@rail402.dev/stellar";
import { MIN_INCLUSION_FEE_STROOPS } from "./policy.ts";

/**
 * Keeping a Soroban contract live: its instance entry and the code entry of its WASM are persistent
 * entries with a TTL. Extending them (`ExtendFootprintTTLOp`) and restoring them once archived
 * (`RestoreFootprintOp`) are permissionless operations anyone can pay for; here the fee sponsor
 * pays. None of this runs inside a payment: a settlement never extends or restores the contract it
 * calls, so a buyer never pays for someone else's rent.
 */

/** The ledger TTL limits of a network (`CONFIG_SETTING_STATE_ARCHIVAL`). */
export interface NetworkTtlLimits {
  /** Largest TTL an entry can have, in ledgers; an extension reaches at most `maxEntryTtl - 1`. */
  readonly maxEntryTtl: number;
  /** TTL a new or restored persistent entry gets. */
  readonly minPersistentTtl: number;
}

/** Reads the network's TTL limits from its state archival configuration. */
export async function networkTtlLimits(
  server: Pick<rpc.Server, "getLedgerEntries">,
): Promise<NetworkTtlLimits> {
  const key = xdr.LedgerKey.configSetting(
    new xdr.LedgerKeyConfigSetting({
      configSettingId: xdr.ConfigSettingId.configSettingStateArchival(),
    }),
  );
  const { entries } = await server.getLedgerEntries(key);
  const entry = entries[0];
  if (entry === undefined) throw new Error("the network did not return its state archival settings");
  const settings = entry.val.configSetting().stateArchivalSettings();
  return { maxEntryTtl: settings.maxEntryTtl(), minPersistentTtl: settings.minPersistentTtl() };
}

/**
 * The contract whose entries are kept live: its address and, for a WASM contract, the hex sha256 of
 * its WASM. A Stellar Asset Contract has no code entry, so it has no hash.
 */
export interface KeptContract {
  readonly contract: string;
  readonly wasmHash?: string | undefined;
}

/** Where a contract's entries stand, from a TTL reading taken at `latestLedger`. */
export interface ContractLiveness {
  /** Ledgers until the instance entry is archived; negative once it is; undefined when it does not exist. */
  readonly instanceTtlLedgers: number | undefined;
  /** Ledgers until the code entry is archived; negative once it is; undefined when it does not exist. */
  readonly codeTtlLedgers: number | undefined;
  readonly instanceArchived: boolean;
  readonly codeArchived: boolean;
}

/**
 * Reads liveness from a `readContractTtl` result. An archived entry is still returned by the RPC,
 * with `liveUntilLedgerSeq` 0 or behind the latest ledger.
 */
export function contractLiveness(ttl: ContractTtl | undefined, latestLedger: number): ContractLiveness {
  const instanceTtlLedgers = ttl === undefined ? undefined : ttl.instanceLiveUntil - latestLedger;
  const codeTtlLedgers = ttl?.codeLiveUntil === undefined ? undefined : ttl.codeLiveUntil - latestLedger;
  return {
    instanceTtlLedgers,
    codeTtlLedgers,
    instanceArchived: instanceTtlLedgers !== undefined && instanceTtlLedgers < 0,
    codeArchived: codeTtlLedgers !== undefined && codeTtlLedgers < 0,
  };
}

/** What keeping a contract live calls for now. */
export type TtlPlan =
  | { readonly action: "none" }
  /** An entry has fewer ledgers left than the threshold. */
  | { readonly action: "extend"; readonly lowestTtlLedgers: number }
  /** An entry is archived and automatic restoration is allowed. */
  | { readonly action: "restore" }
  /** An entry is archived and only an operator may restore it. */
  | { readonly action: "restore_required" }
  /** The instance (or its code) does not exist on the network: nothing can be restored. */
  | { readonly action: "missing" };

export interface TtlPlanOptions {
  /** Extend once an entry has fewer ledgers left than this. */
  readonly extendBelowLedgers: number;
  /** Restore archived entries without an operator. */
  readonly autoRestore: boolean;
}

/** Decides what keeping a contract live calls for, from its liveness. */
export function planContractTtl(liveness: ContractLiveness, options: TtlPlanOptions): TtlPlan {
  const { instanceTtlLedgers, codeTtlLedgers } = liveness;
  if (instanceTtlLedgers === undefined || codeTtlLedgers === undefined) return { action: "missing" };
  if (liveness.instanceArchived || liveness.codeArchived) {
    return options.autoRestore ? { action: "restore" } : { action: "restore_required" };
  }
  const lowest = Math.min(instanceTtlLedgers, codeTtlLedgers);
  return lowest < options.extendBelowLedgers
    ? { action: "extend", lowestTtlLedgers: lowest }
    : { action: "none" };
}

/** A sponsor-paid transaction that extended or restored a contract. */
export interface TtlTransaction {
  readonly hash: string;
  readonly ledger: number;
  readonly feeChargedStroops: bigint;
}

export interface TtlMaintenanceOptions extends KeptContract {
  readonly server: rpc.Server;
  readonly passphrase: string;
  /** Pays the fee and is the transaction source. */
  readonly sponsor: Keypair;
  /** Refuse to submit when the simulated fee exceeds this, in stroops. */
  readonly maxFeeStroops: number;
  /** Inclusion fee bid on top of the resource fee (default the network minimum). */
  readonly inclusionFeeStroops?: number;
  /** Polls for the outcome this many times, one second apart (default 60). */
  readonly confirmAttempts?: number;
  /**
   * XLM, in stroops, the sponsor must keep: a transaction whose fee would leave less is refused, so
   * maintenance never leaves the sponsor unable to pay for settlements.
   */
  readonly reserveStroops?: bigint;
}

/** A refusal or failure while extending or restoring a contract. */
export class ContractTtlError extends Error {
  override readonly name = "ContractTtlError";
  /** The submitted transaction, when it got that far. */
  readonly transaction: string | undefined;
  constructor(message: string, transaction?: string) {
    super(message);
    this.transaction = transaction;
  }
}

/**
 * Extends the instance and code entries of the contract (the instance alone for a Stellar Asset
 * Contract) so they live `extendToLedgers` ledgers past the current one (capped at the network's
 * maximum). Entries already living longer are unchanged,
 * and an archived entry cannot be extended: restore it first.
 */
export async function extendContractTtl(
  options: TtlMaintenanceOptions & { readonly extendToLedgers: number },
): Promise<TtlTransaction> {
  if (!Number.isInteger(options.extendToLedgers) || options.extendToLedgers < 1) {
    throw new RangeError("extendToLedgers must be a positive integer");
  }
  const { maxEntryTtl } = await networkTtlLimits(options.server);
  const extendTo = Math.min(options.extendToLedgers, maxEntryTtl - 1);
  const data = new SorobanDataBuilder().setReadOnly(footprint(options)).build();
  return run(options, "extension", data, Operation.extendFootprintTtl({ extendTo }));
}

/**
 * Restores the archived entries among the contract's instance and code entries. They come back
 * with the network's minimum persistent TTL, so an extension should follow. Returns undefined when
 * neither entry is archived.
 */
export async function restoreContract(
  options: TtlMaintenanceOptions & {
    readonly archived: { readonly instance: boolean; readonly code: boolean };
  },
): Promise<TtlTransaction | undefined> {
  const [instance, code] = footprint(options);
  const keys = [
    ...(options.archived.instance && instance !== undefined ? [instance] : []),
    ...(options.archived.code && code !== undefined ? [code] : []),
  ];
  if (keys.length === 0) return undefined;
  const data = new SorobanDataBuilder().setReadWrite(keys).build();
  return run(options, "restoration", data, Operation.restoreFootprint({}));
}

/** The contract's instance key and, for a WASM contract, its code key, in that order. */
export function contractFootprint(contract: KeptContract): xdr.LedgerKey[] {
  return footprint(contract);
}

function footprint(contract: KeptContract): xdr.LedgerKey[] {
  const instance = contractInstanceKey(contract.contract);
  if (contract.wasmHash === undefined) return [instance];
  if (!/^[0-9a-f]{64}$/.test(contract.wasmHash)) {
    throw new RangeError("wasmHash must be 64 lower-case hex characters");
  }
  return [instance, contractCodeKey(Buffer.from(contract.wasmHash, "hex"))];
}

async function run(
  options: TtlMaintenanceOptions,
  purpose: string,
  data: xdr.SorobanTransactionData,
  operation: xdr.Operation,
): Promise<TtlTransaction> {
  const { server, sponsor } = options;
  const inclusion = options.inclusionFeeStroops ?? MIN_INCLUSION_FEE_STROOPS;
  const account = await server.getAccount(sponsor.publicKey());
  const draft = new TransactionBuilder(account, {
    fee: String(inclusion),
    networkPassphrase: options.passphrase,
  })
    .setSorobanData(data)
    .addOperation(operation)
    .setTimeout(60)
    .build();

  const simulation = await server.simulateTransaction(draft);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new ContractTtlError(`the contract ${purpose} did not simulate: ${simulation.error}`);
  }
  const prepared: Transaction = rpc.assembleTransaction(draft, simulation).build();
  const fee = Number(prepared.fee);
  if (fee > options.maxFeeStroops) {
    throw new ContractTtlError(
      `the contract ${purpose} costs ${String(fee)} stroops, above the ceiling of ${String(options.maxFeeStroops)}`,
    );
  }
  if (options.reserveStroops !== undefined) {
    const balance = await nativeBalance(server, sponsor.publicKey());
    if (balance - BigInt(fee) < options.reserveStroops) {
      throw new ContractTtlError(
        `the contract ${purpose} costs ${String(fee)} stroops, which would leave the sponsor (${String(balance)} stroops) below its reserve of ${String(options.reserveStroops)}`,
      );
    }
  }
  prepared.sign(sponsor);

  const hash = prepared.hash().toString("hex");
  const sent = await server.sendTransaction(prepared);
  if (sent.status !== "PENDING" && sent.status !== "DUPLICATE") {
    throw new ContractTtlError(`the contract ${purpose} was not accepted: ${sent.status}`, hash);
  }
  const result = await server.pollTransaction(hash, { attempts: options.confirmAttempts ?? 60 });
  if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new ContractTtlError(`the contract ${purpose} transaction ${hash} ended ${result.status}`, hash);
  }
  return {
    hash,
    ledger: result.ledger,
    feeChargedStroops: result.resultXdr.feeCharged().toBigInt(),
  };
}

/** The XLM balance of an account, in stroops. */
async function nativeBalance(server: rpc.Server, address: string): Promise<bigint> {
  const key = xdr.LedgerKey.account(
    new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(address).xdrAccountId() }),
  );
  const { entries } = await server.getLedgerEntries(key);
  const entry = entries[0];
  if (entry === undefined) throw new ContractTtlError(`the sponsor account ${address} does not exist`);
  return entry.val.account().balance().toBigInt();
}
