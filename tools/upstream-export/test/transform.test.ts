import { describe, expect, it } from "vitest";
import { exportedNames, relativeSpecifier, transformImports, type ImportMap } from "../src/transform.ts";

const MECHANISM = "typescript/packages/mechanisms/stellar";

const map: ImportMap = {
  mapPath: (path) => {
    if (path.startsWith("packages/upto/src/")) return `${MECHANISM}/src/upto/${path.slice(18)}`;
    if (path === "packages/upto/test/fixtures/vectors.json") return `${MECHANISM}/test/fixtures/vectors.json`;
    if (path === "packages/upto/test/helpers.ts") return `${MECHANISM}/test/unit/upto-helpers.ts`;
    return undefined;
  },
  packageEntry: (specifier) =>
    ({
      "@rail402.dev/upto": "packages/upto/src/index.ts",
      "@rail402.dev/upto/client": "packages/upto/src/client/index.ts",
    })[specifier],
  stellarExport: (name) =>
    ({
      STELLAR_TESTNET_CAIP2: `${MECHANISM}/src/constants.ts`,
      getRpcClient: `${MECHANISM}/src/utils.ts`,
      RpcConfig: `${MECHANISM}/src/utils.ts`,
      ClientStellarSigner: `${MECHANISM}/src/signer.ts`,
    })[name],
};

const SOURCE = "packages/upto/src/client/scheme.ts";
const TARGET = `${MECHANISM}/src/upto/client/scheme.ts`;

describe("transformImports", () => {
  it("moves relative imports with the file and drops the .ts extension", () => {
    const result = transformImports(
      'import { a } from "../shared.ts";\nexport * from "./scheme.ts";\n',
      SOURCE,
      TARGET,
      map,
    );
    expect(result.problems).toEqual([]);
    expect(result.text).toBe('import { a } from "../shared";\nexport * from "./scheme";\n');
  });

  it("turns workspace packages into relative imports of their sources", () => {
    const result = transformImports(
      'import { a } from "@rail402.dev/upto";\nimport { B } from "@rail402.dev/upto/client";\n',
      "packages/upto/test/codec.test.ts",
      `${MECHANISM}/test/unit/upto-codec.test.ts`,
      map,
    );
    expect(result.problems).toEqual([]);
    expect(result.text).toBe(
      'import { a } from "../../src/upto";\nimport { B } from "../../src/upto/client";\n',
    );
  });

  it("splits @x402/stellar into the mechanism modules that define each name", () => {
    const result = transformImports(
      'import {\n  STELLAR_TESTNET_CAIP2,\n  getRpcClient,\n  type RpcConfig,\n} from "@x402/stellar";\n' +
        'import type { ClientStellarSigner } from "@x402/stellar";\n',
      SOURCE,
      TARGET,
      map,
    );
    expect(result.problems).toEqual([]);
    expect(result.text).toBe(
      'import { STELLAR_TESTNET_CAIP2 } from "../../constants";\n' +
        'import { getRpcClient, type RpcConfig } from "../../utils";\n' +
        'import type { ClientStellarSigner } from "../../signer";\n',
    );
  });

  it("keeps the packages both repositories share", () => {
    const text =
      'import { readFileSync } from "node:fs";\nimport { xdr } from "@stellar/stellar-sdk";\n' +
      'import type { Network } from "@x402/core/types";\nimport { describe } from "vitest";\n';
    expect(transformImports(text, SOURCE, TARGET, map)).toEqual({ text, problems: [] });
  });

  it("drops the buffer polyfill import, since upstream runs on Node's global Buffer", () => {
    const value = 'import { Buffer } from "buffer";\nimport { x } from "./x.ts";\n';
    const typeOnly = 'import type { Buffer } from "buffer";\nexport const n = 1;\n';
    expect(transformImports(value, SOURCE, TARGET, map)).toEqual({
      text: 'import { x } from "./x";\n',
      problems: [],
    });
    expect(transformImports(typeOnly, SOURCE, TARGET, map)).toEqual({
      text: "export const n = 1;\n",
      problems: [],
    });
    expect(transformImports('import { Blob } from "buffer";\n', SOURCE, TARGET, map).problems).toEqual([
      `${SOURCE}: imports buffer, which the x402 monorepo does not provide here`,
    ]);
  });

  it("remaps files read through new URL(…, import.meta.url)", () => {
    const result = transformImports(
      'const path = new URL("fixtures/vectors.json", import.meta.url);\n',
      "packages/upto/test/helpers.ts",
      `${MECHANISM}/test/unit/upto-helpers.ts`,
      map,
    );
    expect(result.problems).toEqual([]);
    expect(result.text).toBe('const path = new URL("../fixtures/vectors.json", import.meta.url);\n');
  });

  it("reports every specifier it cannot map", () => {
    const result = transformImports(
      'import { a } from "@rail402.dev/errors";\nimport { b } from "left-pad";\n' +
        'import { c } from "../../README.ts";\nimport { Nope } from "@x402/stellar";\n' +
        'import stellar from "@x402/stellar";\nconst url = new URL("../../../../README.json", import.meta.url);\n',
      SOURCE,
      TARGET,
      map,
    );
    expect(result.problems).toEqual([
      `${SOURCE}: imports @rail402.dev/errors, a package that is not exported`,
      `${SOURCE}: imports left-pad, which the x402 monorepo does not provide here`,
      `${SOURCE}: imports ../../README.ts (packages/upto/README.ts), which is not exported`,
      `${SOURCE}: no module of the x402 Stellar mechanism exports Nope`,
      `${SOURCE}: only named imports of @x402/stellar can be mapped`,
      `${SOURCE}: reads ../../../../README.json, which is not exported`,
    ]);
  });

  it("rewrites dynamic imports", () => {
    const result = transformImports('await import("../terms.ts");\n', SOURCE, TARGET, map);
    expect(result.text).toBe('await import("../terms");\n');
  });
});

describe("relativeSpecifier", () => {
  it("is relative, extension-free and resolves directories through their index", () => {
    expect(relativeSpecifier("a/b/c.ts", "a/b/d.ts")).toBe("./d");
    expect(relativeSpecifier("a/b/c.ts", "a/x/index.ts")).toBe("../x");
    expect(relativeSpecifier("a/b/c.ts", "a/b/index.ts")).toBe("./index");
    expect(relativeSpecifier("a/b/c.ts", "a/index.ts")).toBe("../index");
  });
});

describe("exportedNames", () => {
  it("lists the top-level exports of a module", () => {
    const text = [
      "export const A = 1, B = 2;",
      "export function f() {}",
      "export class C {}",
      "export interface I {}",
      "export type T = string;",
      "export enum E { X }",
      "const hidden = 1;",
      "export { hidden as shown };",
      'export { fromElsewhere } from "./other";',
    ].join("\n");
    expect(exportedNames(text)).toEqual(["A", "B", "f", "C", "I", "T", "E", "shown", "fromElsewhere"]);
  });
});
