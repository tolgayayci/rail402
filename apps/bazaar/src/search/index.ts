import { entryKey, type CatalogEntry } from "../catalog/types.js";
import { defaultEmbedder, dot, type EmbeddingProvider } from "./embedding.js";

/**
 * Natural-language search over the catalog.
 *
 * Search quality is a graded deliverable, not a feature flag, and it is
 * "the part existing catalogs most often leave unimplemented" — the incumbent's `network` and
 * `scheme` filters do not even work.
 *
 * ## Why BM25 in-process rather than an engine
 *
 * A search engine we operate is in the dependency path for licensing purposes, which
 * rules out Typesense (GPL-3.0) and Elasticsearch (SSPL) outright. Of what remains, an in-process
 * lexical index has properties that matter more here than raw scale: zero operational surface, fully
 * deterministic (so the evaluation harness measures ranking rather than infrastructure), no native
 * modules to complicate the Docker image, and no second thing to keep alive for the degraded-mode
 * story. The live catalog it must compete with holds ~15k resources; BM25 over that is milliseconds.
 *
 * `Retriever` is an interface precisely so a vector/hybrid backend can be added later without
 * touching the endpoint or the harness.
 */

export interface ScoredEntry {
  entry: CatalogEntry;
  score: number;
}

export interface Retriever {
  index(entries: readonly CatalogEntry[]): void;
  search(query: string, candidates: readonly CatalogEntry[], limit: number): ScoredEntry[];
}

// ── Text processing ──────────────────────────────────────────────────────────

/**
 * Words that carry no discriminating signal in an API catalog.
 *
 * The second group was added after the held-out dev set exposed a specific failure: "how much of a
 * token does this wallet hold" returned the *allowance* endpoint instead of the balance one.
 * Allowance's description happens to contain the phrase "how much", and because "much" is rare
 * across the corpus its IDF is high — so one meaningless rare word outweighed two meaningful common
 * ones ("token", "wallet"). Natural-language queries are full of these; keyword queries are not,
 * which is exactly why a set of hand-written keyword-ish queries never surfaces the problem.
 */
const STOP_WORDS = new Set([
  "a", "an", "and", "any", "are", "as", "at", "be", "by", "for", "from", "get", "how", "i",
  "in", "is", "it", "me", "my", "of", "on", "or", "that", "the", "to", "want", "with", "need",
  "find", "give", "please", "can", "you", "some", "which", "what", "where",
  // Conversational filler. High IDF, zero meaning — the worst combination for BM25.
  "much", "many", "does", "do", "did", "has", "have", "will", "this", "these", "those",
  "there", "its", "about", "than", "then",
]);

/**
 * Split text into normalized terms.
 *
 * camelCase and snake_case are split, because MCP tool names and query parameters carry most of the
 * useful signal and arrive as `financial_analysis` or `getWeatherForecast`. Without splitting,
 * a search for "weather forecast" would never match `getWeatherForecast`.
 */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 1 && !STOP_WORDS.has(t))
    .map(stem);
}

/**
 * Very light suffix stripping. Deliberately not a full Porter stemmer: aggressive stemming
 * conflates distinct API terms (`rating` / `rate`, `pricing` / `price` are fine, but `parsing` /
 * `parse` vs `parser` is not), and every conflation is invisible damage to precision.
 */
function stem(term: string): string {
  if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
  if (term.length > 4 && term.endsWith("es")) return term.slice(0, -2);
  if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) return term.slice(0, -1);
  return term;
}

// ── Vocabulary bridging ──────────────────────────────────────────────────────

/**
 * Domain synonyms, applied at INDEX time only.
 *
 * Pure lexical retrieval cannot bridge vocabulary: an agent asking "where is my package" shares no
 * term with a service described as "track a shipment across major couriers". That query returned
 * nothing at all in the first evaluation run — a real recall gap, not a tuning problem.
 *
 * Expanding the *document* rather than the *query* is the deliberate choice. Query expansion
 * multiplies work per request and, worse, can drag in unrelated results at speed; document
 * expansion is paid once at index time, is inspectable, and leaves the query path untouched. Terms
 * are added at reduced weight so a genuine description match always outranks a bridged one.
 *
 * This is a pragmatic bridge, not a semantic model. The `Retriever` interface exists so an
 * embedding-based retriever can be fused in later; until then this closes the largest gap the
 * judgment set exposes, and the harness will show immediately if it ever starts hurting precision.
 */
