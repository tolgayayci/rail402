import { Keypair, rpc } from "@stellar/stellar-sdk";
import { x402Facilitator } from "@x402/core/facilitator";
import { PUBNET, USDC, networkPassphrase, type StellarNetwork } from "@rail402.dev/stellar";
import {
  UPTO_DEPLOYMENTS,
  isContractAddress,
  type LedgerSecondsSource,
  type ZeroSettlementMode,
} from "@rail402.dev/upto";
import { deriveAuthorityKeypair } from "./authority.ts";
import { MemoryChannelPool, type ChannelPool } from "./channels.ts";
import { SettlementEngine, type SettlementTiming, type SponsorGuard } from "./engine.ts";
import { InclusionFeeOracle, type InclusionFeeOptions } from "./fees.ts";
import { deriveChannelKeypairs } from "./keys.ts";
import type { SettlementLedger } from "./ledger.ts";
import { RpcLedgerSeconds } from "./ledger-seconds.ts";
import { silentLogger, type Logger } from "./logger.ts";
import { MemorySettlementLedger } from "./memory-ledger.ts";
import type { SettlementObserver } from "./observer.ts";
import {
  DEFAULT_EXPIRATION_MARGIN_LEDGERS,
  DEFAULT_MAX_TRANSACTION_FEE_STROOPS,
  DEFAULT_TIMEOUT_SECONDS,
  DEFAULT_UPTO_MAX_TRANSACTION_FEE_STROOPS,
  MIN_INCLUSION_FEE_STROOPS,
  acceptedAsset,
  type AcceptedAsset,
  type NetworkPolicy,
  type UptoPolicy,
} from "./policy.ts";
import { StellarExactScheme } from "./scheme.ts";
import { StellarUptoScheme } from "./upto-scheme.ts";

export interface NetworkSetup {
  readonly network: StellarNetwork;
  readonly rpcUrl: string;
  /** Secret seed (S…) of the sponsor account. Channel keys are derived from it. */
  readonly sponsorSecret: string;
  readonly channelCount: number;
  /** Accepted assets; defaults to USDC for the network. */
  readonly assets?: readonly AcceptedAsset[];
  readonly policy?: Partial<Omit<NetworkPolicy, "network" | "assets">>;
  /** Durable stores. The in-memory defaults suit a single in-process facilitator only. */
  readonly ledger?: SettlementLedger;
  readonly channels?: ChannelPool;
  readonly timing?: Partial<SettlementTiming>;
  /** Bid inclusion fees from the network's fee stats; the policy's fixed bid is used otherwise. */
  readonly inclusionFee?: InclusionFeeOptions;
  /** Refuses settlements while the sponsor cannot safely pay for them. */
  readonly guard?: SponsorGuard;
  /**
   * Answer a payment another party's transaction landed first, with the payer's authorization exactly
   * as signed, as settled in that transaction. Default true.
   */
  readonly reconcileThirdParty?: boolean;
  /**
   * Settle `upto` payments on this network too. The settlement authority is derived from the sponsor
   * (`deriveAuthorityKeypair`) and must exist on the network (`provisionAuthority`).
   */
  readonly upto?: UptoSetup;
}

/** `upto` on one network. */
export interface UptoSetup {
  /**
   * The settlement contract. Defaults to the canonical deployment on the network; a network without
   * one (a local network, or pubnet until it has one) needs it set.
   */
  readonly contract?: string;
  /** Hex sha256 of the contract's WASM. Defaults to the canonical one when the contract is canonical. */
  readonly contractWasmHash?: string;
  /**
   * `onchain` (default) or `offchain`; see `UptoPolicy.zeroSettlement`. An off-chain zero exists only
   * in the settlement ledger, so `offchain` needs `NetworkSetup.ledger` set explicitly: a durable
   * ledger shared by every process holding the settlement authority, or the in-memory one when a
   * single process is all there is.
   */
  readonly zeroSettlement?: ZeroSettlementMode;
  /** Fee ceiling for `upto` settlements, in stroops (default 500,000). */
  readonly maxTransactionFeeStroops?: number;
  /**
   * Seconds per ledger for the expiration window. Defaults to the average close time over the ledgers
   * the network's RPC (`rpcUrl`) retains, read at most once a minute (5 s when the RPC cannot tell);
   * no other service is asked.
   */
  readonly ledgerSeconds?: LedgerSecondsSource;
  /**
   * Whether the settlement authority account exists now, e.g. from a background poll. While it
   * answers false, `upto` payments are refused with `settle_upto_stellar_authority_unavailable`
   * instead of failing at submission. Assumed ready when absent.
   */
  readonly authorityReady?: () => boolean;
}

