import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Serve the x402-stellar Agent Skill over HTTP so the playground URL is itself an install point:
 * an agent (or a human) fetches `GET /skill` for SKILL.md and `GET /skill/<relative path>` for the
 * reference files and starter scripts.
 *
 * Static by design: the whole directory is read once (lazily) into a map keyed by relative path,
 * and requests are served ONLY from map keys — no filesystem access at request time, so no
 * traversal surface. §3.8c: the skill ships in-repo and from this endpoint only; publishing it
 * anywhere external is gated on explicit human approval.
 */

/** `<repo>/apps/playground/skill`, from both `src/server/` and `dist/server/`. */
export const DEFAULT_SKILL_DIR = fileURLToPath(new URL("../../skill", import.meta.url));

export interface SkillFile {
  readonly content: string;
  readonly contentType: string;
}

const CONTENT_TYPES: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
};

/** Load every servable skill file. Missing directory ⇒ empty map (the routes 404 with a reason). */
export function loadSkillFiles(skillDir: string): ReadonlyMap<string, SkillFile> {
  const files = new Map<string, SkillFile>();
  const walk = (relative: string) => {
    let entries;
    try {
      entries = readdirSync(join(skillDir, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(rel);
        continue;
      }
      const ext = entry.name.slice(entry.name.lastIndexOf("."));
      const contentType = CONTENT_TYPES[ext];
      if (!contentType) continue;
      files.set(rel, { content: readFileSync(join(skillDir, rel), "utf8"), contentType });
    }
  };
  walk("");
  return files;
}
