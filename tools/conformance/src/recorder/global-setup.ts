/**
 * Vitest global setup: gives each test project a fresh directory for the per-file code records, and
 * after the run merges every project's records into `.work/codes-coverage.json`. `pnpm codes:coverage`
 * compares that file with the code registry.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    codesCoverageDir: string;
  }
}

const ROOT = join(import.meta.dirname, "../../../..");
export const COVERAGE_DIR = join(ROOT, ".work", "codes-coverage");
export const COVERAGE_FILE = join(ROOT, ".work", "codes-coverage.json");

export default function setup(project: TestProject): () => void {
  const directory = join(COVERAGE_DIR, project.name);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  project.provide("codesCoverageDir", directory);
  return () => {
    writeFileSync(COVERAGE_FILE, `${JSON.stringify({ projects: exercisedByProject() }, null, 2)}\n`);
  };
}

/** The codes each project's last run exercised. */
export function exercisedByProject(): Record<string, string[]> {
  const projects: Record<string, string[]> = {};
  for (const name of readdirSync(COVERAGE_DIR).sort()) {
    const codes = new Set<string>();
    for (const file of readdirSync(join(COVERAGE_DIR, name))) {
      for (const code of JSON.parse(readFileSync(join(COVERAGE_DIR, name, file), "utf8")) as string[]) {
        codes.add(code);
      }
    }
    projects[name] = [...codes].sort();
  }
  return projects;
}
