import { randomUUID } from "node:crypto";
import { X402Error } from "@rail402/errors";

/**
 * Session permalinks: a browser posts its activity feed (payments, refusals, receipts — all
 * public information already on the ledger) and gets a stable id anyone can replay read-only.
 * These links are used as evidence in submissions, so an entry must stand alone.
 *
 * In-memory with FIFO eviction: a permalink is a courtesy with a lifetime, not an archive. The
 * response says so (`expiresInSeconds` is an honesty field, not a promise of exactly when).
 */

const MAX_ENTRIES = 500;
const MAX_BYTES = 64 * 1024;

export interface ShareEntry {
  readonly events: unknown[];
  readonly createdAt: number;
}

export function createShareStore({ now = Date.now }: { now?: () => number } = {}) {
  const entries = new Map<string, ShareEntry>();

  function put(events: unknown): { id: string } {
    if (!Array.isArray(events) || events.length === 0) {
      throw new X402Error("playground_invalid_request", {
        reason: "A shared session is a non-empty JSON array of activity events.",
      });
    }
    const size = JSON.stringify(events).length;
    if (size > MAX_BYTES) {
      throw new X402Error("playground_invalid_request", {
        reason: `A shared session is capped at ${MAX_BYTES} bytes of JSON; this one is ${size}.`,
        details: { maxBytes: MAX_BYTES, size },
      });
    }
    while (entries.size >= MAX_ENTRIES) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
    const id = randomUUID();
    entries.set(id, { events, createdAt: now() });
    return { id };
  }

  function get(id: string): ShareEntry {
    const entry = entries.get(id);
    if (!entry) {
      throw new X402Error("playground_share_not_found", { details: { id } });
    }
    return entry;
  }

  return { put, get };
}
