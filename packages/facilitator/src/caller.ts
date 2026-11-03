import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Who asked for the settlement being run: the HTTP service sets it per request, so the settlement
 * engine can record the caller on each settlement and hold each caller to its own sponsor budget
 * without changing the upstream `verify`/`settle` signatures.
 */
export interface CallerContext {
  /** `key:<id>` for an access-key holder, `public` for keyless callers. */
  readonly subject: string;
  /** Fees this caller's settlements may commit per hour on the network, in stroops; unset = no own cap. */
  readonly sponsorBudgetStroopsPerHour?: bigint;
  /**
   * The service fee in US dollars (a decimal string) each of this caller's settlements accrues,
   * recorded with the settlement so a later price change never reprices it; unset = none.
   */
  readonly serviceFeeUsd?: string;
}

/** The subject recorded when no caller is known (in-process use, or keyless). */
export const PUBLIC_CALLER = "public";

const storage = new AsyncLocalStorage<CallerContext>();

/** Runs `fn` with `caller` as the current caller of every settlement it starts. */
export function withCaller<T>(caller: CallerContext, fn: () => T): T {
  return storage.run(caller, fn);
}

/** The caller of the request being served, if one was set. */
export function currentCaller(): CallerContext | undefined {
  return storage.getStore();
}