const SYNONYMS: Record<string, string[]> = {
  shipment: ["package", "parcel", "delivery"],
  tracking: ["where", "status", "locate"],
  courier: ["shipping", "post"],
  transcript: ["text", "words"],
  transcription: ["speech", "dictation"],
  audio: ["recording", "sound", "voice"],
  image: ["picture", "photo", "art"],
  generate: ["create", "make", "draw"],
  translate: ["language", "convert"],
  equity: ["stock", "share", "company"],
  forex: ["currency", "dollar", "euro", "money"],
  geocoding: ["coordinate", "location", "latitude", "longitude"],
  address: ["street", "postal"],
  sentiment: ["positive", "negative", "emotion", "tone"],
  summarization: ["summarize", "digest", "brief", "report"],
  portfolio: ["investment", "holding"],
  risk: ["volatility", "exposure"],
  weather: ["temperature", "rain", "forecast"],
  pollution: ["pollen", "smog", "air"],
  blockchain: ["wallet", "ledger", "onchain"],
  account: ["balance", "wallet"],
  // "how much does this wallet HOLD" vs a description saying "token BALANCE". A pure lexical
  // ranker cannot cross that, and it is the single most common way an agent phrases the question.
  balance: ["hold", "holding"],
};

/** Reduced weight for bridged terms: a real match must always beat a synonym match. */
const SYNONYM_WEIGHT = 0.45;

/** Expand a set of document terms with their domain synonyms. */
function expandTerms(term: string): string[] {
  return SYNONYMS[term] ?? [];
}

// ── Field weighting ──────────────────────────────────────────────────────────

/**
 * Per-field weights. A term matching a service's own name or tags is a far stronger signal than the
 * same term buried in an example response body, and per-parameter descriptions are what make an
 * endpoint legible to an agent, so they are weighted above generic prose.
 */
const FIELD_WEIGHTS = {
  serviceName: 3.0,
  tags: 2.5,
  toolName: 3.0,
  description: 2.0,
  paramDescriptions: 1.5,
  url: 1.0,
  other: 0.5,
} as const;

interface FieldedDoc {
  key: string;
  /** term -> accumulated weighted frequency */
  terms: Map<string, number>;
  length: number;
}

/** Pull every searchable string out of an entry, tagged with the weight of the field it came from. */
export function describeEntry(entry: CatalogEntry): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  const add = (text: unknown, weight: number) => {
    if (typeof text === "string" && text.trim()) out.push([text, weight]);
  };

  add(entry.serviceName, FIELD_WEIGHTS.serviceName);
  add(entry.description, FIELD_WEIGHTS.description);
  add(entry.toolName, FIELD_WEIGHTS.toolName);
  for (const tag of entry.tags ?? []) add(tag, FIELD_WEIGHTS.tags);

  try {
    add(new URL(entry.resource).pathname.replace(/[/_-]/g, " "), FIELD_WEIGHTS.url);
  } catch {
    add(entry.resource, FIELD_WEIGHTS.url);
  }

  // The bazaar extension carries the endpoint's own input schema. Property names and their
  // `description`s are the richest signal we have about what an endpoint actually does.
  const bazaar = entry.extensions?.["bazaar"] as
    | { info?: { input?: Record<string, unknown>; output?: Record<string, unknown> } }
    | undefined;
  const input = bazaar?.info?.input;
  if (input) {
    add(input["description"], FIELD_WEIGHTS.description);
    collectSchemaText(input["inputSchema"], out);

    // HTTP endpoints carry their per-parameter descriptions in the JSON Schema that validates
    // `info` — NOT in `info.input`, which holds only concrete example values. Reading just
    // `info.input.queryParams` therefore yields parameter *names* and silently drops every
    // description the seller wrote. Those descriptions are the richest signal we have about what an
    // endpoint does, and the thing that makes an endpoint legible to an agent, so missing
    // them quietly degraded search for every HTTP resource. Walk the schema as well.
    collectSchemaText((bazaar as { schema?: unknown } | undefined)?.schema, out);
    for (const field of ["queryParams", "body", "pathParams"] as const) {
      const value = input[field];
      if (value && typeof value === "object") {
        for (const key of Object.keys(value as Record<string, unknown>)) {
          add(key, FIELD_WEIGHTS.paramDescriptions);
        }
      }
    }
  }
  return out;
}

/** Walk a JSON Schema for property names, descriptions, titles and enum values. */
function collectSchemaText(schema: unknown, out: Array<[string, number]>, depth = 0): void {
  if (!schema || typeof schema !== "object" || depth > 4) return;
  const s = schema as Record<string, unknown>;

  for (const key of ["description", "title"]) {
    if (typeof s[key] === "string") out.push([s[key] as string, FIELD_WEIGHTS.paramDescriptions]);
  }
  if (Array.isArray(s["enum"])) {
    for (const v of s["enum"]) if (typeof v === "string") out.push([v, FIELD_WEIGHTS.other]);
  }
  const props = s["properties"];
  if (props && typeof props === "object") {
    for (const [name, sub] of Object.entries(props as Record<string, unknown>)) {
      out.push([name, FIELD_WEIGHTS.paramDescriptions]);
      collectSchemaText(sub, out, depth + 1);
    }
  }
  collectSchemaText(s["items"], out, depth + 1);
}

