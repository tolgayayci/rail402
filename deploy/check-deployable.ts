/**
 * The release gate a production deploy runs before it changes anything: it refuses unless the checkout
 * is exactly a release tag signed by a key in `deploy/release-signers`, the same tag object is on
 * origin, the commit is on origin/main, the working tree is clean, CI passed for that commit, and every
 * image is named by its digest and carries a build attestation from the release workflow for that tag.
 *
 *   node deploy/check-deployable.ts --repo owner/name --image facilitator=ghcr.io/owner/name@sha256:… \
 *     [--image explorer=…] [--image mcp=…] [--require facilitator --require explorer …] [--kit DIR] [--fetch]
 *
 * Exit 0 when deployable; exit 1 with one line per problem otherwise. It reads git and the GitHub API
 * (through `gh`), and writes nothing. With `--kit DIR` it also prints the digest of a deploy kit kept
 * outside git (`kitDigest`): the gate does not review that kit, it names exactly which one shipped.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** The release signers, in ssh-keygen's allowed_signers format. */
export const RELEASE_SIGNERS = fileURLToPath(new URL("release-signers", import.meta.url));
/** The workflow whose attestations a deployable image must carry. */
export const RELEASE_WORKFLOW = ".github/workflows/release.yml";

export type CiStatus = "success" | "failure" | "pending" | "missing" | "unknown";

/** What the gate decides on, gathered by `gatherFacts` or given by a test. */
export interface DeployFacts {
  readonly head: string;
  /** The release tag that points at HEAD, if any. */
  readonly tag: string | undefined;
  readonly tagAnnotated: boolean;
  /** ssh-keygen accepted the tag object's SSH signature against `deploy/release-signers` alone. */
  readonly tagSignatureValid: boolean;
  /** origin has the tag, pointing at the same tag object as the local one. */
  readonly tagOnOrigin: boolean;
  readonly onOriginMain: boolean;
  readonly cleanTree: boolean;
  readonly ci: CiStatus;
  /** name → image reference */
  readonly images: Readonly<Record<string, string>>;
  /** name → whether `gh attestation verify` accepted it for the release workflow and the tag. */
  readonly attestations: Readonly<Record<string, boolean>>;
}

const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;
const DIGEST_REF = /^[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}$/;

/**
 * Every reason the checkout may not be deployed; empty when it may. `required` names images that must
 * be given (a deployment that runs the Explorer and the hosted MCP endpoint requires all three).
 */
export function deployProblems(facts: DeployFacts, required: readonly string[] = []): string[] {
  const problems: string[] = [];
  if (facts.tag === undefined) problems.push(`HEAD ${facts.head.slice(0, 12)} is not a release tag`);
  else {
    if (!RELEASE_TAG.test(facts.tag)) problems.push(`tag ${facts.tag} is not a vX.Y.Z release tag`);
    if (!facts.tagAnnotated) problems.push(`tag ${facts.tag} is not an annotated tag`);
    if (!facts.tagSignatureValid)
      problems.push(`tag ${facts.tag} has no valid signature from a key in deploy/release-signers`);
    if (!facts.tagOnOrigin) problems.push(`tag ${facts.tag} is not on origin, or origin's tag differs`);
  }
  if (!facts.onOriginMain) problems.push("HEAD is not on origin/main");
  if (!facts.cleanTree) problems.push("the working tree has uncommitted changes");
  if (facts.ci !== "success") problems.push(`CI for HEAD is ${facts.ci}, not success`);
  const names = Object.keys(facts.images);
  if (names.length === 0) problems.push("no image is named; pass --image name=ref@sha256:…");
  for (const name of required) {
    if (!names.includes(name))
      problems.push(`image ${name} is required but not named; pass --image ${name}=…`);
  }
  for (const name of names) {
    const ref = facts.images[name] ?? "";
    if (!DIGEST_REF.test(ref)) problems.push(`image ${name} is not pinned by digest: ${ref}`);
    if (facts.attestations[name] !== true) {
      problems.push(`image ${name} has no verified build attestation from the release workflow for this tag`);
    }
  }
  return problems;
}

/** Runs a command and returns its trimmed stdout, or undefined when it exits non-zero. */
export type Runner = (command: string, args: readonly string[]) => string | undefined;

export const run: Runner = (command, args) => {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return undefined;
  }
};

interface CheckRun {
  readonly status: string;
  readonly conclusion: string | null;
}

