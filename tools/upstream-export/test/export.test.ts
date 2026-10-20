import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyExport, compareExport, planExport, type Formatter } from "../src/export.ts";
import { MECHANISM } from "../src/layout.ts";

const identity: Formatter = (text) => Promise.resolve({ text, problems: [] });

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

let root: string;
let target: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "upstream-export-root-"));
  target = mkdtempSync(join(tmpdir(), "upstream-export-target-"));
  execFileSync("git", ["init", "--quiet", root]);
  write(root, {
    "packages/upto/package.json": JSON.stringify({
      name: "@rail402.dev/upto",
      exports: { ".": { "@rail402/source": "./src/index.ts" } },
    }),
    "packages/upto/README.md": "local readme\n",
    "packages/upto/src/index.ts": 'export * from "./constants.ts";\n',
    "packages/upto/src/constants.ts":
      'import { STELLAR_TESTNET_CAIP2 } from "@x402/stellar";\nexport const NETWORK = STELLAR_TESTNET_CAIP2;\n',
    "packages/upto/test/codec.test.ts": 'import { NETWORK } from "@rail402.dev/upto";\nvoid NETWORK;\n',
    "contracts/stellar/README.md": "local readme\n",
    "contracts/stellar/upto/Cargo.toml": '[package]\nname = "x402-upto-stellar"\n',
    "contracts/stellar/upto/target/debug/ignored": "build output\n",
    "contracts/stellar/deployments/testnet.json": "{}\n",
    ".gitignore": "target/\n",
  });
  write(target, {
    [`${MECHANISM}/src/constants.ts`]: 'export const STELLAR_TESTNET_CAIP2 = "stellar:testnet";\n',
    ...Object.fromEntries(
      ["types", "signer", "utils", "shared", "defaultAssets"].map((name) => [
        `${MECHANISM}/src/${name}.ts`,
        "export {};\n",
      ]),
    ),
    [`${MECHANISM}/package.json`]: JSON.stringify({ exports: { ".": {} } }),
    [`${MECHANISM}/tsup.config.ts`]: "export default {};\n",
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });
});

describe("planExport", () => {
  it("maps the mechanism and the contract, and leaves local files and build output alone", async () => {
    const plan = await planExport(root, target, identity);
    expect(plan.problems).toEqual([]);
    const files = Object.fromEntries(plan.files.map((file) => [file.target, file.content.toString()]));
    expect(Object.keys(files).sort()).toEqual([
      "contracts/stellar/deployments/testnet.json",
      "contracts/stellar/upto/Cargo.toml",
      `${MECHANISM}/src/upto/constants.ts`,
      `${MECHANISM}/src/upto/index.ts`,
      `${MECHANISM}/test/unit/upto-codec.test.ts`,
    ]);
    expect(files[`${MECHANISM}/src/upto/constants.ts`]).toBe(
      'import { STELLAR_TESTNET_CAIP2 } from "../constants";\nexport const NETWORK = STELLAR_TESTNET_CAIP2;\n',
    );
    expect(files[`${MECHANISM}/test/unit/upto-codec.test.ts`]).toBe(
      'import { NETWORK } from "../../src/upto";\nvoid NETWORK;\n',
    );
  });

  it("refuses unmapped files and text that only means something here", async () => {
    write(root, {
      "packages/upto/src/notes.md": "notes\n",
      "packages/upto/src/local.ts": "// see rail402 for details\nexport {};\n",
    });
    const plan = await planExport(root, target, identity);
    expect(plan.problems).toEqual([
      "packages/upto/src/notes.md: not mapped to the x402 checkout; add it to the layout or to LOCAL_ONLY",
      "packages/upto/src/local.ts: mentions rail402, which means nothing in the x402 checkout",
    ]);
  });

  it("lets a deployment record name the contract's release repository, and nothing else from here", async () => {
    write(root, {
      "contracts/stellar/deployments/testnet.json":
        '{ "repository": "https://github.com/tolgayayci/rail402" }\n',
    });
    expect((await planExport(root, target, identity)).problems).toEqual([]);

    write(root, {
      "contracts/stellar/deployments/testnet.json":
        '{ "repository": "https://github.com/tolgayayci/rail402", "note": "see rail402.dev" }\n',
    });
    expect((await planExport(root, target, identity)).problems).toEqual([
      "contracts/stellar/deployments/testnet.json: mentions rail402, which means nothing in the x402 checkout",
    ]);
  });

  it("reports what the formatter finds", async () => {
    const plan = await planExport(root, target, (text, path) =>
      Promise.resolve({
        text,
        problems: path.endsWith("index.ts") ? ["1:1 missing jsdoc (jsdoc/require-jsdoc)"] : [],
      }),
    );
    expect(plan.problems).toEqual([`${MECHANISM}/src/upto/index.ts:1:1 missing jsdoc (jsdoc/require-jsdoc)`]);
  });
});

describe("compareExport and applyExport", () => {
  it("reports missing, changed and extra files and the mechanism wiring, and applies the export", async () => {
    const plan = await planExport(root, target, identity);
    const before = compareExport(plan, target);
    expect(before.files.map((file) => file.status)).toEqual(Array(5).fill("missing"));
    expect(before.wiring).toHaveLength(6);

    applyExport(plan, before, target);
    expect(compareExport(plan, target).files.every((file) => file.status === "unchanged")).toBe(true);
    expect(readFileSync(join(target, "contracts/stellar/upto/Cargo.toml"), "utf8")).toContain(
      "x402-upto-stellar",
    );

    write(target, {
      [`${MECHANISM}/src/upto/constants.ts`]: "export {};\n",
      [`${MECHANISM}/src/upto/stale.ts`]: "export {};\n",
      "contracts/stellar/upto/target/release/ignored.wasm": "",
      "contracts/stellar/README.md": "the checkout's own readme\n",
    });
    const drift = compareExport(plan, target);
    expect(drift.files.filter((file) => file.status !== "unchanged")).toEqual([
      {
        status: "changed",
        target: `${MECHANISM}/src/upto/constants.ts`,
        source: "packages/upto/src/constants.ts",
      },
      { status: "extra", target: `${MECHANISM}/src/upto/stale.ts` },
    ]);

    applyExport(plan, drift, target);
    expect(compareExport(plan, target).files.every((file) => file.status === "unchanged")).toBe(true);
    expect(readFileSync(join(target, "contracts/stellar/README.md"), "utf8")).toBe(
      "the checkout's own readme\n",
    );
  });

  it("accepts the wiring once the entry points are exported and built", async () => {
    write(target, {
      [`${MECHANISM}/package.json`]: JSON.stringify({
        exports: { "./upto/client": {}, "./upto/server": {}, "./upto/facilitator": {} },
      }),
      [`${MECHANISM}/tsup.config.ts`]: [
        '"upto/client/index": "src/upto/client/index.ts",',
        '"upto/server/index": "src/upto/server/index.ts",',
        '"upto/facilitator/index": "src/upto/facilitator/index.ts",',
      ].join("\n"),
    });
    const plan = await planExport(root, target, identity);
    expect(compareExport(plan, target).wiring).toEqual([]);
  });
});
