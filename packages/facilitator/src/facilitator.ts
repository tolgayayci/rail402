import { Keypair, type rpc } from "@stellar/stellar-sdk";
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
import { deriveChannelKeypairs, keypairSigner } from "./keys.ts";
import type { SettlementLedger } from "./ledger.ts";
import { RpcLedgerSeconds } from "./ledger-seconds.ts";
import { RpcPool } from "./rpc-pool.ts";
import { silentLogger, type Logger } from "./logger.ts";
import { MemorySettlementLedger } from "./memory-ledger.ts";
import type { SettlementObserver } from "./observer.ts";
import {
  DEFAULT_EXPIRATION_MARGIN_LEDGERS,
  DEFAULT_MAX_TRANSACTION_FEE_STROOPS,
  DEFAULT_TIMEOUT_SECONDS,
  DEFAULT_UPTO_MAX_TRANSACTION_FEE_STROOPS,
  MIN_INCLUSION_FEE_STROOPS,
  PUBNET_MIN_INCLUSION_FEE_STROOPS,
  acceptedAsset,
  type AcceptedAsset,
  type NetworkPolicy,
  type UptoPolicy,
} from "./policy.ts";
import { StellarExactScheme } from "./scheme.ts";
import { FacilitatorSetupError } from "./setup-error.ts";
import { StellarUptoScheme } from "./upto-scheme.ts";

export interface NetworkSetup {
  readonly network: StellarNetwork;
  readonly rpcUrl: string;
  /** Secret seed (S…) of the sponsor account. Channel keys are derived from it. */
  readonly sponsorSecret: string;
  readonly channelCount: number;
  /**
   * Accepted assets. Testnet defaults to Circle's USDC; pubnet has no default and refuses to start
   * without at least one (`config_pubnet_assets_missing`).
   */
  readonly assets?: readonly AcceptedAsset[];
  readonly policy?: Partial<Omit<NetworkPolicy, "network" | "assets">>;
  /** Durable stores. The in-memory defaults suit a single in-process facilitator only. */
  readonly ledger?: SettlementLedger;
  readonly channels?: ChannelPool;
  readonly timing?: Partial<SettlementTiming>;
  /** Bid inclusion fees from the network's fee stats; the policy's fixed bid is used otherwise. */
  readonly inclusionFee?: InclusionFeeOptions;
  /** Refuses settlements while the sponsor cannot safely pay for them. Required on pubnet unless `unguarded`. */
  readonly guard?: SponsorGuard;
  /** Pubnet only: run without a `guard`, accepting that nothing bounds what the sponsor spends. */
  readonly unguarded?: boolean;
  /** Pubnet only: accept an inclusion-fee floor below 200 stroops, whose bids may never be included. */
  readonly allowInclusionFeeBelowFloor?: boolean;
  /**
   * The network's RPC providers, when there are several (`rpcUrl` is then the first's URL). Each
   * settlement uses the provider active when it was claimed; see `RpcPool`.
   */
  readonly rpc?: RpcPool;
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
  /**
   * After a sponsor rotation: the previous settlement authority (derived from the previous sponsor),
   * still accepted for settlement until `validUntil`, so payloads signed before the rotation can be
   * settled while they are valid. `/supported` names only the current authority.
   */
  readonly previousAuthority?: { readonly keypair: Keypair; readonly validUntil: Date };
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
  /** The network's RPC providers (one, unless several were configured). */
  readonly rpc: RpcPool;
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
  /**
   * Finishes recorded settlements whose outcome is still open, on every network at once and each on
   * its own: a network whose ledger or RPC fails is logged and skipped, never holding up another.
   * Run at startup and periodically.
   */
  reconcile(): Promise<number>;
  /** `reconcile` for one network; rejects when that network's round fails. */
  reconcileNetwork(network: StellarNetwork): Promise<number>;
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
        rpcUrl: () => runtime.rpc.active.url,
        server: runtime.server,
        verifyTimeoutMs: runtime.rpc.timeoutMs,
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
          ...(setup.upto?.previousAuthority === undefined
            ? {}
            : {
                previousAuthority: {
                  signer: keypairSigner(
                    setup.upto.previousAuthority.keypair,
                    networkPassphrase(setup.network),
                  ),
                  validUntil: setup.upto.previousAuthority.validUntil,
                },
              }),
          log,
        }),
      );
    }
  }

  return {
    core,
    networks,
    async reconcile() {
      const rounds = await Promise.allSettled(
        [...networks.values()].map((runtime) => runtime.engine.reconcile()),
      );
      let finished = 0;
      for (const [index, round] of rounds.entries()) {
        if (round.status === "fulfilled") finished += round.value;
        else {
          const network = [...networks.keys()][index];
          log.error({ err: round.reason, network }, "reconciliation failed for a network");
        }
      }
      return finished;
    },
    async reconcileNetwork(network) {
      const runtime = networks.get(network);
      if (runtime === undefined) throw new Error(`network ${network} is not configured`);
      return runtime.engine.reconcile();
    },
  };
}

