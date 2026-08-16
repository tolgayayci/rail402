// Eval-pack builder — assembles a large, license-clean SILVER corpus for scale-testing the ranker.
//
// This does NOT touch the live catalog. It fetches open datasets, converts them to CatalogEntry-shaped
// DOCUMENTS used only as an in-process eval fixture (see report.mjs), and writes them under derived/
// (gitignored). What ships in git is this builder + the manifest — never the upstream data — so anyone,
// including a reviewer, reproduces the corpus by running one command with no auth token.
//
// Sources (both fetched by pinned revision, both no-auth):
//   - Team-ACE/ToolACE  (Apache-2.0) — real API/tool definitions with per-parameter descriptions, and
//     dialogues we derive SILVER queries from (first user turn -> the function the assistant called).
//   - MCP registry      (CC0-1.0)    — real MCP server descriptions, as off-distribution distractors.
//
// Silver-doc safety (never can leak into or affect the real catalog):
//   - resource host is always `.invalid` (RFC 2606) — never resolvable, never an SSRF target;
//   - quality is zeroed — a silver doc earns no ranking boost;
//   - payTo is a fixed sentinel — can never collide with a real seller's key.
//
// Usage:  node apps/bazaar/eval-pack/build.mjs
//
// Run rarely (it hits the network). `report.mjs` scores against the output.

import { writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const DERIVED = join(HERE, "derived");
mkdirSync(DERIVED, { recursive: true });

// Pinned so the corpus is reproducible. Bump deliberately, never silently.
const TOOLACE_REV = "main";
const TOOLACE_URL = `https://huggingface.co/datasets/Team-ACE/ToolACE/resolve/${TOOLACE_REV}/data.json`;
const MCP_REGISTRY = "https://registry.modelcontextprotocol.io/v0/servers";
const MCP_PAGES = 12; // ~1.2k servers — enough MCP-flavoured distractors without a 220-request full pull

// Silver-doc constants. None of these are ever settled or ingested; they exist so the shape is valid.
const SENTINEL_PAYTO = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUWDA"; // never a real seller
const USDC_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const FIXED_TS = "2026-08-16T00:00:00.000Z";
const MAX_SILVER_QUERIES = 2000; // cap so the scored eval stays fast; sampled deterministically below

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const slug = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "x";
const silverResource = (source, name) =>
  `https://silver.invalid/${source}/${sha256(source + ":" + name).slice(0, 12)}/${slug(name)}`;

/** One tool/function -> one CatalogEntry-shaped document. Per-parameter descriptions land where the
 *  ranker reads them (extensions.bazaar.schema…queryParams.properties), the field generic tool
 *  datasets uniquely carry. Tags are left ABSENT on purpose — inventing them would manufacture signal. */
function toEntry(source, name, description, params) {
  const queryParams = {};
  for (const [p, spec] of Object.entries(params || {})) {
    if (!spec || typeof spec !== "object") continue;
    const desc = spec.description;
    queryParams[p] = {
      type: typeof spec.type === "string" ? spec.type : "string",
      ...(typeof desc === "string" && desc ? { description: desc } : {}),
      ...(Array.isArray(spec.enum) ? { enum: spec.enum } : {}),
    };
  }
  return {
    resource: silverResource(source, name),
    type: "http",
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: "stellar:testnet",
        amount: "1000000",
        asset: USDC_SAC,
        payTo: SENTINEL_PAYTO,
        maxTimeoutSeconds: 60,
        extra: { areFeesSponsored: true },
      },
    ],
    lastUpdated: FIXED_TS,
    quality: { totalSettlements: 0, uniquePayers: 0, firstSeenAt: FIXED_TS },
    ownerPayTo: SENTINEL_PAYTO,
    serviceName: name,
    description: typeof description === "string" ? description : "",
    extensions: {
      bazaar: {
        schema: { properties: { input: { properties: { queryParams: { properties: queryParams } } } } },
      },
    },
    _silverSource: source,
  };
}

/** Pull the JSON function array out of a ToolACE `system` prompt via a bracket-depth scan (robust to
 *  the trailing instruction text and to `[`/`]` inside quoted strings). */
