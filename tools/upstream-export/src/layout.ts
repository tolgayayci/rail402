/**
 * Where each exported file of this repository lives in an x402-foundation/x402 checkout.
 *
 * The settlement contract's crate and its deployment records are copied byte for byte, so the
 * source archive hash embedded in the deployed WASM can be reproduced from either repository.
 * `packages/upto` becomes the `upto` directory of the x402 Stellar mechanism
 * (`@x402/stellar/upto/{client,server,facilitator}`), with its tests next to the mechanism's own.
 */

/** The Stellar mechanism package inside the x402 monorepo. */
export const MECHANISM = "typescript/packages/mechanisms/stellar";

export type FileKind = "typescript" | "verbatim";

export interface LayoutRule {
  /** A file, or a directory ending in `/`, of this repository. */
  readonly from: string;
  /** The corresponding file or directory of the x402 checkout. */
  readonly to: string;
  /** `typescript` files get their imports mapped and the x402 lint rules applied. */
  readonly kind: FileKind;
}

export const RULES: readonly LayoutRule[] = [
  { from: "contracts/stellar/upto/", to: "contracts/stellar/upto/", kind: "verbatim" },
  { from: "contracts/stellar/deployments/", to: "contracts/stellar/deployments/", kind: "verbatim" },
  { from: "packages/upto/src/", to: `${MECHANISM}/src/upto/`, kind: "typescript" },
  {
    from: "packages/upto/test/client-server.test.ts",
    to: `${MECHANISM}/test/unit/upto-client-server.test.ts`,
    kind: "typescript",
  },
  {
    from: "packages/upto/test/codec.test.ts",
    to: `${MECHANISM}/test/unit/upto-codec.test.ts`,
    kind: "typescript",
  },
  {
    from: "packages/upto/test/facilitator.test.ts",
    to: `${MECHANISM}/test/unit/upto-facilitator.test.ts`,
    kind: "typescript",
  },
  {
    from: "packages/upto/test/vectors.test.ts",
    to: `${MECHANISM}/test/unit/upto-vectors.test.ts`,
    kind: "typescript",
  },
  { from: "packages/upto/test/helpers.ts", to: `${MECHANISM}/test/unit/upto-helpers.ts`, kind: "typescript" },
  {
    from: "packages/upto/scripts/vectors.ts",
    to: `${MECHANISM}/test/fixtures/upto-stellar-vectors.ts`,
    kind: "typescript",
  },
  {
    from: "packages/upto/test/fixtures/upto-stellar-vectors.json",
    to: `${MECHANISM}/test/fixtures/upto-stellar-vectors.json`,
    kind: "verbatim",
  },
];

/**
 * Files under the scanned directories that stay in this repository: they depend on its test kit,
 * code registry or build scripts, and the x402 checkout has its own README, package manifest,
 * integration test and contract README instead.
 */
export const LOCAL_ONLY: ReadonlySet<string> = new Set([
  "contracts/stellar/README.md",
  "packages/upto/README.md",
  "packages/upto/package.json",
  "packages/upto/tsconfig.build.json",
  "packages/upto/test/codes.test.ts",
  "packages/upto/test/deployment.test.ts",
  "packages/upto/test/upto.integration.test.ts",
]);

/** Directories of this repository whose every file must be exported or listed in {@link LOCAL_ONLY}. */
export const SCANNED = ["contracts/stellar/", "packages/upto/"] as const;

/** Directories of the x402 checkout that hold exported files only; anything else in them is drift. */
export const MANAGED_DIRECTORIES = RULES.filter((rule) => rule.to.endsWith("/")).map((rule) => rule.to);

/** Build output and caches, never exported and never compared. */
export const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  "target",
  "test_snapshots",
  "dist",
  "coverage",
]);

/** The x402 mechanism modules that may define the names this repository imports from `@x402/stellar`. */
export const STELLAR_MODULES = ["constants", "types", "signer", "utils", "shared", "defaultAssets"].map(
  (name) => `${MECHANISM}/src/${name}.ts`,
);

/** Entry points `@x402/stellar/upto/*` that the mechanism must publish, as `package.json` exports and tsup entries. */
export const ENTRY_POINTS = ["client", "server", "facilitator"].map((name) => `upto/${name}`);

/**
 * The x402 path of a file of this repository, or `undefined` when it is not exported. A directory
 * of TypeScript maps only its `.ts` files.
 */
export function mapPath(path: string): { readonly to: string; readonly kind: FileKind } | undefined {
  for (const rule of RULES) {
    const matches = rule.from.endsWith("/")
      ? path.startsWith(rule.from) && (rule.kind !== "typescript" || path.endsWith(".ts"))
      : path === rule.from;
    if (matches) {
      return {
        to: rule.to.endsWith("/") ? rule.to + path.slice(rule.from.length) : rule.to,
        kind: rule.kind,
      };
    }
  }
  return undefined;
}
