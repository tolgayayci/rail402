/**
 * Downloads the pinned embedding model into a directory and verifies every file's SHA-256.
 *
 *   pnpm models:fetch [directory=.models] [model=all-minilm-l6-v2]
 */
import { ensureModel, loadManifest } from "@rail402.dev/search";

const directory = process.argv[2] ?? ".models";
const manifest = await loadManifest(process.argv[3]);
const files = await ensureModel(manifest, directory, { download: true });
console.log(`${manifest.id}@${manifest.revision.slice(0, 12)} verified: ${files.model}, ${files.tokenizer}`);
