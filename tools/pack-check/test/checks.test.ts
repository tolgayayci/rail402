import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  binsOf,
  entryPointProblems,
  exportTargets,
  fileProblems,
  importableSubpaths,
  licenseOf,
  lockName,
  lockProblems,
  manifestProblems,
  publishedExports,
  type PackedManifest,
} from "../src/checks.ts";

const expected = { name: "@rail402.dev/sdk", version: "0.3.0" };

const sourceManifest: PackedManifest = {
  name: "@rail402.dev/sdk",
  version: "0.3.0",
  license: "Apache-2.0",
  files: ["dist"],
  exports: {
    ".": { "@rail402/source": "./src/index.ts", types: "./dist/index.d.ts", default: "./dist/index.js" },
    "./seller": {
      "@rail402/source": "./src/seller/index.ts",
      types: "./dist/seller/index.d.ts",
      default: "./dist/seller/index.js",
    },
  },
  bin: { rail402: "./dist/bin.js" },
  dependencies: { "@rail402.dev/stellar": "0.3.0", zod: "4.1.0" },
  devDependencies: { "@rail402.dev/testkit": "0.3.0" },
  peerDependencies: { vitest: ">=4" },
  peerDependenciesMeta: { vitest: { optional: true } },
};

/** The manifest as pnpm packs it: `publishConfig.exports` in place of the repository's `exports`. */
const manifest: PackedManifest = { ...sourceManifest, exports: publishedExports(sourceManifest.exports) };

const files = [
  "LICENSE",
  "README.md",
  "package.json",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/index.js.map",
  "dist/seller/index.js",
  "dist/seller/index.d.ts",
  "dist/bin.js",
];
const read = (file: string) => (file === "dist/bin.js" ? "#!/usr/bin/env node\nimport './main.js';\n" : "");

describe("manifest", () => {
  it("accepts a lockstep, fully resolved, Apache-2.0 manifest", () => {
    expect(manifestProblems(manifest, expected)).toEqual([]);
  });

  it("refuses workspace specifiers, drifting internal versions and required peers", () => {
    const problems = manifestProblems(
      {
        ...manifest,
        version: "0.2.1",
        license: "MIT",
        dependencies: {
          "@rail402.dev/stellar": "workspace:*",
          "@rail402.dev/errors": "0.2.1",
          zod: "catalog:",
        },
        peerDependencies: { vitest: ">=4" },
        peerDependenciesMeta: {},
      },
      expected,
    );
    expect(problems).toEqual([
      "version is 0.2.1, not 0.3.0",
      "license is MIT, not Apache-2.0",
      'dependencies.@rail402.dev/stellar keeps the workspace specifier "workspace:*"',
      'dependencies.@rail402.dev/stellar is "workspace:*", not the lockstep version 0.3.0',
      'dependencies.@rail402.dev/errors is "0.2.1", not the lockstep version 0.3.0',
      'dependencies.zod keeps the workspace specifier "catalog:"',
      "peerDependencies.vitest is not optional: every install would demand it",
    ]);
  });

  it("refuses exports that keep the repository-only source condition", () => {
    expect(manifestProblems(sourceManifest, expected)).toEqual([
      'exports keeps the repository-only "@rail402/source" condition, which points at unpublished sources',
    ]);
  });

  it("publishes every public package's exports without the source condition", () => {
    const root = fileURLToPath(new URL("../../../packages/", import.meta.url));
    for (const directory of readdirSync(root)) {
      const path = join(root, directory, "package.json");
      if (!existsSync(path)) continue;
      const pkg = JSON.parse(readFileSync(path, "utf8")) as {
        name: string;
        private?: boolean;
        exports?: unknown;
        publishConfig?: { exports?: unknown };
      };
      if (pkg.private === true) continue;
      expect(pkg.publishConfig?.exports, pkg.name).toEqual(publishedExports(pkg.exports));
    }
  });

  it("refuses a private package and another name", () => {
    expect(manifestProblems({ ...manifest, private: true, name: "x" }, expected)).toEqual([
      "name is x, not @rail402.dev/sdk",
      "the package is private",
    ]);
  });
});