/** The combined state of a commit's check runs: success only when every run finished green. */
export function ciStatusOf(runs: readonly CheckRun[]): CiStatus {
  if (runs.length === 0) return "missing";
  if (runs.some((entry) => entry.status !== "completed")) return "pending";
  const green = new Set(["success", "skipped", "neutral"]);
  return runs.every((entry) => green.has(entry.conclusion ?? "")) ? "success" : "failure";
}

export interface GatherOptions {
  readonly repo: string;
  readonly images: Readonly<Record<string, string>>;
  readonly fetch?: boolean;
  /** The allowed_signers file; `deploy/release-signers` unless a test gives another. */
  readonly signers?: string;
  /** Checks a tag object's signature against the signers file; `verifySshTagSignature` by default. */
  readonly verifySignature?: (tagObject: string, signers: string) => boolean;
}

const SSH_SIGNATURE_BEGIN = "-----BEGIN SSH SIGNATURE-----";
const SSH_SIGNATURE_END = "-----END SSH SIGNATURE-----";

/**
 * Splits a tag object (`git cat-file tag`) into the signed payload and its SSH signature. Undefined
 * unless the object ends with exactly one SSH signature block and carries no other signature format
 * (OpenPGP, X.509), so a tag git would hand to gpg is never accepted.
 */
export function splitSshTagSignature(
  tagObject: string,
): { readonly payload: string; readonly signature: string } | undefined {
  const text = tagObject.endsWith("\n") ? tagObject : `${tagObject}\n`;
  if (/-----BEGIN (PGP|SIGNED MESSAGE)|-----BEGIN CERTIFICATE/.test(text)) return undefined;
  const start = text.indexOf(SSH_SIGNATURE_BEGIN);
  if (start <= 0 || text.indexOf(SSH_SIGNATURE_BEGIN, start + 1) !== -1) return undefined;
  const signature = text.slice(start);
  if (!signature.trimEnd().endsWith(SSH_SIGNATURE_END)) return undefined;
  return { payload: text.slice(0, start), signature };
}

/**
 * Verifies a tag object's SSH signature with `ssh-keygen -Y verify` against the allowed_signers file
 * only, in the `git` namespace, for a principal that file names for the signing key.
 */
