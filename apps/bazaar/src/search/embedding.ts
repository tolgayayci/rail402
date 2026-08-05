import { readFileSync } from "node:fs";
import tokenizerJson from "./potion-tokenizer.json" with { type: "json" };

/**
 * In-process static embeddings (model2vec `potion-base-8M`, MIT weights vendored int8-quantized).
 *
 * A static model is a token→vector table plus a mean — no neural inference, no runtime session, no
 * native binary, no network. That is exactly what a Bazaar needs: license-clean (§4 — this adds ZERO
 * dependencies; the tokenizer is hand-rolled rather than pulled from `@huggingface/tokenizers`),
 * deterministic (so `evaluate.ts` measures ranking, not infrastructure), and Workers-deployable (no
 * Wasm to compile at runtime). Its role is RECALL: pure BM25 cannot cross from "where is my package"
 * to "track a shipment", and on the 107-judgment broad set fusing this with BM25 lifted recall@10
 * from ~45% to ~80% (per-query sign test p < 0.0001). It is fused, never used alone — static vectors
 * are weak at sibling discrimination (`allowance` vs `balance`), which BM25 is strong at.
 *
 * Pipeline matches MinishLab/model2vec `StaticModel._encode_batch`: BertNormalizer → BertPreTokenizer
 * → greedy WordPiece (dropping [UNK]) → gather rows → mean → L2 normalize. int8 dequantization uses a
 * single global scale, which commutes with the mean (the mean is linear) — measured identical to fp32.
 */

export interface EmbeddingProvider {
  readonly dim: number;
  /** Synchronous by design: a static lookup has no IO, keeping reindex() and the eval deterministic. */
  embed(text: string): Float32Array;
}

// ── vendored int8 weights: [4-byte LE headerLen][JSON {rows,dim,scale}][int8 data] ──
function loadWeights(): { rows: number; dim: number; scale: number; data: Int8Array } {
  const buf = readFileSync(new URL("./potion-embeddings.bin", import.meta.url));
  const headerLen = buf.readUInt32LE(0);
  const header = JSON.parse(buf.subarray(4, 4 + headerLen).toString("utf8")) as {
    rows: number;
    dim: number;
    scale: number;
  };
  const dataStart = 4 + headerLen;
  const data = new Int8Array(buf.buffer, buf.byteOffset + dataStart, header.rows * header.dim);
  return { rows: header.rows, dim: header.dim, scale: header.scale, data };
}

// ── BertNormalizer ────────────────────────────────────────────────────────────
const isControl = (cp: number): boolean =>
  cp === 0 || cp === 0xfffd || (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d);

function isChineseChar(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0x2a700 && cp <= 0x2b73f) ||
    (cp >= 0x2b740 && cp <= 0x2b81f) ||
    (cp >= 0x2b820 && cp <= 0x2ceaf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x2f800 && cp <= 0x2fa1f)
  );
}

function bertNormalize(text: string, lowercase: boolean, stripAccents: boolean): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (isControl(cp)) continue;
    if (/\s/.test(ch)) {
      out += " ";
      continue;
    }
    if (isChineseChar(cp)) {
      out += ` ${ch} `;
      continue;
    }
    out += ch;
  }
  if (lowercase) out = out.toLowerCase();
  if (stripAccents) out = out.normalize("NFD").replace(/\p{Mn}/gu, "");
  return out;
}

// ── BertPreTokenizer: whitespace split, punctuation isolated ────────────────────
const PUNCT = /[!-/:-@[-`{-~\p{P}\p{S}]/u;
function bertPreTokenize(text: string): string[] {
  const words: string[] = [];
  for (const chunk of text.split(/\s+/)) {
    if (!chunk) continue;
    let cur = "";
    for (const ch of chunk) {
      if (PUNCT.test(ch)) {
        if (cur) {
          words.push(cur);
          cur = "";
        }
        words.push(ch);
      } else cur += ch;
    }
    if (cur) words.push(cur);
  }
  return words;
}

// ── WordPiece (greedy longest-match), dropping [UNK] as model2vec does ──────────
function makeWordPiece(): (text: string) => number[] {
  const model = tokenizerJson.model as {
    vocab: Record<string, number>;
    unk_token: string;
    continuing_subword_prefix: string;
    max_input_chars_per_word: number;
  };
  const vocab = model.vocab;
  const prefix = model.continuing_subword_prefix ?? "##";
  const unkId = vocab[model.unk_token]!;
  const maxChars = model.max_input_chars_per_word ?? 100;
  const norm = tokenizerJson.normalizer as { lowercase: boolean; strip_accents: boolean | null };
  const lowercase = norm.lowercase !== false;
  const stripAccents =
    norm.strip_accents === null || norm.strip_accents === undefined ? lowercase : norm.strip_accents;

  return (text: string): number[] => {
    const ids: number[] = [];
    for (const word of bertPreTokenize(bertNormalize(text, lowercase, stripAccents))) {
      const chars = [...word];
      if (chars.length > maxChars) {
        ids.push(unkId);
        continue;
      }
      let startIdx = 0;
      const sub: number[] = [];
      let bad = false;
      while (startIdx < chars.length) {
        let end = chars.length;
        let found = -1;
        while (startIdx < end) {
          const piece = (startIdx > 0 ? prefix : "") + chars.slice(startIdx, end).join("");
          const id = vocab[piece];
          if (id !== undefined) {
            found = id;
            break;
          }
          end--;
        }
        if (found === -1) {
          bad = true;
          break;
        }
        sub.push(found);
        startIdx = end;
      }
      if (bad) ids.push(unkId);
      else ids.push(...sub);
    }
    return ids.filter(id => id !== unkId);
  };
}

/** The vendored potion-base-8M static embedder. Loaded once; `embed` is a table lookup + a mean. */
export class StaticEmbedder implements EmbeddingProvider {
  readonly dim: number;
  private readonly data: Int8Array;
  private readonly scale: number;
  private readonly encode: (text: string) => number[];

  constructor() {
    const w = loadWeights();
    this.dim = w.dim;
    this.data = w.data;
    this.scale = w.scale;
    this.encode = makeWordPiece();
  }

  embed(text: string): Float32Array {
    const ids = this.encode(text);
    const v = new Float32Array(this.dim);
    if (ids.length === 0) return v;
    for (const id of ids) {
      const off = id * this.dim;
      for (let d = 0; d < this.dim; d++) v[d]! += this.data[off + d]!;
    }
    // Dequantize + mean in one pass (a global scale commutes with the mean), then L2 normalize.
    let norm = 0;
    const k = this.scale / ids.length;
    for (let d = 0; d < this.dim; d++) {
      v[d]! *= k;
      norm += v[d]! * v[d]!;
    }
    norm = Math.sqrt(norm) + 1e-32;
    for (let d = 0; d < this.dim; d++) v[d]! /= norm;
    return v;
  }
}

/** Cosine similarity of two L2-normalized vectors (== dot product). */
export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

let shared: StaticEmbedder | undefined;
/** Process-wide shared embedder, so the 7.56 MB weight table is loaded once, not per CatalogStore. */
export function defaultEmbedder(): StaticEmbedder {
  return (shared ??= new StaticEmbedder());
}
