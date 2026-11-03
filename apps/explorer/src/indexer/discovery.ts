import type { RegistrySnapshot } from "@rail402.dev/x402-index";
import type { RouteKind } from "../db.ts";

/**
 * How often a route is walked at the head: `every` round for addresses that pay fees or move funds (fee
 * payers, sponsors, relayers, upto contracts), so their activity is complete; `slow` for addresses that
 * Lumeus lists only when they pay a fee or move funds themselves, which channels and upto authorities
 * rarely do (they are mostly transaction or operation sources only; indexing rules §12).
 */
export type RouteCadence = "every" | "slow";

/** One discovery route: the activity of a registry address, bounded by its registry ledger ranges. */
export interface DiscoveryRoute {
  readonly kind: RouteKind;
  readonly address: string;
  /** The first ledger to walk. */
  readonly from: number;
  /** The last ledger to walk, or null to follow the head. */
  readonly to: number | null;
  readonly cadence: RouteCadence;
}

/** Roles whose accounts pay the fee of the transactions they take part in. */
const FEE_PAYING_ROLES: ReadonlySet<string> = new Set(["sponsor", "fee-bump", "relayer"]);

/** The ledgers a registry-scope index covers: from the epoch start (or a later ledger) to the head or `to`. */
export interface DiscoveryScope {
  readonly from: number;
  readonly to?: number | undefined;
}

/**
 * The discovery routes of a registry epoch: one account route per facilitator account (every role: fee
 * payers, sponsors, channels, settlement authorities, relayers), one contract route per upto contract
 * whose settlements emit an event (R-UPTO), and one approvals route per beta upto contract
 * (R-UPTO-BETA), whose settlements emit no event of the contract and move no funds through it, but grant
 * it an allowance in the same transaction (the token's `approve` event names it as the spender). Each is
 * bounded by the union of that address's registry ranges and clipped to `scope`. An address listed in two
 * ranges gets one route over both; the ledgers between them are read too and attributed by ledger as
 * always, so nothing is lost and nothing is attributed outside a range. The indexer passes only
 * `scope.from`: a bounded run's last ledger is applied by the walk, never stored as a route bound.
 */
export function discoveryPlan(
  registry: RegistrySnapshot,
  epoch: string,
  scope: DiscoveryScope,
): DiscoveryRoute[] {
  const hulls = new Map<
    string,
    { kind: RouteKind; address: string; from: number; to: number | null; cadence: RouteCadence }
  >();
  const add = (kind: RouteKind, address: string, from: number, to: number | null, cadence: RouteCadence) => {
    const key = `${kind}:${address}`;
    const known = hulls.get(key);
    if (known === undefined) hulls.set(key, { kind, address, from, to, cadence });
    else {
      known.from = Math.min(known.from, from);
      known.to = known.to === null || to === null ? null : Math.max(known.to, to);
      if (cadence === "every") known.cadence = "every";
    }
  };
  for (const facilitator of registry.document.facilitators) {
    for (const account of facilitator.accounts) {
      if (account.epoch === epoch)
        add(
          "account",
          account.address,
          account.validFromLedger,
          account.validToLedger,
          FEE_PAYING_ROLES.has(account.role) ? "every" : "slow",
        );
    }
  }
  for (const entry of registry.document.uptoContracts) {
    if (entry.epoch === epoch)
      add(
        entry.rule === "R-UPTO-BETA" ? "approvals" : "contract",
        entry.contract,
        entry.validFromLedger,
        entry.validToLedger,
        "every",
      );
  }
  const routes: DiscoveryRoute[] = [];
  for (const hull of hulls.values()) {
    const from = Math.max(hull.from, scope.from);
    const to =
      hull.to === null ? (scope.to ?? null) : scope.to === undefined ? hull.to : Math.min(hull.to, scope.to);
    if (to !== null && to < from) continue;
    routes.push({ kind: hull.kind, address: hull.address, from, to, cadence: hull.cadence });
  }
  return routes.sort((a, b) => a.kind.localeCompare(b.kind) || a.address.localeCompare(b.address));
}
