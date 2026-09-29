/**
 * Builds the evaluation corpus from listing drafts. Every draft goes through the same path a real
 * seller's listing does: its discovery metadata is produced by the stock `declareDiscoveryExtension`
 * from @x402/extensions, and the result is cataloged by Rail402's own `extractCandidate`, so the
 * corpus holds exactly what the catalog would store after a settlement.
 *
 *   node tools/search-eval/src/build/corpus.ts --check <drafts.jsonl>...   validate drafts only
 *   node tools/search-eval/src/build/corpus.ts --drafts <dir> --out <dir>  write corpus.jsonl and listings.jsonl
 *
 * Listing ids are assigned after a seeded shuffle, so an id says nothing about a listing's category
 * or author. `payTo` is derived per provider, so one provider's listings share an owner.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Keypair } from "@stellar/stellar-sdk";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import {
  SchemaSandbox,
  extractCandidate,
  type ListingContent,
  type PaymentOption,
} from "@rail402.dev/bazaar";
import type { KnownAsset } from "@rail402.dev/search";
import type { CorpusEntry } from "../dataset.ts";

export const ASSETS: readonly KnownAsset[] = [
  asset("stellar:testnet", "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA", "USDC", true),
  asset("stellar:pubnet", "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75", "USDC", true),
  asset("stellar:testnet", "CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ", "EURC", false),
  asset("stellar:pubnet", "CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV", "EURC", false),
  asset("stellar:testnet", "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC", "XLM", false),
  asset("stellar:pubnet", "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA", "XLM", false),
];

const STYLES = ["sparse", "sloppy", "standard", "detailed"] as const;
const PARAMETER_TYPES = ["string", "number", "integer", "boolean", "array", "object"] as const;

export interface Draft {
  readonly draft: string;
  readonly category: string;
  readonly capabilities: readonly string[];
  readonly provider: string;
  readonly kind: "http" | "mcp";
  readonly resource: string;
  readonly method?: "GET" | "POST";
  readonly toolName?: string;
  readonly serviceName?: string | null;
  readonly description?: string | null;
  readonly tags?: readonly string[] | null;
  readonly parameters: readonly {
    readonly name: string;
    readonly type: (typeof PARAMETER_TYPES)[number];
    readonly required: boolean;
    readonly description?: string | null;
    readonly example?: unknown;
  }[];
  readonly output?: unknown;
  readonly prices: readonly { readonly network: string; readonly asset: string; readonly amount: string }[];
  readonly style: (typeof STYLES)[number];
  readonly adversarial?: string | null;
}

/** Construction metadata for one corpus listing. Used for pooling and analysis, never shown to judges. */
export interface ListingRecord {
  readonly id: string;
  readonly draft: string;
  readonly category: string;
  readonly capabilities: readonly string[];
  readonly provider: string;
  readonly style: string;
  readonly adversarial: string | null;
}

/** Checks a draft's shape. Returns the problems found; an empty list means well-formed. */
export function draftProblems(value: unknown): string[] {
  const problems: string[] = [];
  const draft = value as Partial<Draft> | null;
  if (draft === null || typeof draft !== "object") return ["not an object"];
  const text = (field: string, candidate: unknown, optional = false) => {
    if (optional && (candidate === undefined || candidate === null)) return;
    if (typeof candidate !== "string" || candidate.trim() === "")
      problems.push(`${field} must be a non-empty string`);
  };
  text("draft", draft.draft);
  text("category", draft.category);
  text("provider", draft.provider);
  text("resource", draft.resource);
  text("serviceName", draft.serviceName, true);
  text("description", draft.description, true);
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(draft.provider ?? ""))
    problems.push("provider must be a lowercase slug");
  if (!Array.isArray(draft.capabilities) || draft.capabilities.length === 0) {
    problems.push("capabilities must list at least one capability id");
  }
  if (draft.kind === "http") {
    if (draft.method !== "GET" && draft.method !== "POST")
      problems.push("http drafts need method GET or POST");
    if (!/^https:\/\//.test(draft.resource ?? "")) problems.push("http resources must be https URLs");
  } else if (draft.kind === "mcp") {
    text("toolName", draft.toolName);
    if (!/^(https:\/\/|mcp:\/\/)/.test(draft.resource ?? ""))
      problems.push("mcp resources must be https:// or mcp://");
  } else {
    problems.push('kind must be "http" or "mcp"');
  }
  if (draft.tags !== undefined && draft.tags !== null && !Array.isArray(draft.tags))
    problems.push("tags must be a list");
  if (!Array.isArray(draft.parameters)) problems.push("parameters must be a list (possibly empty)");
  for (const parameter of draft.parameters ?? []) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(parameter.name))
      problems.push(`bad parameter name ${parameter.name}`);
    if (!PARAMETER_TYPES.includes(parameter.type))
      problems.push(`bad parameter type ${JSON.stringify(parameter.type)}`);
  }
  if (!Array.isArray(draft.prices) || draft.prices.length === 0)
    problems.push("prices must list at least one option");
  for (const price of draft.prices ?? []) {
    if (!ASSETS.some((known) => known.network === price.network && known.symbol === price.asset)) {
      problems.push(`unknown asset ${price.asset} on ${price.network}`);
    }
    if (!/^\d+(\.\d{1,7})?$/.test(price.amount) || Number(price.amount) <= 0) {
      problems.push(`amount ${price.amount} must be a positive decimal with at most 7 places`);
    }
  }
  if (!STYLES.includes(draft.style as (typeof STYLES)[number]))
    problems.push(`style must be one of ${STYLES.join(", ")}`);
  return problems;
}

