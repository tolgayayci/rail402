/**
 * Node built-ins for the few SDK features that only exist in Node (key files, the home directory).
 * They are resolved when a feature is used, through `process.getBuiltinModule`, never imported
 * statically, so the buyer's code also loads in browsers, where these features report that they are
 * unavailable.
 */

interface NodeHost {
  readonly platform?: string;
  getBuiltinModule?(id: string): unknown;
}

function host(): NodeHost | undefined {
  return (globalThis as { process?: NodeHost }).process;
}

/** A Node built-in module, or undefined outside Node. */
export function nodeBuiltin(id: `node:${string}`): unknown {
  return host()?.getBuiltinModule?.(id);
}

/** Node's `process.platform`, or undefined outside Node. */
export function nodePlatform(): string | undefined {
  return host()?.platform;
}