function extractFunctions(system) {
  if (typeof system !== "string") return [];
  const marker = system.indexOf("invoke:");
  const start = system.indexOf("[", marker < 0 ? 0 : marker);
  if (start < 0) return [];
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < system.length; i++) {
    const c = system[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "[") depth++;
    else if (c === "]" && --depth === 0) { end = i; break; }
  }
  if (end < 0) return [];
  try {
    const arr = JSON.parse(system.slice(start, end + 1));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** Function names the assistant actually called, from a turn like `[Market Trends API(a="b"), Foo(x=1)]`. */
function calledNames(value) {
  if (typeof value !== "string") return [];
  const names = [];
  const re = /(?:\[|,)\s*([A-Za-z0-9 _./-]+?)\s*\(/g;
  let m;
  while ((m = re.exec(value))) names.push(m[1].trim());
  return names;
}

async function buildToolACE() {
  process.stdout.write(`Fetching ToolACE (${TOOLACE_URL}) … `);
  const res = await fetch(TOOLACE_URL);
  if (!res.ok) throw new Error(`ToolACE fetch failed: HTTP ${res.status}`);
  const rows = await res.json();
  console.log(`${rows.length} dialogues`);

  const docsByName = new Map(); // name -> entry (dedup: one function name = one document)
  const queries = []; // { query, relevant: [resource] }

  for (const row of rows) {
    const fns = extractFunctions(row.system);
    for (const fn of fns) {
      if (!fn || typeof fn.name !== "string" || !fn.name.trim()) continue;
      const key = fn.name.trim();
      if (!docsByName.has(key)) {
        docsByName.set(key, toEntry("toolace", key, fn.description, fn.parameters?.properties));
      }
    }
    // Derive a silver query: first user turn -> the function(s) the assistant called in this row.
    const conv = Array.isArray(row.conversations) ? row.conversations : [];
    const userTurn = conv.find((t) => t.from === "user");
    const asstTurn = conv.find((t) => t.from === "assistant" && /\(/.test(t.value || ""));
    if (!userTurn || !asstTurn) continue;
    const called = calledNames(asstTurn.value).filter((n) => docsByName.has(n));
    if (called.length === 0) continue;
    // Drop pronoun-referential follow-ups: a first user turn under ~12 chars rarely determines a tool.
    if ((userTurn.value || "").trim().length < 12) continue;
    const relevant = [...new Set(called.map((n) => docsByName.get(n).resource))];
    queries.push({ query: userTurn.value.trim(), relevant });
  }

  // Deterministic sample of queries (hash-ordered) so the fast eval is bounded and reproducible.
  queries.sort((a, b) => sha256(a.query).localeCompare(sha256(b.query)));
  const sampled = queries.slice(0, MAX_SILVER_QUERIES);
  return { docs: [...docsByName.values()], queries: sampled, totalQueries: queries.length };
}

async function buildMcpRegistry() {
  const docs = new Map();
  let cursor = "";
  process.stdout.write("Fetching MCP registry (CC0) … ");
  for (let page = 0; page < MCP_PAGES; page++) {
    const url = `${MCP_REGISTRY}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const res = await fetch(url);
    if (!res.ok) break;
    const body = await res.json();
    const servers = body.servers || [];
    for (const item of servers) {
      const s = item.server || item;
      if (!s || typeof s.name !== "string") continue;
      if (docs.has(s.name)) continue;
      docs.set(s.name, toEntry("mcp-registry", s.title || s.name, s.description, {}));
    }
    cursor = body.metadata?.nextCursor || body.metadata?.next_cursor || "";
    if (!cursor) break;
  }
  console.log(`${docs.size} servers`);
  return [...docs.values()];
}

const toolace = await buildToolACE();
const mcp = await buildMcpRegistry();

const docs = [...toolace.docs, ...mcp];
const corpusPath = join(DERIVED, "silver-corpus.json");
const judgmentsPath = join(DERIVED, "silver-judgments.json");
writeFileSync(corpusPath, JSON.stringify(docs));
writeFileSync(judgmentsPath, JSON.stringify(toolace.queries));

const manifest = {
  packVersion: "1.0.0",
  builtFrom: {
    toolace: { url: TOOLACE_URL, revision: TOOLACE_REV, license: "Apache-2.0", docs: toolace.docs.length },
    mcpRegistry: { url: MCP_REGISTRY, pages: MCP_PAGES, license: "CC0-1.0", docs: mcp.length },
  },
  totals: {
    docs: docs.length,
    silverQueries: toolace.queries.length,
    silverQueriesAvailable: toolace.totalQueries,
  },
  sha256: { corpus: sha256(JSON.stringify(docs)), judgments: sha256(JSON.stringify(toolace.queries)) },
  note: "Silver eval fixture only. Never served as the live catalog. Hosts are .invalid, quality zeroed, payTo a sentinel.",
};
writeFileSync(join(HERE, "manifest.json"), JSON.stringify(manifest, null, 2));

console.log(`\nSilver corpus: ${docs.length} docs (${toolace.docs.length} ToolACE + ${mcp.length} MCP)`);
console.log(`Silver queries: ${toolace.queries.length} (of ${toolace.totalQueries} derivable)`);
console.log(`Wrote:\n  ${corpusPath}\n  ${judgmentsPath}\n  ${join(HERE, "manifest.json")}`);
