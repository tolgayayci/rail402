import { rpc } from "@stellar/stellar-sdk";

/** One RPC provider of a network: a short alias (shown in metrics and health) and its URL (never shown). */
export interface RpcProvider {
  readonly alias: string;
  readonly url: string;
}

/** The provider a settlement was claimed under; it submits through this one only. */
export interface PinnedRpc {
  readonly alias: string;
  readonly url: string;
  readonly server: rpc.Server;
}

export interface RpcPoolOptions {
  /** Consecutive unhealthy readings of the active provider before moving to another; default 2. */
  readonly failAfter?: number;
  /** Consecutive healthy readings of a higher-priority provider before moving back to it; default 5. */
  readonly recoverAfter?: number;
  /** Called after every switch of the active provider. */
  readonly onSwitch?: (from: string, to: string) => void;
  /** How long one RPC call may take before it fails, in milliseconds; default `DEFAULT_RPC_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/**
 * The default bound on one RPC call. The Stellar SDK sets none (its fetch client then waits for the
 * platform default, minutes), so a hung provider would hold a settlement past its claim and channel
 * lease windows. It stays well below the engine's claim TTL (30 s) and the channel lease TTL (120 s).
 */
export const DEFAULT_RPC_TIMEOUT_MS = 10_000;

/** A Stellar RPC client whose every call fails after `timeoutMs`. */
export function boundedRpcServer(url: string, timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS): rpc.Server {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("the RPC timeout must be a positive integer of milliseconds");
  }
  const server = new rpc.Server(url, { allowHttp: new URL(url).protocol === "http:" });
  // `rpc.Server` ignores its own `timeout` option; the HTTP client's defaults apply to every call.
  server.httpClient.defaults.timeout = timeoutMs;
  return server;
}

/**
 * The ordered RPC providers of one network, with one active at a time. Every settlement takes the
 * active provider when it is claimed and simulates and submits through it alone (`pin`), so a switch
 * never sends one settlement through two providers; reads (confirmation, reconciliation, polling) use
 * whichever provider is active (`server`). The active provider changes only between readings: after
 * it was unhealthy `failAfter` times in a row the first healthy provider in order takes over, and a
 * higher-priority provider that was healthy `recoverAfter` times in a row takes back over.
 */
export class RpcPool {
  readonly providers: readonly RpcProvider[];
  /** One client per provider, by alias. */
  readonly servers: ReadonlyMap<string, rpc.Server>;
  /** A client that always talks to the active provider. */
  readonly server: rpc.Server;
  private activeIndex = 0;
  private readonly unhealthy = new Map<string, number>();
  private readonly healthy = new Map<string, number>();
  /** How long one RPC call may take, in milliseconds; also the bound on upstream verification. */
  readonly timeoutMs: number;
  private readonly options: RpcPoolOptions;

  constructor(providers: readonly RpcProvider[], options: RpcPoolOptions = {}) {
    if (providers.length === 0) throw new Error("an RPC pool needs at least one provider");
    if (new Set(providers.map((provider) => provider.alias)).size !== providers.length) {
      throw new Error("RPC provider aliases must be unique");
    }
    this.providers = providers;
    this.options = options;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    this.servers = new Map(
      providers.map((provider) => [provider.alias, boundedRpcServer(provider.url, options.timeoutMs)]),
    );
    this.server = new Proxy({} as rpc.Server, {
      get: (_target, property) => {
        const server = this.activeServer as unknown as Record<string | symbol, unknown>;
        const value = server[property];
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(server) : value;
      },
    });
  }

  get active(): RpcProvider {
    return this.providers[this.activeIndex] ?? (this.providers[0] as RpcProvider);
  }

  get activeServer(): rpc.Server {
    return this.servers.get(this.active.alias) as rpc.Server;
  }

  /** The active provider, for one settlement to use throughout. */
  pin(): PinnedRpc {
    const { alias, url } = this.active;
    return { alias, url, server: this.activeServer };
  }

  /**
   * Records one health reading per provider and switches the active provider when the readings say
   * so (see the class). Returns the alias of the provider switched to, if any.
   */
  observe(readings: ReadonlyMap<string, boolean>): string | undefined {
    for (const provider of this.providers) {
      const ok = readings.get(provider.alias);
      if (ok === undefined) continue;
      this.healthy.set(provider.alias, ok ? (this.healthy.get(provider.alias) ?? 0) + 1 : 0);
      this.unhealthy.set(provider.alias, ok ? 0 : (this.unhealthy.get(provider.alias) ?? 0) + 1);
    }
    const failAfter = this.options.failAfter ?? 2;
    const recoverAfter = this.options.recoverAfter ?? 5;
    // Back to the first higher-priority provider that has stayed healthy long enough.
    for (let index = 0; index < this.activeIndex; index++) {
      const alias = this.providers[index]?.alias ?? "";
      if ((this.healthy.get(alias) ?? 0) >= recoverAfter) return this.switchTo(index);
    }
    if ((this.unhealthy.get(this.active.alias) ?? 0) < failAfter) return undefined;
    const next = this.providers.findIndex(
      (provider, index) => index !== this.activeIndex && (this.healthy.get(provider.alias) ?? 0) > 0,
    );
    return next === -1 ? undefined : this.switchTo(next);
  }

  private switchTo(index: number): string {
    const from = this.active.alias;
    this.activeIndex = index;
    const to = this.active.alias;
    this.unhealthy.set(to, 0);
    try {
      this.options.onSwitch?.(from, to);
    } catch {
      // Instrumentation never changes the switch.
    }
    return to;
  }
}