export interface FacilitatorOptions {
  readonly networks: readonly NetworkSetup[];
  readonly log?: Logger;
  /** Receives every network's settlement events, e.g. for metrics. */
  readonly observer?: SettlementObserver;
}

export interface NetworkRuntime {
  readonly network: StellarNetwork;
  readonly policy: NetworkPolicy;
  readonly server: rpc.Server;
  readonly engine: SettlementEngine;
  readonly channels: ChannelPool;
  readonly sponsorAddress: string;
  /** The `upto` policy and settlement authority, when the network settles `upto`. */
  readonly upto?: { readonly policy: UptoPolicy; readonly authorityAddress: string };
}

export interface StellarFacilitator {
  /** The upstream facilitator: `verify`, `settle` and `getSupported` with hooks and extensions. */
  readonly core: x402Facilitator;
  readonly networks: ReadonlyMap<StellarNetwork, NetworkRuntime>;
  /** Finishes recorded settlements whose outcome is still open. Run at startup and periodically. */
  reconcile(): Promise<number>;
}

/**
 * Assembles a facilitator for the configured Stellar networks on top of the upstream
 * `x402Facilitator`. It serves the HTTP service, and it runs in-process inside a resource server.
 */
export function createStellarFacilitator(options: FacilitatorOptions): StellarFacilitator {
  const log = options.log ?? silentLogger;
  const core = new x402Facilitator();
  const networks = new Map<StellarNetwork, NetworkRuntime>();

  for (const setup of options.networks) {
    if (networks.has(setup.network)) throw new Error(`network ${setup.network} is configured twice`);
    const runtime = buildNetwork(setup, log, options.observer);
    networks.set(setup.network, runtime);
    core.register(
      setup.network,
      new StellarExactScheme({
        network: setup.network,
        passphrase: networkPassphrase(setup.network),
        rpcUrl: setup.rpcUrl,
        server: runtime.server,
        policy: runtime.policy,
        engine: runtime.engine,
        log,
      }),
    );
    if (runtime.upto !== undefined) {
      core.register(
        setup.network,
        new StellarUptoScheme({
          network: setup.network,
          passphrase: networkPassphrase(setup.network),
          server: runtime.server,
          policy: runtime.policy,
          upto: runtime.upto.policy,
          engine: runtime.engine,
          ...(setup.upto?.authorityReady === undefined ? {} : { authorityReady: setup.upto.authorityReady }),
          log,
        }),
      );
    }
  }

  return {
    core,
    networks,
    async reconcile() {
      let finished = 0;
      for (const runtime of networks.values()) finished += await runtime.engine.reconcile();
      return finished;
    },
  };
}

function buildNetwork(setup: NetworkSetup, log: Logger, observer?: SettlementObserver): NetworkRuntime {
  const { network } = setup;
  const url = new URL(setup.rpcUrl);
  if (network === PUBNET && url.protocol !== "https:") throw new Error("pubnet RPC must use https");
  if (!Number.isInteger(setup.channelCount) || setup.channelCount < 1) {
    throw new Error(`channelCount must be a positive integer, got ${setup.channelCount}`);
  }

  const sponsor = Keypair.fromSecret(setup.sponsorSecret);
  const channelKeys = deriveChannelKeypairs(sponsor, network, setup.channelCount);
  const channelAddresses = channelKeys.map((keypair) => keypair.publicKey());
  const channels = setup.channels ?? new MemoryChannelPool(channelAddresses);
  const unknown = channels.addresses.filter((address) => !channelAddresses.includes(address));
  if (unknown.length > 0)
    throw new Error(`channel pool holds accounts not derived from the sponsor: ${unknown.join(", ")}`);

  const policy = resolvePolicy(setup);
  const server = new rpc.Server(setup.rpcUrl, { allowHttp: url.protocol === "http:" });
  const upto =
    setup.upto === undefined ? undefined : resolveUptoPolicy(setup, setup.upto, policy, server, log);
  const authority = upto === undefined ? undefined : deriveAuthorityKeypair(sponsor, network);
  const engine = new SettlementEngine({
    network,
    passphrase: networkPassphrase(network),
    rpcUrl: setup.rpcUrl,
    server,
    policy,
    ledger: setup.ledger ?? new MemorySettlementLedger(),
    channels,
    channelKeys: new Map(channelKeys.map((keypair) => [keypair.publicKey(), keypair])),
    sponsor,
    ...(authority === undefined ? {} : { authority }),
    ...(setup.timing === undefined ? {} : { timing: setup.timing }),
    ...(setup.inclusionFee === undefined
      ? {}
      : { inclusionFee: new InclusionFeeOracle(server, setup.inclusionFee) }),
    ...(setup.guard === undefined ? {} : { guard: setup.guard }),
    ...(setup.reconcileThirdParty === undefined ? {} : { reconcileThirdParty: setup.reconcileThirdParty }),
    ...(observer === undefined ? {} : { observer }),
    log,
  });
  return {
    network,
    policy,
    server,
    engine,
    channels,
    sponsorAddress: sponsor.publicKey(),
    ...(upto === undefined || authority === undefined
      ? {}
      : { upto: { policy: upto, authorityAddress: authority.publicKey() } }),
  };
}

