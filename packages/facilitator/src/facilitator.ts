import { Keypair, rpc } from "@stellar/stellar-sdk";
import { x402Facilitator } from "@x402/core/facilitator";
import { PUBNET, USDC, networkPassphrase, type StellarNetwork } from "@rail402.dev/stellar";
import { MemoryChannelPool, type ChannelPool } from "./channels.ts";
import { SettlementEngine, type SettlementTiming, type SponsorGuard } from "./engine.ts";
import { InclusionFeeOracle, type InclusionFeeOptions } from "./fees.ts";
import { deriveChannelKeypairs } from "./keys.ts";
import type { SettlementLedger } from "./ledger.ts";
import { silentLogger, type Logger } from "./logger.ts";
import { MemorySettlementLedger } from "./memory-ledger.ts";
import {
  DEFAULT_EXPIRATION_MARGIN_LEDGERS,
  DEFAULT_MAX_TRANSACTION_FEE_STROOPS,
  DEFAULT_TIMEOUT_SECONDS,
  MIN_INCLUSION_FEE_STROOPS,
  acceptedAsset,
  type AcceptedAsset,
  type NetworkPolicy,
} from "./policy.ts";
import { StellarExactScheme } from "./scheme.ts";

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
}

export interface FacilitatorOptions {
  readonly networks: readonly NetworkSetup[];
  readonly log?: Logger;
}

export interface NetworkRuntime {
  readonly network: StellarNetwork;
  readonly policy: NetworkPolicy;
  readonly server: rpc.Server;
  readonly engine: SettlementEngine;
  readonly channels: ChannelPool;
  readonly sponsorAddress: string;
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
    const runtime = buildNetwork(setup, log);
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

function buildNetwork(setup: NetworkSetup, log: Logger): NetworkRuntime {
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
    ...(setup.timing === undefined ? {} : { timing: setup.timing }),
    ...(setup.inclusionFee === undefined
      ? {}
      : { inclusionFee: new InclusionFeeOracle(server, setup.inclusionFee) }),
    ...(setup.guard === undefined ? {} : { guard: setup.guard }),
    log,
  });
  return { network, policy, server, engine, channels, sponsorAddress: sponsor.publicKey() };
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
  return policy;
}
