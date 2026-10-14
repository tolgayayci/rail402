/**
 * The threat registry, `docs/security/threats.json`: every threat with its Stellar-specific analysis,
 * the mitigations that answer it (each pointing at a symbol in a source file), the tests that prove
 * them and the conformance cases that exercise them. `docs/security/threat-model.mdx` renders its
 * tables from this file, and `test/threats.test.ts` checks that every citation still resolves.
 *
 * Citation formats:
 * - mitigation code: `path#symbol`, a repository file that contains `symbol`;
 * - test: `path::name`, a test file (TypeScript or Rust) that contains the test name;
 * - evidence: `harness#case`, a conformance harness (`tools/conformance/src/<harness>*.ts`) that
 *   declares the case id.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { REPO_ROOT } from "./evidence.ts";

export const THREATS_FILE = "docs/security/threats.json";

export const STRIDE = ["S", "T", "R", "I", "D", "E"] as const;
export const STRIDE_NAMES: Readonly<Record<(typeof STRIDE)[number], string>> = {
  S: "Spoofing",
  T: "Tampering",
  R: "Repudiation",
  I: "Information disclosure",
  D: "Denial of service",
  E: "Elevation of privilege",
};

/** The topics the threat model must cover, in page order. */
export const REQUIRED_TOPICS = [
  "replay",
  "front-running",
  "fee-sponsorship",
  "catalog-poisoning",
  "ssrf",
  "smart-accounts",
  "mcp-paid-calls",
  "upto-contract",
] as const;

const ID = /^[A-Z]{1,2}\d{1,2}$/;
const CODE_REF = /^[\w./-]+#\S.*$/;
const TEST_REF = /^[\w./-]+::.+$/;
const EVIDENCE_REF = /^[a-z][a-z-]*#[a-z0-9][a-z0-9-]*$/;

const text = z.string().trim().min(1);

const threat = z.strictObject({
  id: z.string().regex(ID, "must be a letter prefix and a number, e.g. R1"),
  topic: text,
  title: text,
  boundary: text,
  stride: z.array(z.enum(STRIDE)).min(1),
  asset: text,
  threat: text,
  /** What Stellar makes different about this threat. */
  stellar: text,
  preconditions: text,
  impact: text,
  mitigations: z.array(z.strictObject({ text, code: z.string().regex(CODE_REF, "must be path#symbol") })),
  tests: z.array(z.string().regex(TEST_REF, "must be path::test name")),
  evidence: z.array(z.string().regex(EVIDENCE_REF, "must be harness#case")),
  residual: text,
  status: z.enum(["mitigated", "accepted", "open"]),
});

export const threatRegistrySchema = z.strictObject({
  $comment: z.string().optional(),
  assets: z.array(z.strictObject({ id: text, name: text, description: text })).min(1),
  boundaries: z.array(z.strictObject({ id: text, name: text, description: text })).min(1),
  topics: z.array(z.strictObject({ id: text, title: text })).min(1),
  threats: z.array(threat).min(1),
});

export type ThreatRegistry = z.infer<typeof threatRegistrySchema>;
export type Threat = ThreatRegistry["threats"][number];

export function loadThreats(root = REPO_ROOT): ThreatRegistry {
  return threatRegistrySchema.parse(JSON.parse(readFileSync(join(root, THREATS_FILE), "utf8")));
}

/** `path#symbol` → its parts. */
export function parseCodeRef(ref: string): { path: string; symbol: string } {
  const at = ref.indexOf("#");
  return { path: ref.slice(0, at), symbol: ref.slice(at + 1) };
}

/** `path::name` → its parts. */
export function parseTestRef(ref: string): { path: string; name: string } {
  const at = ref.indexOf("::");
  return { path: ref.slice(0, at), name: ref.slice(at + 2) };
}

/** `harness#case` → its parts. */
export function parseEvidenceRef(ref: string): { harness: string; id: string } {
  const at = ref.indexOf("#");
  return { harness: ref.slice(0, at), id: ref.slice(at + 1) };
}

/** The source files of a conformance harness: `<harness>.ts` and its `<harness>-*.ts` parts. */
export function harnessSources(harness: string, root = REPO_ROOT): string[] {
  const directory = join(root, "tools/conformance/src");
  return readdirSync(directory)
    .filter((name) => name === `${harness}.ts` || (name.startsWith(`${harness}-`) && name.endsWith(".ts")))
    .map((name) => join(directory, name));
}

/** Whether a harness declares a case id: the id appears as a whole token in one of its sources. */
export function harnessDeclares(harness: string, id: string, root = REPO_ROOT): boolean {
  const token = new RegExp(`(?<![a-z0-9-])${id.replace(/-/g, "\\-")}(?![a-z0-9-])`);
  return harnessSources(harness, root).some((file) => token.test(readFileSync(file, "utf8")));
}

/**
 * Every citation that does not resolve, as readable problems: missing files, symbols, test names or
 * harness cases, unknown topics, boundaries and assets, and duplicate ids.
 */
export function citationProblems(registry: ThreatRegistry, root = REPO_ROOT): string[] {
  const problems: string[] = [];
  const read = cachedReader(root);
  const topics = new Set(registry.topics.map((topic) => topic.id));
  const boundaries = new Set(registry.boundaries.map((boundary) => boundary.id));
  const assets = new Set(registry.assets.map((asset) => asset.id));
  const ids = new Set<string>();
  for (const entry of registry.threats) {
    const at = entry.id;
    if (ids.has(entry.id)) problems.push(`${at}: duplicate threat id`);
    ids.add(entry.id);
    if (!topics.has(entry.topic)) problems.push(`${at}: unknown topic "${entry.topic}"`);
    if (!boundaries.has(entry.boundary)) problems.push(`${at}: unknown boundary "${entry.boundary}"`);
    if (!assets.has(entry.asset)) problems.push(`${at}: unknown asset "${entry.asset}"`);
    for (const mitigation of entry.mitigations) {
      const { path, symbol } = parseCodeRef(mitigation.code);
      const source = read(path);
      if (source === undefined) problems.push(`${at}: mitigation cites a missing file ${path}`);
      else if (!source.includes(symbol)) problems.push(`${at}: ${path} does not contain "${symbol}"`);
    }
    for (const ref of entry.tests) {
      const { path, name } = parseTestRef(ref);
      const source = read(path);
      if (source === undefined) problems.push(`${at}: test cites a missing file ${path}`);
      else if (!source.includes(name)) problems.push(`${at}: ${path} has no test named "${name}"`);
    }
    for (const ref of entry.evidence) {
      const { harness, id } = parseEvidenceRef(ref);
      if (harnessSources(harness, root).length === 0) problems.push(`${at}: unknown harness "${harness}"`);
      else if (!harnessDeclares(harness, id, root))
        problems.push(`${at}: ${harness} declares no case "${id}"`);
    }
  }
  for (const topic of REQUIRED_TOPICS) {
    if (!topics.has(topic)) problems.push(`required topic "${topic}" is missing`);
    const tested = registry.threats.some((entry) => entry.topic === topic && entry.tests.length > 0);
    if (!tested) problems.push(`topic "${topic}" has no threat with a test`);
  }
  return problems;
}

function cachedReader(root: string): (path: string) => string | undefined {
  const cache = new Map<string, string | undefined>();
  return (path) => {
    if (!cache.has(path)) {
      const full = join(root, path);
      cache.set(path, existsSync(full) ? readFileSync(full, "utf8") : undefined);
    }
    return cache.get(path);
  };
}
