/**
 * Runs `run(key)` at most once at a time per key: a call while the key's run is under way returns at
 * once without starting another. A run that outlasts `deadlineMs` (a database call that never answers,
 * say) is reported to `onOverrun` and stops blocking the key, so the next call starts a fresh run
 * instead of the key's background work stopping for good.
 *
 * @param run - The work for one key
 * @param options - The deadline and what to do when a run outlasts it
 * @returns A function that starts `run(key)` unless one is under way, and settles when it finishes or
 *   its deadline passes
 */
export function singleFlight<K>(
  run: (key: K) => Promise<void>,
  options: { readonly deadlineMs: number; readonly onOverrun: (key: K) => void },
): (key: K) => Promise<void> {
  const running = new Map<K, symbol>();
  return async (key: K) => {
    if (running.has(key)) return;
    const token = Symbol(String(key));
    running.set(key, token);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"overrun">((resolve) => {
      timer = setTimeout(() => {
        resolve("overrun");
      }, options.deadlineMs);
      timer.unref();
    });
    try {
      const outcome = await Promise.race([run(key).then(() => "done" as const), deadline]);
      if (outcome === "overrun") options.onOverrun(key);
    } finally {
      clearTimeout(timer);
      if (running.get(key) === token) running.delete(key);
    }
  };
}