/** The catalog listing a draft becomes, or the reason the catalog would refuse it. */
export async function catalogDraft(
  draft: Draft,
  sandbox: SchemaSandbox,
): Promise<{ ok: true; content: ListingContent } | { ok: false; reason: string }> {
  const payTo = providerAccount(draft.provider);
  const options: PaymentOption[] = draft.prices.map((price) => ({
    scheme: "exact",
    network: price.network,
    asset: assetOf(price.network, price.asset).contract,
    payTo,
    amount: baseUnits(price.amount),
    maxTimeoutSeconds: 60,
    extra: { areFeesSponsored: true },
  }));
  const first = options[0];
  if (first === undefined) return { ok: false, reason: "no price" };

  const properties = Object.fromEntries(
    draft.parameters.map((parameter) => [
      parameter.name,
      {
        type: parameter.type,
        ...(parameter.description ? { description: parameter.description } : {}),
      },
    ]),
  );
  const required = draft.parameters
    .filter((parameter) => parameter.required)
    .map((parameter) => parameter.name);
  const example = Object.fromEntries(
    draft.parameters
      .filter((parameter) => parameter.example !== undefined)
      .map((parameter) => [parameter.name, parameter.example]),
  );
  const inputSchema = { type: "object", properties, ...(required.length > 0 ? { required } : {}) };
  // Drafts give the response example itself; `{ "example": … }` is accepted as the same thing.
  const response = isExampleWrapper(draft.output) ? draft.output.example : draft.output;
  const output = response === undefined || response === null ? {} : { output: { example: response } };

  let extension: Record<string, unknown>;
  if (draft.kind === "mcp") {
    extension = declareDiscoveryExtension({
      toolName: draft.toolName ?? "",
      ...(draft.description ? { description: draft.description } : {}),
      inputSchema,
      ...output,
    })["bazaar"] as unknown as Record<string, unknown>;
  } else {
    extension = declareDiscoveryExtension({
      ...(Object.keys(example).length > 0 ? { input: example } : {}),
      ...(draft.parameters.length > 0 ? { inputSchema } : {}),
      ...(draft.method === "POST" ? { bodyType: "json" } : {}),
      ...output,
    })["bazaar"] as unknown as Record<string, unknown>;
    // The bazaar server extension adds the route's method when the 402 is built.
    const info = extension["info"] as { input: Record<string, unknown> };
    info.input["method"] = draft.method;
  }

  const requirements = { ...first, extra: { ...first.extra } } as unknown as PaymentRequirements;
  const payload = {
    x402Version: 2,
    resource: {
      url: draft.resource,
      mimeType: "application/json",
      ...(draft.description ? { description: draft.description } : {}),
      ...(draft.serviceName ? { serviceName: draft.serviceName } : {}),
      ...(draft.tags && draft.tags.length > 0 ? { tags: [...draft.tags] } : {}),
    },
    accepted: requirements,
    payload: { transaction: "" },
    extensions: { bazaar: extension },
  } as unknown as PaymentPayload;

  const extraction = await extractCandidate(
    { payload, requirements, payer: "", transaction: "" },
    { sandbox, allowLoopback: false },
  );
  if (extraction.kind === "absent") return { ok: false, reason: "no bazaar extension" };
  if (extraction.kind === "rejected")
    return { ok: false, reason: `${extraction.code}: ${extraction.reason}` };
  // A listing with several payment options carries all of them, as an origin-verified listing does.
  return { ok: true, content: { ...extraction.candidate.content, accepts: options } };
}

function isExampleWrapper(value: unknown): value is { example: unknown } {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).join() === "example"
  );
}

