/**
 * Writes the interoperability fixtures (`--write`) or checks that the committed ones are exactly what
 * upstream `@x402/extensions` generates today (`--check`, the default; non-zero exit on a mismatch).
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildFixtures, serialize, sha256 } from "./fixtures.ts";

const DIRECTORY = fileURLToPath(new URL("../fixtures/", import.meta.url));

/** The committed files and their contents, generated now. */
export function generatedFiles(): Map<string, string> {
  const files = new Map<string, string>();
  const manifest: Record<string, string> = {};
  for (const fixture of buildFixtures()) {
    const text = serialize(fixture);
    files.set(`${fixture.id}.json`, text);
    manifest[`${fixture.id}.json`] = sha256(text);
  }
  files.set(
    "manifest.json",
    `${JSON.stringify({ generator: "@x402/extensions", files: manifest }, null, 2)}\n`,
  );
  return files;
}

/** The committed files that differ from what is generated now. */
export async function staleFiles(directory = DIRECTORY): Promise<string[]> {
  const stale: string[] = [];
  for (const [name, text] of generatedFiles()) {
    const committed = await readFile(`${directory}${name}`, "utf8").catch(() => undefined);
    if (committed !== text) stale.push(name);
  }
  return stale;
}

async function main(): Promise<void> {
  if (process.argv.includes("--write")) {
    await mkdir(DIRECTORY, { recursive: true });
    for (const [name, text] of generatedFiles()) await writeFile(`${DIRECTORY}${name}`, text);
    process.stdout.write(`wrote ${String(generatedFiles().size)} files to ${DIRECTORY}\n`);
    return;
  }
  const stale = await staleFiles();
  if (stale.length > 0) {
    process.stderr.write(`interop fixtures out of date (run with --write): ${stale.join(", ")}\n`);
    process.exit(1);
  }
  process.stdout.write("interop fixtures match what @x402/extensions generates\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