describe("files", () => {
  it("accepts the root files and the published directories", () => {
    expect(fileProblems(files, manifest)).toEqual([]);
    expect(fileProblems([...files, "models/model.json"], { ...manifest, files: ["dist", "models"] })).toEqual(
      [],
    );
  });

  it("refuses missing root files, sources, tests, env files and stray maps", () => {
    const problems = fileProblems(
      ["package.json", "dist/index.js", "src/index.ts", "dist/a.test.js", "dist/.env", "lib/x.js.map"],
      manifest,
    );
    expect(problems).toEqual([
      "README.md is missing",
      "LICENSE is missing",
      "src/index.ts is outside the published directories (dist)",
      "src/index.ts: sources and tests are not published",
      "dist/a.test.js: a test file is published",
      "dist/.env: environment files are never published",
      "lib/x.js.map is outside the published directories (dist)",
      "lib/x.js.map: a source map outside dist",
    ]);
  });
});

describe("entry points", () => {
  it("resolves every export and bin, ignoring the repository-only source condition", () => {
    expect(exportTargets(sourceManifest.exports).map((entry) => entry.target)).toEqual([
      "./dist/index.d.ts",
      "./dist/index.js",
      "./dist/seller/index.d.ts",
      "./dist/seller/index.js",
    ]);
    expect(importableSubpaths(manifest)).toEqual([".", "./seller"]);
    expect(binsOf(manifest)).toEqual({ rail402: "./dist/bin.js" });
    expect(binsOf({ name: "@rail402.dev/cli", bin: "./dist/bin.js" })).toEqual({ cli: "./dist/bin.js" });
    expect(entryPointProblems(manifest, files, read)).toEqual([]);
  });

  it("refuses missing targets and a bin without a node shebang", () => {
    const problems = entryPointProblems(
      manifest,
      files.filter((file) => file !== "dist/seller/index.js"),
      () => "import './main.js';",
    );
    expect(problems).toEqual([
      'exports["./seller"].default → ./dist/seller/index.js is not in the tarball',
      'bin rail402 → ./dist/bin.js does not start with "#!/usr/bin/env node"',
    ]);
    expect(entryPointProblems({ ...manifest, exports: undefined }, files, read)).toContain(
      "exports names no entry point",
    );
  });
});

describe("clean install", () => {
  const names = ["@rail402.dev/sdk", "@rail402.dev/stellar"];

  it("accepts Rail402 packages installed once each from their tarballs", () => {
    expect(
      lockProblems(
        {
          packages: {
            "": {},
            "node_modules/@rail402.dev/sdk": { version: "0.3.0", resolved: "file:t/sdk.tgz" },
            "node_modules/@rail402.dev/stellar": { version: "0.3.0", resolved: "file:t/stellar.tgz" },
            "node_modules/zod": {
              version: "4.1.0",
              resolved: "https://registry.npmjs.org/zod/-/zod-4.1.0.tgz",
            },
          },
        },
        { names, version: "0.3.0" },
      ),
    ).toEqual([]);
  });

  it("refuses a registry copy, a second copy, a stray package and a missing one", () => {
    const problems = lockProblems(
      {
        packages: {
          "node_modules/@rail402.dev/sdk": { version: "0.1.4", resolved: "https://registry.npmjs.org/x.tgz" },
          "node_modules/@rail402.dev/sdk/node_modules/@rail402.dev/sdk": {
            version: "0.3.0",
            resolved: "file:a",
          },
          "node_modules/@rail402.dev/other": { version: "0.3.0", resolved: "file:b" },
        },
      },
      { names, version: "0.3.0" },
    );
    expect(problems).toEqual([
      "node_modules/@rail402.dev/sdk resolved from https://registry.npmjs.org/x.tgz, not a local tarball",
      "node_modules/@rail402.dev/sdk is 0.1.4, not 0.3.0",
      "@rail402.dev/stellar is not installed",
      "@rail402.dev/sdk is installed 2 times",
      "@rail402.dev/other is installed but was not packed",
    ]);
    expect(lockName("node_modules/a/node_modules/@b/c")).toBe("@b/c");
  });

  it("reads licences in every package.json form", () => {
    expect(licenseOf({ license: "MIT" })).toBe("MIT");
    expect(licenseOf({ license: { type: "ISC" } })).toBe("ISC");
    expect(licenseOf({ licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] })).toBe("(MIT OR Apache-2.0)");
    expect(licenseOf({})).toBe("UNKNOWN");
  });
});
