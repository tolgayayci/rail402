/**
 * A probe answered from its last result for `ttlMs`, with concurrent callers sharing the one run in
 * progress: however many requests ask, the probed resource sees at most one call per `ttlMs`.
 * `probe` must not throw; it returns its failure as a result.
 *
 * With `staleWhileRunning`, a caller arriving while a refresh runs gets the last result at once instead
 * of waiting for the refresh (only the very first call waits), so a slow probed resource, such as a
 * database whose pool is contended, never holds the caller; the refreshed result answers once it is in,
 * at the latest when the probe's own timeout ends it.
 */
export function cachedProbe<T>(
  probe: () => Promise<T>,
  ttlMs: number,
  now: () => number = Date.now,
  options: { readonly staleWhileRunning?: boolean } = {},
): () => Promise<T> {
  let last: { readonly at: number; readonly result: T } | undefined;
  let running: Promise<T> | undefined;
  return () => {
    if (last !== undefined && now() - last.at < ttlMs) return Promise.resolve(last.result);
    running ??= probe()
      .then((result) => {
        last = { at: now(), result };
        return result;
      })
      .finally(() => {
        running = undefined;
      });
    if (options.staleWhileRunning === true && last !== undefined) return Promise.resolve(last.result);
    return running;
  };
}
