import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/evidence.ts";

const read = (path: string) => readFileSync(join(REPO_ROOT, path), "utf8");
const WORKFLOWS = ".github/workflows";
const release = read(`${WORKFLOWS}/release.yml`);
const ci = read(`${WORKFLOWS}/ci.yml`);

/** The YAML block of one job: from `  <name>:` to the next job at the same indentation. */
function job(workflow: string, name: string): string {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start === -1) throw new Error(`no job ${name}`);
  const end = lines.findIndex((line, index) => index > start && /^ {2}[a-z][\w-]*:$/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

describe("the release workflow", () => {
  it("release runs only after CI passes and attests provenance", () => {
    const verify = job(release, "verify");
    expect(verify).toContain("run: pnpm verify");
    expect(verify).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/main');
    expect(verify).toContain('node tools/conformance/src/findings.ts --release "$GITHUB_REF_NAME"');
    const image = job(release, "image");
    expect(image).toContain("needs: verify");
    expect(image).toContain("actions/attest-build-provenance@");
    expect(image).toContain("push-to-registry: true");
    expect(image).toContain("sbom: true");
    expect(image).toContain("provenance: mode=max");
    expect(image).toContain("attestations: write");
    expect(image).toContain("id-token: write");
  });

  it("grants write permissions only to the job that publishes", () => {
    expect(release).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(job(release, "verify")).not.toContain("write");
  });
});

/**
 * References that cannot be pinned, each with the reason. stellar.expert verifies a contract build
 * only when it comes from its own reusable workflow on main; a commit pin changes the builder identity
 * its attestation check expects.
 */
const UNPINNED: Readonly<Record<string, string>> = {
  "stellar-expert/soroban-build-workflow/.github/workflows/release.yml@main":
    "source verification accepts only this workflow at refs/heads/main",
};

/**
 * Dockerfiles exempt from digest pins, each with the reason: standalone images that install published
 * packages from the npm registry and are never deployed from this repository.
 */
const UNPINNED_DOCKERFILES: Readonly<Record<string, string>> = {
  "examples/seller-http/Dockerfile": "an example a reader copies; it builds from the npm registry",
  "tools/docs-check/Dockerfile": "the clean-environment docs check; a fresh image is the point",
};

/** The images the release workflow publishes, each with its own attestation, and CI builds. */
const RELEASE_IMAGES = [
  { name: "facilitator", dockerfile: "Dockerfile" },
  { name: "explorer", dockerfile: "apps/explorer/Dockerfile" },
  { name: "mcp", dockerfile: "packages/mcp/Dockerfile" },
] as const;

/** Every Dockerfile git tracks. */
function dockerfilesInRepo(): string[] {
  return execFileSync("git", ["ls-files", "--", "Dockerfile", "**/Dockerfile"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter((path) => path !== "")
    .sort();
}

describe("supply-chain checks", () => {
  it("binds a contract release to the reviewed revision of stellar.expert's workflow and the tag's commit", () => {
    const workflow = read(`${WORKFLOWS}/contract-release.yml`);
    const reviewed = /^ {2}REVIEWED: ([0-9a-f]{40})$/m.exec(workflow)?.[1];
    expect(reviewed).toBeDefined();
    const common = read("scripts/contracts/common.sh");
    expect(common).toContain(`RELEASE_WORKFLOW_REVIEWED="${String(reviewed)}"`);
    // A person approves the release before the third-party workflow gets this repository's token.
    expect(job(workflow, "check")).toMatch(/^ {4}environment: contract-release$/m);
    // The check reads a mutable name; the attestation proves which revision ran and what it built.
    expect(job(workflow, "confirm")).toContain('--signer-digest "$REVIEWED" --source-digest "$GITHUB_SHA"');
    const deploy = read("scripts/contracts/deploy.sh");
    expect(deploy).toContain('--signer-digest "$RELEASE_WORKFLOW_REVIEWED"');
  });

  it("builds every deployable image in CI and publishes each with its own attestation", () => {
    const build = job(ci, "image");
    for (const dockerfile of [
      "Dockerfile",
      "apps/playground/Dockerfile",
      "apps/explorer/Dockerfile",
      "packages/mcp/Dockerfile",
    ]) {
      if (dockerfile === "Dockerfile") expect(build).toMatch(/docker build [^\n]*-t rail402:ci \./);
      else expect(build, dockerfile).toContain(`-f ${dockerfile}`);
    }
    const image = job(release, "image");
    for (const { name, dockerfile } of RELEASE_IMAGES) {
      expect(image, name).toContain(`- name: ${name}`);
      expect(image, name).toContain(`dockerfile: ${dockerfile}`);
    }
    expect(image).toContain("file: ${{ matrix.image.dockerfile }}");
    expect(image).toContain("subject-digest: ${{ steps.build.outputs.digest }}");
  });

  it("runs dependency scanners and pins base images by digest", () => {
    const scan = job(ci, "dependency-scan");
    expect(scan).toContain("google/osv-scanner-action/osv-scanner-action@");
    expect(scan).toContain("--lockfile=pnpm-lock.yaml");
    for (const lock of readdirSync(join(REPO_ROOT, "contracts"), { recursive: true, encoding: "utf8" })
      .filter((path) => path.endsWith("Cargo.lock") && !path.includes("target"))
      .map((path) => `contracts/${path}`)) {
      expect(scan, lock).toContain(`--lockfile=${lock}`);
    }
    expect(job(ci, "cargo-audit")).toMatch(/cargo install cargo-audit --version \d+\.\d+\.\d+ --locked/);
    const dockerfiles = dockerfilesInRepo();
    expect(dockerfiles).toEqual(expect.arrayContaining(RELEASE_IMAGES.map((image) => image.dockerfile)));
    for (const dockerfile of dockerfiles.filter((path) => !(path in UNPINNED_DOCKERFILES))) {
      const text = read(dockerfile);
      expect(text, dockerfile).toMatch(/^# syntax=[^\s]+@sha256:[0-9a-f]{64}$/m);
      const images = [...text.matchAll(/^ARG [A-Z_]*IMAGE=(\S+)$/gm)].map((match) => match[1] ?? "");
      expect(images.length, dockerfile).toBeGreaterThan(0);
      for (const image of images) expect(image, dockerfile).toMatch(/@sha256:[0-9a-f]{64}$/);
      for (const from of text.matchAll(/^FROM (\S+)/gm))
        expect(from[1], dockerfile).toMatch(/^\$\{[A-Z_]+\}$|@sha256:/);
    }
  });

  it("pins every action by commit and gives every ignored advisory a reason and an expiry", () => {
    for (const file of readdirSync(join(REPO_ROOT, WORKFLOWS))) {
      for (const use of read(`${WORKFLOWS}/${file}`).matchAll(/uses: (\S+)/g)) {
        const ref = use[1] ?? "";
        if (ref.startsWith("./") || ref in UNPINNED) continue;
        expect(ref, `${file}: ${ref}`).toMatch(/@[0-9a-f]{40}$/);
      }
    }
    const config = read("osv-scanner.toml");
    const entries = config.split("[[IgnoredVulns]]").slice(1);
    for (const entry of entries) {
      expect(entry).toMatch(/ignoreUntil = \d{4}-\d{2}-\d{2}/);
      expect(entry).toMatch(/reason = ".{20,}"/);
    }
  });
});
