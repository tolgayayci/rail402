/**
 * The environment third-party code runs with: the upstream x402 e2e suite (`pnpm test` starts its
 * clients, servers and scripts), and the npm installs of the published packages, their dependencies
 * and the installed code (the live agent run, pack-check). It never inherits this process's
 * environment: only the variables a Node toolchain needs to run, from an allow-list, plus the
 * caller's own reviewed variables. Nothing that names a secret, a secret file, a run confirmation or a
 * run ledger is passed, whatever its name.
 */

/** Exact names passed through from this process. */
const ALLOWED = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "TERM",
  "TZ",
  "TMPDIR",
  "CI",
  "COLORTERM",
  "FORCE_COLOR",
  "NO_COLOR",
]);

/** Name prefixes passed through: locale, XDG directories and the Node/pnpm toolchain's settings. */
const ALLOWED_PREFIXES = ["LC_", "XDG_", "NODE_", "PNPM_", "npm_config_", "COREPACK_"];

/** Names that are never passed from this process, even when a prefix allows them. */
const SECRET_NAME =
  /SECRET|PRIVATE|TOKEN|PASSWORD|PASSWD|CREDENTIAL|AUTH|_KEY(?:_|$)|^KEY|CONFIRM|LEDGER|TREASURY|SPONSOR/i;

/** The suite variables the harness sets itself; they carry only run-scoped keys and local paths. */
export const SUITE_VARIABLES = new Set([
  "RAIL402_ROOT",
  "RAIL402_VERSION",
  "RAIL402_FACILITATOR_URL",
  "RAIL402_TARGET_FILE",
  "RAIL402_CATALOG_FILE",
  "FACILITATOR_STELLAR_PRIVATE_KEY",
  "CLIENT_STELLAR_PRIVATE_KEY",
  "SERVER_STELLAR_ADDRESS",
  "STELLAR_RPC_URL",
  "TESTNET_BAZAAR_MAX_NEW_LISTINGS_PER_PAYER_PER_HOUR",
  "TESTNET_BAZAAR_MAX_NEW_LISTINGS_PER_OWNER_PER_HOUR",
]);

/** Whether a variable of this process may reach the suite. */
export function passesThrough(name: string): boolean {
  if (SECRET_NAME.test(name)) return false;
  return ALLOWED.has(name) || ALLOWED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** The allowed variables of `parent`: what a Node toolchain needs, and nothing that names a secret. */
export function toolchainEnvironment(
  parent: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value !== undefined && passesThrough(name)) env[name] = value;
  }
  return env;
}

/**
 * The flags of every npm install that resolves dependencies from the registry: lifecycle scripts off,
 * so no dependency runs code while it installs (the workspace denies install scripts the same way),
 * and no audit or funding requests.
 */
export const NPM_INSTALL_FLAGS = ["--ignore-scripts", "--no-audit", "--no-fund"] as const;

/**
 * The suite's environment: the allowed variables of `parent` plus `suite`. A suite variable outside
 * `SUITE_VARIABLES` is refused, so a new one is a reviewed change.
 */
export function suiteEnvironment(
  parent: Readonly<Record<string, string | undefined>>,
  suite: Readonly<Record<string, string>>,
): Record<string, string> {
  const unknown = Object.keys(suite).filter((name) => !SUITE_VARIABLES.has(name));
  if (unknown.length > 0) throw new Error(`not a suite variable: ${unknown.join(", ")}`);
  return { ...toolchainEnvironment(parent), ...suite };
}
