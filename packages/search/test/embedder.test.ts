import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ensureModel, loadManifest, type ModelManifest } from "@rail402.dev/search";

describe("pinned embedding model", () => {
  const directories: string[] = [];
  const directory = async () => {
    const created = await mkdtemp(join(tmpdir(), "rail402-model-"));
    directories.push(created);
    return created;
  };
  afterAll(async () => {
    await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
  });

  /** A manifest pinned to local bytes, so the matching case needs no download. */
  const pinned = (manifest: ModelManifest, model: Buffer, tokenizer: Buffer): ModelManifest => ({
    ...manifest,
    files: {
      model: { ...manifest.files.model, sha256: createHash("sha256").update(model).digest("hex") },
      tokenizer: {
        ...manifest.files.tokenizer,
        sha256: createHash("sha256").update(tokenizer).digest("hex"),
      },
    },
  });

  it("pins the default model to a revision and SHA-256 hashes", async () => {
    const manifest = await loadManifest();
    expect(manifest.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(manifest.files.model.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.files.tokenizer.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses to start when the model files are missing and downloads are off", async () => {
    const manifest = await loadManifest();
    await expect(ensureModel(manifest, await directory(), { download: false })).rejects.toThrow(
      /embedding model file .* is missing/,
    );
  });

  it("refuses to start when a model file does not match its pinned hash", async () => {
    const manifest = await loadManifest();
    const root = await directory();
    await mkdir(join(root, manifest.id));
    await writeFile(join(root, manifest.id, "model.onnx"), "not the pinned model");
    await writeFile(join(root, manifest.id, "tokenizer.json"), "{}");
    await expect(ensureModel(manifest, root, { download: false })).rejects.toThrow(
      new RegExp(`model\\.onnx has sha256 [0-9a-f]{64}, expected ${manifest.files.model.sha256}`),
    );
  });

  it("returns the file paths when every hash matches", async () => {
    const base = await loadManifest();
    const model = Buffer.from("model bytes");
    const tokenizer = Buffer.from("tokenizer bytes");
    const manifest = pinned(base, model, tokenizer);
    const root = await directory();
    await mkdir(join(root, manifest.id));
    await writeFile(join(root, manifest.id, "model.onnx"), model);
    await writeFile(join(root, manifest.id, "tokenizer.json"), tokenizer);
    expect(await ensureModel(manifest, root, { download: false })).toEqual({
      model: join(root, manifest.id, "model.onnx"),
      tokenizer: join(root, manifest.id, "tokenizer.json"),
    });

    await writeFile(join(root, manifest.id, "tokenizer.json"), "tampered");
    await expect(ensureModel(manifest, root, { download: false })).rejects.toThrow(
      /tokenizer\.json has sha256/,
    );
  });
});
