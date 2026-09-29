import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { Tokenizer as UntypedTokenizer } from "@huggingface/tokenizers";
import * as ort from "onnxruntime-node";

/** A pinned embedding model: exact revision and file hashes, so every deployment embeds identically. */
export interface ModelManifest {
  readonly id: string;
  readonly repository: string;
  readonly revision: string;
  readonly license: string;
  readonly files: {
    readonly model: { readonly path: string; readonly sha256: string };
    readonly tokenizer: { readonly path: string; readonly sha256: string };
  };
  readonly dimensions: number;
  readonly pooling: "mean" | "cls";
  readonly normalize: boolean;
  readonly maxTokens: number;
}

export interface Embedder {
  /** Model id; embeddings from different models are never mixed. */
  readonly id: string;
  readonly dimensions: number;
  embed(text: string): Promise<Float32Array>;
}

export const DEFAULT_MODEL = "all-minilm-l6-v2";

/**
 * The part of @huggingface/tokenizers used here. The package's declaration files use extensionless
 * relative imports that do not resolve under NodeNext, so its own types are unavailable.
 */
interface Tokenizer {
  encode(text: string): { ids: number[]; attention_mask: number[] };
}
const TokenizerClass = UntypedTokenizer as unknown as new (json: object, config: object) => Tokenizer;

export async function loadManifest(name = DEFAULT_MODEL): Promise<ModelManifest> {
  const text = await readFile(new URL(`../models/${name}.json`, import.meta.url), "utf8");
  return JSON.parse(text) as ModelManifest;
}

export interface ModelFiles {
  readonly model: string;
  readonly tokenizer: string;
}

/**
 * Locates the model's files under `directory/<id>/`, downloading them from the pinned revision when
 * `download` is set. Every file is checked against its manifest hash; a mismatch is fatal.
 */
export async function ensureModel(
  manifest: ModelManifest,
  directory: string,
  options: { download: boolean },
): Promise<ModelFiles> {
  const folder = join(directory, manifest.id);
  await mkdir(folder, { recursive: true });
  const resolve = async (file: { path: string; sha256: string }) => {
    const target = join(folder, basename(file.path));
    let bytes: Buffer | undefined;
    try {
      bytes = await readFile(target);
    } catch {
      if (!options.download) {
        throw new Error(`embedding model file ${target} is missing; fetch it or enable downloads`);
      }
      const url = `https://huggingface.co/${manifest.repository}/resolve/${manifest.revision}/${file.path}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`downloading ${url} failed: HTTP ${String(response.status)}`);
      bytes = Buffer.from(await response.arrayBuffer());
      verify(bytes, file.sha256, url);
      await writeFile(`${target}.partial`, bytes);
      await rename(`${target}.partial`, target);
    }
    verify(bytes, file.sha256, target);
    return target;
  };
  return { model: await resolve(manifest.files.model), tokenizer: await resolve(manifest.files.tokenizer) };
}

function verify(bytes: Buffer, sha256: string, source: string): void {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== sha256) throw new Error(`${source} has sha256 ${actual}, expected ${sha256}`);
}

/**
 * Sentence embeddings with ONNX Runtime on the CPU. One text per run, single-threaded: batching and
 * thread counts can change floating-point results, and search evaluation must reproduce exactly.
 */
export class OnnxEmbedder implements Embedder {
  readonly id: string;
  readonly dimensions: number;
  private readonly manifest: ModelManifest;
  private readonly session: ort.InferenceSession;
  private readonly tokenizer: Tokenizer;

  private constructor(manifest: ModelManifest, session: ort.InferenceSession, tokenizer: Tokenizer) {
    this.manifest = manifest;
    this.id = manifest.id;
    this.dimensions = manifest.dimensions;
    this.session = session;
    this.tokenizer = tokenizer;
  }

  static async load(manifest: ModelManifest, files: ModelFiles): Promise<OnnxEmbedder> {
    const session = await ort.InferenceSession.create(files.model, {
      executionProviders: ["cpu"],
      intraOpNumThreads: 1,
      interOpNumThreads: 1,
      graphOptimizationLevel: "all",
    });
    const tokenizerJson = JSON.parse(await readFile(files.tokenizer, "utf8")) as object;
    return new OnnxEmbedder(manifest, session, new TokenizerClass(tokenizerJson, {}));
  }

  async embed(text: string): Promise<Float32Array> {
    const encoded = this.tokenizer.encode(text);
    let ids = encoded.ids;
    let mask = encoded.attention_mask;
    const max = this.manifest.maxTokens;
    if (ids.length > max) {
      // Keep the closing special token so the sequence stays well-formed.
      ids = [...ids.slice(0, max - 1), ids[ids.length - 1] ?? 0];
      mask = mask.slice(0, max);
    }
    const length = ids.length;
    const feeds: Record<string, ort.Tensor> = {};
    const tensor = (values: readonly number[]) =>
      new ort.Tensor(
        "int64",
        BigInt64Array.from(values, (value) => BigInt(value)),
        [1, length],
      );
    for (const name of this.session.inputNames) {
      if (name === "input_ids") feeds[name] = tensor(ids);
      else if (name === "attention_mask") feeds[name] = tensor(mask);
      else if (name === "token_type_ids") feeds[name] = tensor(new Array<number>(length).fill(0));
    }
    const outputs = await this.session.run(feeds);
    const output = outputs[this.session.outputNames[0] ?? ""];
    if (output === undefined) throw new Error("embedding model produced no output");
    const hidden = output.data as Float32Array;
    const vector = new Float32Array(this.dimensions);

    if (this.manifest.pooling === "cls") {
      vector.set(hidden.subarray(0, this.dimensions));
    } else {
      let count = 0;
      for (let token = 0; token < length; token++) {
        if (mask[token] !== 1) continue;
        count++;
        const offset = token * this.dimensions;
        for (let dim = 0; dim < this.dimensions; dim++)
          vector[dim] = (vector[dim] ?? 0) + (hidden[offset + dim] ?? 0);
      }
      for (let dim = 0; dim < this.dimensions; dim++) vector[dim] = (vector[dim] ?? 0) / Math.max(count, 1);
    }
    return this.manifest.normalize ? normalize(vector) : vector;
  }
}

export function normalize(vector: Float32Array): Float32Array {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm === 0) return vector;
  for (let i = 0; i < vector.length; i++) vector[i] = (vector[i] ?? 0) / norm;
  return vector;
}

/** Cosine similarity of two L2-normalised vectors. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}
