import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RELEASE_SIGNERS,
  ciStatusOf,
  deployProblems,
  gatherFacts,
  kitDigest,
  splitSshTagSignature,
  verifySshTagSignature,
  type DeployFacts,
  type Runner,
} from "../../../deploy/check-deployable.ts";

const DIGEST = `ghcr.io/owner/rail402@sha256:${"a".repeat(64)}`;
const good: DeployFacts = {
  head: "f".repeat(40),
  tag: "v1.2.3",
  tagAnnotated: true,
  tagSignatureValid: true,
  tagOnOrigin: true,
  onOriginMain: true,
  cleanTree: true,
  ci: "success",
  images: { facilitator: DIGEST },
  attestations: { facilitator: true },
};

describe("the deploy gate", () => {
  it("allows a signed release tag on origin/main with green CI and digest-pinned images", () => {
    expect(deployProblems(good)).toEqual([]);
  });

  it("refuses an unsigned tag", () => {
    expect(deployProblems({ ...good, tagSignatureValid: false })).toEqual([
      "tag v1.2.3 has no valid signature from a key in deploy/release-signers",
    ]);
    expect(deployProblems({ ...good, tagAnnotated: false })).toEqual(["tag v1.2.3 is not an annotated tag"]);
  });

  it("refuses a commit that is not a release tag", () => {
    expect(deployProblems({ ...good, tag: undefined })).toEqual([
      `HEAD ${"f".repeat(12)} is not a release tag`,
    ]);
    expect(deployProblems({ ...good, tag: "upto-contract-v1.0.0" })).toEqual([
      "tag upto-contract-v1.0.0 is not a vX.Y.Z release tag",
    ]);
  });

  it("refuses a commit not on origin/main", () => {
    expect(deployProblems({ ...good, onOriginMain: false })).toEqual(["HEAD is not on origin/main"]);
  });

  it("refuses a tag that is not on origin, or that origin has as another object", () => {
    expect(deployProblems({ ...good, tagOnOrigin: false })).toEqual([
      "tag v1.2.3 is not on origin, or origin's tag differs",
    ]);
  });

  it("refuses a commit whose CI is not green", () => {
    for (const ci of ["failure", "pending", "missing", "unknown"] as const) {
      expect(deployProblems({ ...good, ci })).toEqual([`CI for HEAD is ${ci}, not success`]);
    }
  });

  it("refuses uncommitted changes, images named by tag and unverified attestations", () => {
    expect(
      deployProblems({
        ...good,
        cleanTree: false,
        images: { facilitator: "ghcr.io/owner/rail402:1.2.3", playground: DIGEST },
        attestations: { facilitator: true, playground: false },
      }),
    ).toEqual([
      "the working tree has uncommitted changes",
      "image facilitator is not pinned by digest: ghcr.io/owner/rail402:1.2.3",
      "image playground has no verified build attestation from the release workflow for this tag",
    ]);
    expect(deployProblems({ ...good, images: {} })).toEqual([
      "no image is named; pass --image name=ref@sha256:…",
    ]);
  });

  it("counts CI green only when every check run finished green", () => {
    expect(ciStatusOf([])).toBe("missing");
    expect(
      ciStatusOf([
        { status: "completed", conclusion: "success" },
        { status: "in_progress", conclusion: null },
      ]),
    ).toBe("pending");
    expect(
      ciStatusOf([
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "skipped" },
      ]),
    ).toBe("success");
    expect(ciStatusOf([{ status: "completed", conclusion: "failure" }])).toBe("failure");
  });

  it("gathers its facts from git and the GitHub API", () => {
    const calls: string[] = [];
    const answers: Record<string, string | undefined> = {
      "git rev-parse HEAD": good.head,
      "git describe --exact-match --tags --match v* HEAD": "v1.2.3",
      "git cat-file -t refs/tags/v1.2.3": "tag",
      "git cat-file tag refs/tags/v1.2.3": "object f\ntype commit\ntag v1.2.3\n\nv1.2.3\n<signature>",
      "git rev-parse refs/tags/v1.2.3": "c".repeat(40),
      "git ls-remote origin refs/tags/v1.2.3": `${"c".repeat(40)}\trefs/tags/v1.2.3`,
      "git merge-base --is-ancestor HEAD origin/main": "",
      "git status --porcelain": "",
      [`gh api repos/owner/rail402/commits/${good.head}/check-runs?per_page=100 --jq [.check_runs[] | {status, conclusion}]`]:
        '[{"status":"completed","conclusion":"success"}]',
      [`gh attestation verify oci://${DIGEST} --repo owner/rail402 --signer-workflow owner/rail402/.github/workflows/release.yml --source-ref refs/tags/v1.2.3 --source-digest ${good.head} --signer-digest ${good.head}`]:
        undefined,
    };
    const runner: Runner = (command, args) => {
      const line = [command, ...args].join(" ");
      calls.push(line);
      return answers[line];
    };
    const verified: string[] = [];
    const verifySignature = (tagObject: string, signers: string) => {
      verified.push(signers);
      return tagObject.endsWith("<signature>");
    };
    const facts = gatherFacts(
      { repo: "owner/rail402", images: { facilitator: DIGEST }, fetch: true, verifySignature },
      runner,
    );
    expect(verified).toEqual([RELEASE_SIGNERS]);
    expect(calls[0]).toBe("git fetch --quiet origin main --tags");
    expect(facts).toMatchObject({
      tag: "v1.2.3",
      tagSignatureValid: true,
      tagOnOrigin: true,
      onOriginMain: true,
      ci: "success",
    });
    expect(deployProblems(facts)).toEqual([
      "image facilitator has no verified build attestation from the release workflow for this tag",
    ]);
    // The image counts only when its build names the signed commit, as the source and as the workflow
    // that ran; an image another commit built for the same tag name is refused.
    const otherCommit = "e".repeat(40);
    const attested =
      (commit: string): Runner =>
      (command, args) => {
        const line = [command, ...args].join(" ");
        if (line.startsWith("gh attestation verify")) {
          return line.endsWith(`--source-digest ${commit} --signer-digest ${commit}`) ? "ok" : undefined;
        }
        return answers[line];
      };
    expect(
      gatherFacts(
        { repo: "owner/rail402", images: { facilitator: DIGEST }, fetch: false, verifySignature },
        attested(good.head),
      ).attestations,
    ).toEqual({ facilitator: true });
    expect(
      gatherFacts(
        { repo: "owner/rail402", images: { facilitator: DIGEST }, fetch: false, verifySignature },
        attested(otherCommit),
      ).attestations,
    ).toEqual({ facilitator: false });
    // A tag object that origin does not have is refused, whatever the local signature says.
    answers["git ls-remote origin refs/tags/v1.2.3"] = `${"d".repeat(40)}\trefs/tags/v1.2.3`;
    expect(
      gatherFacts({ repo: "owner/rail402", images: {}, fetch: false, verifySignature }, runner).tagOnOrigin,
    ).toBe(false);
    answers["git ls-remote origin refs/tags/v1.2.3"] = "";
    expect(
      gatherFacts({ repo: "owner/rail402", images: {}, fetch: false, verifySignature }, runner).tagOnOrigin,
    ).toBe(false);
  });

  it("checks tag signatures against the committed release signers only", () => {
    // Every line of the signers file is a git principal with an SSH key, limited to git signatures.
    const lines = readFileSync(RELEASE_SIGNERS, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "" && !line.startsWith("#"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(/^\S+@\S+ namespaces="git" ssh-ed25519 [A-Za-z0-9+/=]+$/);
    // A tag signed by a key that is not in the file fails verification, even if the signer trusts it.
    const repo = mkdtempSync(join(tmpdir(), "rail402-gate-"));
    try {
      const git = (...args: string[]) =>
        execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      execFileSync("ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-C",
        "t@example.com",
        "-f",
        join(repo, "k"),
      ]);
      git("init", "-q");
      git("commit", "-q", "--allow-empty", "--no-gpg-sign", "-m", "x");
      git(
        "-c",
        "gpg.format=ssh",
        "-c",
        `user.signingkey=${join(repo, "k")}`,
        "tag",
        "-s",
        "v1.0.0",
        "-m",
        "v1.0.0",
      );
      const tagObject = git("cat-file", "tag", "v1.0.0");
      const verify = (signers: string) => verifySshTagSignature(tagObject, signers);
      expect(verify(RELEASE_SIGNERS)).toBe(false);
      const own = join(repo, "signers");
      writeFileSync(own, `t@example.com namespaces="git" ${readFileSync(join(repo, "k.pub"), "utf8")}`);
      expect(verify(own)).toBe(true);
      // The signature covers the tag: a changed message no longer verifies.
      expect(verifySshTagSignature(tagObject.replace("v1.0.0\n-----BEGIN", "v1.0.1\n-----BEGIN"), own)).toBe(
        false,
      );
      // A signer listed for another namespace than git is refused.
      const otherNamespace = join(repo, "signers-file");
      writeFileSync(
        otherNamespace,
        `t@example.com namespaces="file" ${readFileSync(join(repo, "k.pub"), "utf8")}`,
      );
      expect(verify(otherNamespace)).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses an OpenPGP-signed tag even when the operator's keyring trusts its key", () => {
    const home = mkdtempSync(join(tmpdir(), "rail402-gate-pgp-"));
    try {
      const env = { ...process.env, GNUPGHOME: join(home, "gnupg") };
      mkdirSync(env.GNUPGHOME, { mode: 0o700 });
      const run = (command: string, args: string[]) =>
        execFileSync(command, args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      run("gpg", [
        "--batch",
        "--passphrase",
        "",
        "--quick-gen-key",
        "t@example.com",
        "ed25519",
        "sign",
        "never",
      ]);
      const repo = join(home, "repo");
      const git = (...args: string[]) =>
        run("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args]);
      mkdirSync(repo);
      git("init", "-q");
      git("commit", "-q", "--allow-empty", "--no-gpg-sign", "-m", "x");
      git(
        "-c",
        "gpg.format=openpgp",
        "-c",
        "user.signingkey=t@example.com",
        "tag",
        "-s",
        "v1.0.0",
        "-m",
        "v1.0.0",
      );
      // git itself accepts it with the gate's old settings: it hands an OpenPGP block to gpg.
      expect(
        git(
          "-c",
          "gpg.format=ssh",
          "-c",
          `gpg.ssh.allowedSignersFile=${RELEASE_SIGNERS}`,
          "verify-tag",
          "v1.0.0",
        ),
      ).toBeDefined();
      const tagObject = git("cat-file", "tag", "v1.0.0");
      expect(tagObject).toContain("-----BEGIN PGP SIGNATURE-----");
      expect(splitSshTagSignature(tagObject)).toBeUndefined();
      expect(verifySshTagSignature(tagObject, RELEASE_SIGNERS)).toBe(false);
      // A tag carrying both an OpenPGP and an SSH block is refused too.
      const mixed = `${tagObject}-----BEGIN SSH SIGNATURE-----\nAAAA\n-----END SSH SIGNATURE-----\n`;
      expect(splitSshTagSignature(mixed)).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses a deploy that leaves out a required image", () => {
    expect(deployProblems(good, ["facilitator"])).toEqual([]);
    expect(deployProblems(good, ["facilitator", "explorer", "mcp"])).toEqual([
      "image explorer is required but not named; pass --image explorer=…",
      "image mcp is required but not named; pass --image mcp=…",
    ]);
  });

  it("digests a deploy kit the same way a shell on the host does", () => {
    const kit = mkdtempSync(join(tmpdir(), "rail402-kit-"));
    try {
      mkdirSync(join(kit, "config"));
      mkdirSync(join(kit, "secrets"));
      writeFileSync(join(kit, "activate.sh"), "#!/bin/sh\n");
      writeFileSync(join(kit, "config", "facilitator.env"), "NETWORKS=stellar:testnet\n");
      writeFileSync(join(kit, "config", "Z.env"), "z\n");
      writeFileSync(join(kit, "secrets", "facilitator.env.example"), "X=<value>\n");
      writeFileSync(join(kit, "secrets", "facilitator.env"), "never shipped\n");
      const digest = kitDigest(kit);
      expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      const shell = execFileSync(
        "bash",
        [
          "-c",
          `cd "$1" && find . -type f ! -path './secrets/*.env' -printf '%P\\n' | LC_ALL=C sort | while IFS= read -r f; do sha256sum "$f"; done | sha256sum | cut -d' ' -f1`,
          "kit-digest",
          kit,
        ],
        { encoding: "utf8" },
      ).trim();
      expect(digest).toBe(`sha256:${shell}`);
      // Secret env files never count; any shipped file does.
      writeFileSync(join(kit, "secrets", "facilitator.env"), "changed\n");
      expect(kitDigest(kit)).toBe(digest);
      writeFileSync(join(kit, "config", "facilitator.env"), "NETWORKS=stellar:testnet,stellar:pubnet\n");
      expect(kitDigest(kit)).not.toBe(digest);
    } finally {
      rmSync(kit, { recursive: true, force: true });
    }
  });
});