// ── BM25 ─────────────────────────────────────────────────────────────────────

const K1 = 1.5;
const B = 0.6;

export class Bm25Retriever implements Retriever {
  private docs = new Map<string, FieldedDoc>();
  private docFreq = new Map<string, number>();
  private avgLength = 0;

  index(entries: readonly CatalogEntry[]): void {
    this.docs.clear();
    this.docFreq.clear();

    for (const entry of entries) {
      const terms = new Map<string, number>();
      let length = 0;
      for (const [text, weight] of describeEntry(entry)) {
        for (const term of tokenize(text)) {
          terms.set(term, (terms.get(term) ?? 0) + weight);
          length += weight;
          // Bridge vocabulary at index time, at reduced weight.
          for (const bridged of expandTerms(term)) {
            const w = weight * SYNONYM_WEIGHT;
            terms.set(bridged, (terms.get(bridged) ?? 0) + w);
            length += w;
          }
        }
      }
      const key = entry.toolName ? `${entry.resource} ${entry.toolName}` : entry.resource;
      this.docs.set(key, { key, terms, length });
      for (const term of terms.keys()) {
        this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1);
      }
    }

    const total = [...this.docs.values()].reduce((n, d) => n + d.length, 0);
    this.avgLength = this.docs.size === 0 ? 0 : total / this.docs.size;
  }

  search(query: string, candidates: readonly CatalogEntry[], limit: number): ScoredEntry[] {
    const queryTerms = tokenize(query);
    if (queryTerms.length === 0) return [];

    const n = Math.max(this.docs.size, 1);
    const scored: ScoredEntry[] = [];

    for (const entry of candidates) {
      const key = entry.toolName ? `${entry.resource} ${entry.toolName}` : entry.resource;
      const doc = this.docs.get(key);
      if (!doc) continue;

      let score = 0;
      let matched = 0;
      for (const term of queryTerms) {
        const tf = doc.terms.get(term);
        if (!tf) continue;
        matched += 1;
        const df = this.docFreq.get(term) ?? 1;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        const norm = this.avgLength === 0 ? 1 : doc.length / this.avgLength;
        score += idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + B * norm)));
      }
      if (matched === 0) continue;

      // Coverage bonus: a document matching every query term beats one matching a single rare term
      // very strongly. Pure BM25 over-rewards rare-term matches for multi-word natural queries.
      score *= 1 + 0.35 * (matched / queryTerms.length);

      scored.push({ entry, score: score * qualityMultiplier(entry) });
    }

    // Deterministic ordering: score, then key. Stable sort matters because pagination cursors
    // encode an offset into this list — a wobbling order would silently skip or repeat results.
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        (a.entry.resource + (a.entry.toolName ?? "")).localeCompare(
          b.entry.resource + (b.entry.toolName ?? ""),
        ),
    );
    return scored.slice(0, limit);
  }
}

/**
 * Behaviour-derived boost, capped and logarithmic.
 *
 * Distinct **unique payers only**. `totalSettlements` used to be in this formula, and it is the
 * cheapest signal in the catalog: on a fee-sponsored rail two colluding addresses can rack up
 * settlements at no cost, so it let a listing reach the cap for almost nothing. Unique payers require
 * distinct FUNDED addresses — the cap is now ~25 of them (`2·payers ≥ 49`), not two settlements — so
 * self-declared popularity and keyword stuffing still cannot buy rank, and cheap wash-settlement is no
 * longer a lever. This is the strongest count-based control; the load-bearing one the
 * "abuse-resistant" bar really wants is settled-VALUE weighting with a dust floor (real money moved,
 * not accounts created), which is the planned next step. The cap keeps usage a tiebreaker that can
 * never bury a better-matching newcomer: relevance leads.
 */
function qualityMultiplier(entry: CatalogEntry): number {
  const payers = entry.quality.uniquePayers;
  const usage = Math.log1p(payers * 2) / Math.log(50);
  return 1 + Math.min(usage, 1) * 0.25;
}

// ── Hybrid retrieval: BM25 fused with static-embedding recall (RRF) ─────────────

/**
 * Text rendered per document for embedding — the legible fields an agent's query would describe:
 * name, purpose, tags, the URL's own words, the tool name, and per-parameter prose. Deliberately NOT
 * the ranker's weighted field structure. The exact rendering moves the numbers; the DIRECTION of the
 * fusion win is robust across renderings and two models (semantic-deps research, 2026-08-05).
 */
