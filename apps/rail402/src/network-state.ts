/**
 * Whether one network of the process is serving `/verify` and `/settle`. One process can serve several
 * networks; a problem on one of them (an unreachable RPC, an unfunded sponsor, unverified assets) holds
 * only that network, which answers its own requests with a coded, retryable 503 while the others
 * serve.
 */

/** `starting` until the first evaluation, then `serving` or `held`. */
export type NetworkServingState = "starting" | "serving" | "held";

export type HoldReason =
  | "rpc_unreachable"
  | "sponsor_missing"
  | "sponsor_below_reserve"
  | "sponsor_balance_unknown"
  | "asset_unverified"
  | "asset_contradicts_config"
  | "channels_missing"
  | "upto_contract_mismatch"
  | "sponsor_signers_unsafe"
  | "provisioning_busy";

export const HOLD_REASONS: readonly HoldReason[] = [
  "rpc_unreachable",
  "sponsor_missing",
  "sponsor_below_reserve",
  "sponsor_balance_unknown",
  "asset_unverified",
  "asset_contradicts_config",
  "channels_missing",
  "upto_contract_mismatch",
  "sponsor_signers_unsafe",
  "provisioning_busy",
];

/**
 * Reasons that never clear by themselves: the chain contradicts the configuration, so the operator
 * must change the configuration and restart.
 */
export const STICKY_HOLDS: ReadonlySet<HoldReason> = new Set([
  "asset_contradicts_config",
  "upto_contract_mismatch",
]);

/** What a held network's refusals say, without numbers, addresses or provider details. */
const PUBLIC_REASONS: Readonly<Record<HoldReason, string>> = {
  rpc_unreachable: "its RPC cannot be reached",
  sponsor_missing: "its fee sponsor account does not exist",
  sponsor_below_reserve: "its fee sponsor is below its reserve",
  sponsor_balance_unknown: "its fee sponsor's balance has not been read yet",
  asset_unverified: "its accepted assets are not verified yet",
  asset_contradicts_config: "an accepted asset contradicts its configuration",
  channels_missing: "its channel accounts are not provisioned",
  upto_contract_mismatch: "its upto contract runs other code than configured",
  sponsor_signers_unsafe: "its fee sponsor's signers leave the account unprotected",
  provisioning_busy: "another replica is still provisioning its accounts",
};

/** Seconds a client should wait before retrying a held network. */
export const HELD_RETRY_AFTER_SECONDS = 30;

export interface NetworkGateSnapshot {
  readonly state: NetworkServingState;
  readonly holdReason: HoldReason | null;
  /** When the network last started serving; null while it is not serving. */
  readonly servingSince: Date | null;
}

export class NetworkGate {
  readonly network: string;
  private current: NetworkGateSnapshot = { state: "starting", holdReason: null, servingSince: null };
  private readonly onChange: ((snapshot: NetworkGateSnapshot) => void) | undefined;

  constructor(network: string, onChange?: (snapshot: NetworkGateSnapshot) => void) {
    this.network = network;
    this.onChange = onChange;
  }

  snapshot(): NetworkGateSnapshot {
    return this.current;
  }

  get serving(): boolean {
    return this.current.state === "serving";
  }

  /** The sticky reason this network is held for, if any. */
  get stickyHold(): HoldReason | undefined {
    const reason = this.current.holdReason;
    return reason !== null && STICKY_HOLDS.has(reason) ? reason : undefined;
  }

  /** Holds the network for `reason`; a sticky reason already in place is kept. */
  hold(reason: HoldReason): void {
    const reasonNow = this.stickyHold ?? reason;
    if (this.current.state === "held" && this.current.holdReason === reasonNow) return;
    this.set({ state: "held", holdReason: reasonNow, servingSince: null });
  }

  /** Serves the network, unless it is held for a sticky reason. */
  serve(now = new Date()): void {
    if (this.stickyHold !== undefined || this.current.state === "serving") return;
    this.set({ state: "serving", holdReason: null, servingSince: now });
  }

  /** Why `/verify` and `/settle` are refused for this network, or undefined while it serves. */
  refusal(): string | undefined {
    if (this.serving) return undefined;
    const why = this.current.holdReason === null ? "it is starting" : PUBLIC_REASONS[this.current.holdReason];
    return `${this.network} is not serving: ${why}. Retry later.`;
  }

  private set(snapshot: NetworkGateSnapshot): void {
    this.current = snapshot;
    try {
      this.onChange?.(snapshot);
    } catch {
      // Instrumentation never changes the state.
    }
  }
}
