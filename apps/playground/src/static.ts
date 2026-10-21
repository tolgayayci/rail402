import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

/** Routes the single-page app answers with index.html. */
export const SPA_ROUTES: readonly string[] = Object.freeze(["/", "/bazaar", "/sell", "/agents"]);

/** Page routes that moved into another page: a permanent redirect there, query kept. */
export const MOVED_ROUTES: Readonly<Record<string, string>> = Object.freeze({ "/pay": "/" });

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

/** Largest built page the server holds in memory; a larger build is a mistake to stop on. */
const MAX_TOTAL_BYTES = 32 * 1_048_576;

export interface StaticFile {
  readonly body: Uint8Array;
  readonly type: string;
  readonly etag: string;
  readonly cacheControl: string;
}

/**
 * The built page (web/dist), loaded into memory once at startup. Files are looked up by exact path,
 * so no request path ever reaches the file system. Hashed files under /assets/ are immutable;
 * everything else, index.html included, is revalidated on every load.
 */
export class StaticSite {
  private readonly files = new Map<string, StaticFile>();

  constructor(root: string) {
    let total = 0;
    for (const path of walk(root)) {
      const type = TYPES[extname(path).toLowerCase()];
      if (type === undefined) continue;
      const body = readFileSync(path);
      total += body.byteLength;
      if (total > MAX_TOTAL_BYTES) throw new Error(`the built page in ${root} is larger than 32 MiB`);
      const url = `/${relative(root, path).split(sep).join("/")}`;
      this.files.set(url, {
        body,
        type,
        etag: `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`,
        cacheControl: url.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
      });
    }
  }

  /** Whether the page is built (index.html present). */
  get ready(): boolean {
    return this.files.has("/index.html");
  }

  /** The file for a request path; SPA routes resolve to index.html. */
  lookup(path: string): StaticFile | undefined {
    if (SPA_ROUTES.includes(path)) return this.files.get("/index.html");
    if (path === "/index.html") return undefined;
    return this.files.get(path);
  }
}

function walk(root: string): string[] {
  let names: string[];
  try {
    if (!statSync(root).isDirectory()) return [];
    names = readdirSync(root, { recursive: true, encoding: "utf8" });
  } catch {
    return [];
  }
  return names.map((name) => join(root, name)).filter((path) => statSync(path).isFile());
}