function resolveUptoPolicy(
  setup: NetworkSetup,
  upto: UptoSetup,
  policy: NetworkPolicy,
  server: rpc.Server,
  log: Logger,
): UptoPolicy {
  const canonical = UPTO_DEPLOYMENTS[setup.network];
  const contract = upto.contract ?? canonical?.address;
  if (contract === undefined) {
    throw new Error(`${setup.network}: no canonical upto settlement contract; configure one`);
  }
  if (!isContractAddress(contract)) throw new Error(`${setup.network}: upto contract must be a C… address`);
  if (upto.zeroSettlement === "offchain" && setup.ledger === undefined) {
    // Lost with the process or unseen by another, an off-chain zero leaves the authorization open to
    // an on-chain settlement for more.
    throw new Error(
      `${setup.network}: upto zeroSettlement "offchain" needs an explicit settlement ledger, shared by every process holding the settlement authority`,
    );
  }
  const contractWasmHash =
    upto.contractWasmHash ?? (contract === canonical?.address ? canonical.wasmHash : undefined);
  if (contractWasmHash !== undefined && !/^[0-9a-f]{64}$/.test(contractWasmHash)) {
    throw new Error(`${setup.network}: upto contractWasmHash must be 64 lower-case hex characters`);
  }
  const maxTransactionFeeStroops = upto.maxTransactionFeeStroops ?? DEFAULT_UPTO_MAX_TRANSACTION_FEE_STROOPS;
  if (!Number.isInteger(maxTransactionFeeStroops) || maxTransactionFeeStroops < policy.inclusionFeeStroops) {
    throw new Error(
      `${setup.network}: upto maxTransactionFeeStroops must be an integer of at least the inclusion fee`,
    );
  }
  return {
    contract,
    contractWasmHash,
    zeroSettlement: upto.zeroSettlement ?? "onchain",
    maxTransactionFeeStroops,
    ledgerSeconds: upto.ledgerSeconds ?? ledgerSecondsFrom(new RpcLedgerSeconds(server, { log })),
  };
}

/** A ledger-seconds source read from the network's own RPC, cached (see `RpcLedgerSeconds`). */
function ledgerSecondsFrom(estimate: RpcLedgerSeconds): LedgerSecondsSource {
  return () => estimate.seconds();
}

function resolvePolicy(setup: NetworkSetup): NetworkPolicy {
  const assets = setup.assets ?? [acceptedAsset(USDC[setup.network])];
  const policy: NetworkPolicy = {
    network: setup.network,
    assets: new Map(assets.map((asset) => [asset.contract, asset])),
    timeoutSeconds: setup.policy?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
    expirationMarginLedgers: setup.policy?.expirationMarginLedgers ?? DEFAULT_EXPIRATION_MARGIN_LEDGERS,
    maxTransactionFeeStroops: setup.policy?.maxTransactionFeeStroops ?? DEFAULT_MAX_TRANSACTION_FEE_STROOPS,
    inclusionFeeStroops: setup.policy?.inclusionFeeStroops ?? MIN_INCLUSION_FEE_STROOPS,
  };
  if (policy.assets.size === 0) throw new Error(`${setup.network}: at least one asset must be accepted`);
  if (policy.inclusionFeeStroops < MIN_INCLUSION_FEE_STROOPS) {
    throw new Error(`${setup.network}: inclusionFeeStroops must be at least ${MIN_INCLUSION_FEE_STROOPS}`);
  }
  if (policy.timeoutSeconds.min > policy.timeoutSeconds.max) {
    throw new Error(`${setup.network}: timeoutSeconds.min exceeds max`);
  }
  if (!Number.isInteger(policy.expirationMarginLedgers) || policy.expirationMarginLedgers < 1) {
    // An authorization expiring at the current ledger can no longer be included.
    throw new Error(`${setup.network}: expirationMarginLedgers must be an integer of at least 1`);
  }
  return policy;
}