export function verifySshTagSignature(tagObject: string, signers: string): boolean {
  const parts = splitSshTagSignature(tagObject);
  if (parts === undefined) return false;
  const dir = mkdtempSync(join(tmpdir(), "rail402-tag-"));
  try {
    const signatureFile = join(dir, "tag.sig");
    writeFileSync(signatureFile, parts.signature, { mode: 0o600 });
    const sshKeygen = (args: readonly string[], input?: string) =>
      execFileSync("ssh-keygen", args, {
        encoding: "utf8",
        input,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    let principals: string[];
    try {
      principals = sshKeygen(["-Y", "find-principals", "-f", signers, "-s", signatureFile])
        .split("\n")
        .filter((line) => line !== "");
    } catch {
      return false;
    }
    return principals.some((principal) => {
      try {
        sshKeygen(
          ["-Y", "verify", "-f", signers, "-I", principal, "-n", "git", "-s", signatureFile],
          parts.payload,
        );
        return true;
      } catch {
        return false;
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function gatherFacts(options: GatherOptions, runner: Runner = run): DeployFacts {
  if (options.fetch === true) runner("git", ["fetch", "--quiet", "origin", "main", "--tags"]);
  const head = runner("git", ["rev-parse", "HEAD"]) ?? "unknown";
  const tag = runner("git", ["describe", "--exact-match", "--tags", "--match", "v*", "HEAD"]);
  const tagAnnotated = tag !== undefined && runner("git", ["cat-file", "-t", `refs/tags/${tag}`]) === "tag";
  // Only the committed release signers count, whatever the operator's own git trust settings say:
  // the tag object's SSH signature is checked with ssh-keygen against that file alone. git itself is
  // not asked, because it picks the verifier from the signature block, and an OpenPGP block would be
  // checked against the operator's keyring instead.
  const tagObject = tag === undefined ? undefined : runner("git", ["cat-file", "tag", `refs/tags/${tag}`]);
  const tagSignatureValid =
    tagObject !== undefined &&
    (options.verifySignature ?? verifySshTagSignature)(tagObject, options.signers ?? RELEASE_SIGNERS);
  // A tag that exists only in this checkout, or that origin has as another object, is not a release.
  const localTag = tag === undefined ? undefined : runner("git", ["rev-parse", `refs/tags/${tag}`]);
  const remoteTag =
    tag === undefined
      ? undefined
      : runner("git", ["ls-remote", "origin", `refs/tags/${tag}`])?.split(/\s+/)[0];
  const tagOnOrigin = localTag !== undefined && localTag !== "" && remoteTag === localTag;
  const onOriginMain = runner("git", ["merge-base", "--is-ancestor", "HEAD", "origin/main"]) !== undefined;
  const cleanTree = runner("git", ["status", "--porcelain"]) === "";
  const checks = runner("gh", [
    "api",
    `repos/${options.repo}/commits/${head}/check-runs?per_page=100`,
    "--jq",
    "[.check_runs[] | {status, conclusion}]",
  ]);
  let ci: CiStatus = "unknown";
  if (checks !== undefined) {
    try {
      ci = ciStatusOf(JSON.parse(checks) as CheckRun[]);
    } catch {
      ci = "unknown";
    }
  }
  // The attestation must come from the release workflow, run for this very tag, from the signed commit:
  // the tag name alone can be pointed at another commit whose own release.yml built the image. The
  // build's source commit and the workflow file it ran must both be the commit the signed tag names.
  const attestations = Object.fromEntries(
    Object.entries(options.images).map(([name, ref]) => [
      name,
      tag !== undefined &&
        /^[0-9a-f]{40}$/.test(head) &&
        runner("gh", [
          "attestation",
          "verify",
          `oci://${ref}`,
          "--repo",
          options.repo,
          "--signer-workflow",
          `${options.repo}/${RELEASE_WORKFLOW}`,
          "--source-ref",
          `refs/tags/${tag}`,
          "--source-digest",
          head,
          "--signer-digest",
          head,
        ]) !== undefined,
    ]),
  );
  return {
    head,
    tag,
    tagAnnotated,
    tagSignatureValid,
    tagOnOrigin,
    onOriginMain,
    cleanTree,
    ci,
    images: options.images,
    attestations,
  };
}

/**
 * The digest of a deploy kit directory (the host scripts, compose files and service settings a deploy
 * ships next to the release): SHA-256 over `sha256sum`-style lines, `<hex>  <path>`, one per regular
 * file in byte order of its path relative to the directory, leaving out `secrets/*.env` (never
 * shipped). The kit's activate script computes the same digest over what arrived on the host, so the
 * two can be compared and recorded with the release.
 */
export function kitDigest(directory: string): string {
  const files: string[] = [];
  const walk = (relative: string) => {
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true })) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && !/^secrets\/[^/]*\.env$/.test(path)) files.push(path);
      else if (!entry.isFile()) throw new Error(`${path} in the kit is neither a file nor a directory`);
    }
  };
  walk("");
  const listing = files
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .map(
      (path) =>
        `${createHash("sha256")
          .update(readFileSync(join(directory, path)))
          .digest("hex")}  ${path}\n`,
    )
    .join("");
  return `sha256:${createHash("sha256").update(listing).digest("hex")}`;
}

function main(): void {
  const { values } = parseArgs({
    options: {
      repo: { type: "string" },
      image: { type: "string", multiple: true, default: [] },
      require: { type: "string", multiple: true, default: [] },
      kit: { type: "string" },
      fetch: { type: "boolean", default: false },
    },
  });
  if (values.repo === undefined) {
    process.stderr.write(
      "usage: check-deployable.ts --repo owner/name --image name=ref@sha256:… [--require name] [--kit dir] [--fetch]\n",
    );
    process.exit(2);
  }
  const images: Record<string, string> = {};
  for (const entry of values.image) {
    const at = entry.indexOf("=");
    if (at <= 0) {
      process.stderr.write(`--image must be name=ref, got ${entry}\n`);
      process.exit(2);
    }
    images[entry.slice(0, at)] = entry.slice(at + 1);
  }
  const facts = gatherFacts({ repo: values.repo, images, fetch: values.fetch });
  const problems = deployProblems(facts, values.require);
  for (const problem of problems) process.stderr.write(`not deployable: ${problem}\n`);
  if (problems.length > 0) process.exit(1);
  process.stdout.write(`deployable: ${facts.tag ?? ""} at ${facts.head}\n`);
  // The kit is not part of the release: its digest is printed so the deploy can hand it to the host,
  // which refuses a kit that differs from it, and records it with the release.
  if (values.kit !== undefined) process.stdout.write(`kit: ${kitDigest(values.kit)}\n`);
}

if (import.meta.main) main();