function buildNetwork(setup: NetworkSetup, log: Logger, observer?: SettlementObserver): NetworkRuntime {
  const { network } = setup;
  if (setup.rpc === undefined && (typeof setup.rpcUrl !== "string" || setup.rpcUrl === "")) {
    throw new FacilitatorSetupError("config_rpc_missing", `${network}: rpcUrl (or rpc) is required`);
  }
  if (typeof setup.sponsorSecret !== "string" || setup.sponsorSecret === "") {
    throw new FacilitatorSetupError(
      "config_sponsor_secret_missing",
      `${network}: sponsorSecret is required: the fee sponsor's S… seed`,
    );
  }
  const pool = setup.rpc ?? new RpcPool([{ alias: "primary", url: setup.rpcUrl }]);
  for (const provider of pool.providers) {
    if (network === PUBNET && new URL(provider.url).protocol !== "https:")
      throw new FacilitatorSetupError("config_pubnet_rpc_insecure", "pubnet RPC must use https");
  }
  if (!Number.isInteger(setup.channelCount) || setup.channelCount < 1) {
    throw new Error(`channelCount must be a positive integer, got ${setup.channelCount}`);
  }

  if (network === PUBNET) assertPubnetSetup(setup);

  const sponsor = Keypair.fromSecret(setup.sponsorSecret);
  const channelKeys = deriveChannelKeypairs(sponsor, network, setup.channelCount);
  const channelAddresses = channelKeys.map((keypair) => keypair.publicKey());
  const channels = setup.channels ?? new MemoryChannelPool(channelAddresses);
  const unknown = channels.addresses.filter((address) => !channelAddresses.includes(address));
  if (unknown.length > 0)
    throw new Error(`channel pool holds accounts not derived from the sponsor: ${unknown.join(", ")}`);

  const policy = resolvePolicy(setup);
  const server = pool.server;
  const upto =
    setup.upto === undefined ? undefined : resolveUptoPolicy(setup, setup.upto, policy, server, log);
  const authority = upto === undefined ? undefined : deriveAuthorityKeypair(sponsor, network);
  const engine = new SettlementEngine({
    network,
    passphrase: networkPassphrase(network),
    rpcUrl: pool.active.url,
    server,
    rpc: pool,
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
    rpc: pool,
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
  if (contractWasmHash === undefined) {
    // Without the hash nobody checks which code a non-canonical contract runs.
    throw new Error(`${setup.network}: upto contractWasmHash is required for a non-canonical contract`);
  }
  if (!/^[0-9a-f]{64}$/.test(contractWasmHash)) {
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

/**
 * Pubnet spends real XLM on every settlement, so nothing money-relevant is left to a default there:
 * a sponsor guard (or an explicit `unguarded`), the fee ceilings, an inclusion floor of at least
 * 200 stroops (unless explicitly allowed lower) and the accepted assets.
 */
function assertPubnetSetup(setup: NetworkSetup): void {
  const name = setup.network;
  if (setup.guard === undefined && setup.unguarded !== true) {
    throw new FacilitatorSetupError(
      "config_pubnet_guard_missing",
      `${name}: a guard (e.g. SponsorBudget) is required, or unguarded: true to run without one`,
    );
  }
  // The token a payment is in is real money on pubnet: which ones are settled is an explicit choice.
  if (setup.assets === undefined || setup.assets.length === 0) {
    throw new FacilitatorSetupError(
      "config_pubnet_assets_missing",
      `${name}: assets is required: list each accepted token with acceptedAsset(), with a minAmount that bounds dust payments`,
    );
  }
  const policy = setup.policy;
  if (policy?.maxTransactionFeeStroops === undefined) {
    throw new FacilitatorSetupError(
      "config_pubnet_fee_ceiling_missing",
      `${name}: policy.maxTransactionFeeStroops is required: it bounds what one settlement may cost the sponsor`,
    );
  }
  if (policy.inclusionFeeStroops === undefined) {
    throw new FacilitatorSetupError(
      "config_pubnet_fee_ceiling_missing",
      `${name}: policy.inclusionFeeStroops is required (at least ${String(PUBNET_MIN_INCLUSION_FEE_STROOPS)})`,
    );
  }
  const floors = [
    policy.inclusionFeeStroops,
    ...(setup.inclusionFee === undefined ? [] : [setup.inclusionFee.floor]),
  ];
  if (
    floors.some((floor) => floor < PUBNET_MIN_INCLUSION_FEE_STROOPS) &&
    setup.allowInclusionFeeBelowFloor !== true
  ) {
    throw new FacilitatorSetupError(
      "config_pubnet_inclusion_floor_too_low",
      `${name}: the inclusion fee is below ${String(PUBNET_MIN_INCLUSION_FEE_STROOPS)} stroops; set allowInclusionFeeBelowFloor: true to accept that`,
    );
  }
  if (setup.upto !== undefined && setup.upto.maxTransactionFeeStroops === undefined) {
    throw new FacilitatorSetupError(
      "config_pubnet_fee_ceiling_missing",
      `${name}: upto.maxTransactionFeeStroops is required`,
    );
  }
}

/** A ledger-seconds source read from the network's own RPC, cached (see `RpcLedgerSeconds`). */
function ledgerSecondsFrom(estimate: RpcLedgerSeconds): LedgerSecondsSource {
  return () => estimate.seconds();
}

function resolvePolicy(setup: NetworkSetup): NetworkPolicy {
  // Pubnet never reaches the default: `assertPubnetSetup` requires explicit assets there.
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