/** A provider's receiving account, derived from its slug so the corpus is reproducible. */
export function providerAccount(provider: string): string {
  const seed = createHash("sha256").update(`rail402-search-eval:${provider}`).digest();
  return Keypair.fromRawEd25519Seed(seed).publicKey();
}

function assetOf(network: string, symbol: string): KnownAsset {
  const found = ASSETS.find((known) => known.network === network && known.symbol === symbol);
  if (found === undefined) throw new Error(`unknown asset ${symbol} on ${network}`);
  return found;
}

function baseUnits(amount: string): string {
  const [whole = "0", fraction = ""] = amount.split(".");
  return (BigInt(whole) * 10_000_000n + BigInt((fraction + "0000000").slice(0, 7))).toString();
}

function asset(network: string, contract: string, symbol: string, usd: boolean): KnownAsset {
  return { network, contract, symbol, decimals: 7, usd };
}

/** Deterministic shuffle (mulberry32), so ids are stable for the same drafts. */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j] as T, result[i] as T];
  }
  return result;
}

async function readDrafts(
  files: readonly string[],
): Promise<{ file: string; line: number; value: unknown }[]> {
  const drafts: { file: string; line: number; value: unknown }[] = [];
  for (const file of files) {
    const lines = (await readFile(file, "utf8")).split("\n");
    for (const [index, line] of lines.entries()) {
      if (line.trim() === "") continue;
      try {
        drafts.push({ file, line: index + 1, value: JSON.parse(line) as unknown });
      } catch (error) {
        drafts.push({ file, line: index + 1, value: { invalidJson: (error as Error).message } });
      }
    }
  }
  return drafts;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      check: { type: "boolean", default: false },
      drafts: { type: "string" },
      out: { type: "string" },
      seed: { type: "string", default: "402" },
    },
  });
  const files = values.check
    ? positionals.map((file) => resolve(file))
    : (await readdir(resolve(values.drafts ?? "")))
        .filter((name) => name.endsWith(".jsonl"))
        .sort()
        .map((name) => join(resolve(values.drafts ?? ""), name));
  const drafts = await readDrafts(files);
  const sandbox = new SchemaSandbox();
  const failures: string[] = [];
  const built: { draft: Draft; content: ListingContent }[] = [];
  const seen = new Map<string, string>();
  try {
    for (const { file, line, value } of drafts) {
      const where = `${file}:${String(line)}`;
      const problems = draftProblems(value);
      if (problems.length > 0) {
        failures.push(`${where}: ${problems.join("; ")}`);
        continue;
      }
      const draft = value as Draft;
      const previous = seen.get(draft.draft);
      if (previous !== undefined) failures.push(`${where}: draft id ${draft.draft} repeats ${previous}`);
      seen.set(draft.draft, where);
      const result = await catalogDraft(draft, sandbox);
      if (!result.ok) failures.push(`${where}: ${draft.draft}: ${result.reason}`);
      else built.push({ draft, content: result.content });
    }
  } finally {
    await sandbox.close();
  }
  const identities = new Map<string, string>();
  for (const { draft, content } of built) {
    const identity = [
      content.accepts[0]?.network,
      content.resource,
      content.method ?? "",
      content.toolName ?? "",
    ].join("|");
    const clash = identities.get(identity);
    if (clash !== undefined) failures.push(`${draft.draft}: same catalog identity as ${clash}`);
    identities.set(identity, draft.draft);
  }

  console.log(`${String(built.length)} of ${String(drafts.length)} drafts catalog cleanly`);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`  ${failure}`);
    process.exitCode = 1;
    return;
  }
  if (values.check) return;

  const out = resolve(values.out ?? "");
  const ordered = shuffled(
    [...built].sort((a, b) => a.draft.draft.localeCompare(b.draft.draft)),
    Number(values.seed),
  );
  const width = String(ordered.length).length;
  const corpus: CorpusEntry[] = [];
  const records: ListingRecord[] = [];
  for (const [index, { draft, content }] of ordered.entries()) {
    const id = `L${String(index + 1).padStart(Math.max(3, width), "0")}`;
    corpus.push({ id, source: "sample", listing: content });
    records.push({
      id,
      draft: draft.draft,
      category: draft.category,
      capabilities: draft.capabilities,
      provider: draft.provider,
      style: draft.style,
      adversarial: draft.adversarial ?? null,
    });
  }
  await writeFile(join(out, "corpus.jsonl"), corpus.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  await writeFile(join(out, "assets.json"), `${JSON.stringify(ASSETS, null, 2)}\n`);
  await writeFile(
    join(out, "..", "construction", "listings.jsonl"),
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
  console.log(`corpus written to ${out}`);
}

if (import.meta.url === `file://${process.argv[1] ?? ""}`) await main();
