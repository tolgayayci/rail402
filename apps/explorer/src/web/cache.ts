import { createHash } from "node:crypto";

/** What a response shows, which decides how long it may be cached. */
export type CacheKind =
  /** An indexed settlement under the served versions: final on chain, changed only by new rules or a new registry. */
  | "final"
  /** Lists and totals that grow as ledgers are indexed. */
  | "listing"
  /** The report, recomputed every few minutes. */
  | "report"
  /** A live lookup, a not-found answer or an error: never stored. */
  | "volatile";

export interface Versions {
  readonly rules: string;
  readonly registry: string;
}

/**
 * Cache-Control and ETag for a response. An indexed settlement is cached for an hour, never as
 * immutable, and its ETag names the rules and registry versions its row was produced under, so a page
 * rendered under an older version is never mistaken for the current one. Live lookups are never stored.
 */
export function cacheHeaders(
  kind: CacheKind,
  versions: Versions,
  body: string | Uint8Array,
): { readonly "Cache-Control": string; readonly ETag?: string } {
  if (kind === "volatile") return { "Cache-Control": "no-store, no-transform" };
  const digest = createHash("sha256").update(body).digest("base64url").slice(0, 22);
  const etag = `"r${versions.rules}-${versions.registry}-${digest}"`;
  switch (kind) {
    case "final":
      // Never immutable: a registry or rules bump re-attributes the row, and a revalidation must see it.
      return { "Cache-Control": "public, max-age=3600, no-transform", ETag: etag };
    case "listing":
      return { "Cache-Control": "public, max-age=15, no-transform", ETag: etag };
    case "report":
      return { "Cache-Control": "public, max-age=60, no-transform", ETag: etag };
  }
}

/** Whether an If-None-Match header names `etag`. */
export function matchesEtag(header: string | undefined, etag: string | undefined): boolean {
  if (header === undefined || etag === undefined) return false;
  return header
    .split(",")
    .map((part) => part.trim().replace(/^W\//, ""))
    .some((part) => part === etag || part === "*");
}
