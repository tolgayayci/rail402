import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
import { DEFAULT_SKILL_DIR, loadSkillFiles } from "./skill.js";

/**
 * The Agent Skill is a content deliverable served over HTTP. These tests hold it to the same
 * rules as code: the front-matter must parse, every referenced file must exist, the starter
 * scripts must at least be valid JavaScript, and the serve surface must not read the filesystem
 * per-request (traversal-shaped requests 404 out of the snapshot map).
 */

function makeApp() {
  const config = loadConfig({
    PLAYGROUND_DISPENSER_SECRET: Keypair.random().secret(),
  } as NodeJS.ProcessEnv);
  return createApp({ config });
}

describe("skill files on disk", () => {
  const files = loadSkillFiles(DEFAULT_SKILL_DIR);

  it("ship the full set", () => {
    for (const expected of [
      "SKILL.md",
      "references/seller.md",
      "references/buyer.md",
      "scripts/make-wallet.mjs",
      "scripts/seller-starter.mjs",
      "scripts/buyer-starter.mjs",
    ]) {
      expect(files.has(expected), `${expected} must exist`).toBe(true);
    }
  });

  it("SKILL.md carries valid Agent Skill front-matter and only real references", () => {
    const skill = files.get("SKILL.md")!.content;
    expect(skill.startsWith("---\n")).toBe(true);
    const frontMatter = skill.slice(4, skill.indexOf("\n---", 4));
    expect(frontMatter).toContain("name: x402-stellar");
    expect(frontMatter).toContain("description:");
    // Every relative markdown link must point at a file this same map serves.
    for (const [, target] of skill.matchAll(/\]\(((?:references|scripts)\/[^)]+)\)/g)) {
      expect(files.has(target!), `SKILL.md references missing file ${target}`).toBe(true);
    }
  });

  it("starter scripts are valid JavaScript (node --check)", () => {
    for (const script of ["make-wallet.mjs", "seller-starter.mjs", "buyer-starter.mjs"]) {
      expect(
        () => execFileSync(process.execPath, ["--check", join(DEFAULT_SKILL_DIR, "scripts", script)]),
        `${script} must parse`,
      ).not.toThrow();
    }
  });

  it("references teach the two non-negotiable safety rules", () => {
    // The budget must be enforced in the selector (the F20 lesson), and the seller must not
    // double-wrap the discovery extension. If these sentences vanish, fail.
    expect(files.get("references/buyer.md")!.content).toContain("selector");
    expect(files.get("references/buyer.md")!.content).toContain("unpaid quote");
    expect(files.get("references/seller.md")!.content).toContain("already returns");
  });
});

describe("wire: /skill", () => {
  it("serves SKILL.md as markdown and reference files by path", async () => {
    const { app } = makeApp();
    const res = await app.request("/skill");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(await res.text()).toContain("name: x402-stellar");

    const ref = await app.request("/skill/references/seller.md");
    expect(ref.status).toBe(200);
    const script = await app.request("/skill/scripts/buyer-starter.mjs");
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("javascript");
  });

  it("refuses anything outside the snapshot with a coded 404 — no traversal surface", async () => {
    const { app } = makeApp();
    for (const path of [
      "/skill/references/%2e%2e%2f%2e%2e%2fpackage.json",
      "/skill/references/nope.md",
      "/skill/scripts/..%2f..%2fsrc%2fserver%2fapp.ts",
    ]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(404);
      const body = (await res.json()) as { code: string; reason: string };
      expect(body.code).toBe("playground_invalid_request");
      expect(body.reason.length).toBeGreaterThan(0);
    }
  });

  it("announces the skill in /session/config", async () => {
    const { app } = makeApp();
    const config = (await (await app.request("/session/config")).json()) as {
      demo: { skill: { path: string } };
    };
    expect(config.demo.skill.path).toBe("/skill");
  });
});