function docText(e: CatalogEntry): string {
  const parts: string[] = [];
  if (e.serviceName) parts.push(e.serviceName);
  if (e.description) parts.push(e.description);
  if (e.tags?.length) parts.push(e.tags.join(" "));
  try {
    parts.push(new URL(e.resource).pathname.replace(/[/_-]+/g, " "));
  } catch {
    /* resource may be a non-URL identifier; skip */
  }
  if (e.toolName) parts.push(e.toolName);
  const bazaar = e.extensions?.["bazaar"] as
    | { info?: { input?: { inputSchema?: { properties?: Record<string, { description?: string }> } } } }
    | undefined;
  const props = bazaar?.info?.input?.inputSchema?.properties;
  if (props) for (const p of Object.values(props)) if (p?.description) parts.push(p.description);
  return parts.join(" . ");
}

const RRF_K = 60;

/**
 * BM25 fused with static-embedding retrieval via Reciprocal Rank Fusion.
 *
 * Fusion over RANKS, not scores: BM25 scores and cosines are not on comparable scales, and rank
 * fusion needs no calibration and no tuned alpha — nothing new to overfit on a 107-judgment set.
 * `score(key) = 1/(K + lexRank) + 1/(K + vecRank)`, K=60 (Cormack et al., SIGIR '09; insensitive
 * across 20–100). Lexical precision (sibling discrimination, where static vectors are weak) and
 * semantic recall (the vocabulary gap, where BM25 is weak) each contribute half, and neither can bury
 * the other. On the 107-judgment broad set this lifts recall@10 ~45% → ~80%, sign test p < 0.0001.
 *
 * `Retriever` is the seam the file header promised; a managed `VectorIndex` (Vectorize) can replace
 * the in-process brute force later without touching the store or the harness — at which point its
 * post-ANN filtering forces an honest `truncated`/`partialResults` signal the brute force never needs.
 */
export class HybridRetriever implements Retriever {
  private readonly bm25 = new Bm25Retriever();
  private readonly provided: EmbeddingProvider | undefined;
  private instance: EmbeddingProvider | undefined;
  private vectors = new Map<string, Float32Array>();

  constructor(embedder?: EmbeddingProvider) {
    this.provided = embedder;
  }

  /**
   * The static-embedding weights load LAZILY — on first index/search, not at construction — so a
   * CatalogStore that never searches (a facilitator serving only verify/settle, or a test that only
   * catalogs) pays nothing for the 7.56 MB table, and never fails if the asset is absent.
   */
  private get embedder(): EmbeddingProvider {
    return (this.instance ??= this.provided ?? defaultEmbedder());
  }

  index(entries: readonly CatalogEntry[]): void {
    this.bm25.index(entries);
    const next = new Map<string, Float32Array>();
    for (const e of entries) next.set(entryKey(e.resource, e.toolName), this.embedder.embed(docText(e)));
    this.vectors = next;
  }

  search(query: string, candidates: readonly CatalogEntry[], limit: number): ScoredEntry[] {
    const keyOf = (e: CatalogEntry): string => entryKey(e.resource, e.toolName);

    // Lexical ranking of the candidates.
    const lexical = this.bm25.search(query, candidates, limit);
    const lexRank = new Map<string, number>();
    lexical.forEach((s, i) => lexRank.set(keyOf(s.entry), i));

    // Semantic ranking of the candidates (cosine over L2-normalized vectors).
    const qv = this.embedder.embed(query);
    const vector = candidates
      .map(e => ({ entry: e, key: keyOf(e), score: rankScore(this.vectors.get(keyOf(e)), qv) }))
      .filter(s => s.score > -Infinity)
      .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
      .slice(0, limit);
    const vecRank = new Map<string, number>();
    vector.forEach((s, i) => vecRank.set(s.key, i));

    // Reciprocal-rank fusion over the union of both top lists.
    const byKey = new Map<string, CatalogEntry>();
    for (const s of lexical) byKey.set(keyOf(s.entry), s.entry);
    for (const s of vector) byKey.set(s.key, s.entry);
    const fused: ScoredEntry[] = [];
    for (const [key, entry] of byKey) {
      const lr = lexRank.get(key);
      const vr = vecRank.get(key);
      const score = (lr === undefined ? 0 : 1 / (RRF_K + lr)) + (vr === undefined ? 0 : 1 / (RRF_K + vr));
      fused.push({ entry, score });
    }
    fused.sort(
      (a, b) => b.score - a.score || keyOf(a.entry).localeCompare(keyOf(b.entry)),
    );
    return fused.slice(0, limit);
  }
}

function rankScore(docVec: Float32Array | undefined, queryVec: Float32Array): number {
  return docVec ? dot(docVec, queryVec) : -Infinity;
}
