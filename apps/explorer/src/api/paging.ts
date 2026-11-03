import { createHash } from "node:crypto";
import { errorFactory } from "@rail402.dev/errors";
import { explorerCodes } from "./codes.ts";

export const explorerError = errorFactory(explorerCodes);

/** Largest page any list returns. */
export const MAX_LIMIT = 100;
export const DEFAULT_LIMIT = 25;

/** A position in a list ordered newest first by (ledger, txIndex). */
export interface Position {
  readonly ledger: number;
  readonly txIndex: number;
}

/** The next page starts strictly after this position, in the list named by `list`. */
export interface Keyset {
  readonly after: Position | undefined;
  readonly limit: number;
}

const tagOf = (list: string) => createHash("sha256").update(list).digest("hex").slice(0, 10);

/**
 * The cursor of the page after `position`: the position plus a tag of the list it belongs to, so a
 * cursor taken from one account or filter is refused on another. It carries no secret and no offset.
 */
export function encodeCursor(list: string, position: Position): string {
  return `${String(position.ledger)}-${String(position.txIndex)}-${tagOf(list)}`;
}

const CURSOR = /^(\d{1,10})-(\d{1,9})-([0-9a-f]{10})$/;

/**
 * Reads the paging parameters of a list request: keyset only. `limit` is 1 to 100 (default 25),
 * `offset` is refused, and so is any parameter not in `allowed`, so a filter on an unindexed column can
 * never reach the database.
 */
export function keyset(
  list: string,
  query: Readonly<Record<string, string | undefined>>,
  allowed: readonly string[] = [],
): Keyset {
  for (const name of Object.keys(query)) {
    if (name === "offset" || name === "page") {
      throw explorerError("explorer_offset_unsupported");
    }
    if (name !== "cursor" && name !== "limit" && !allowed.includes(name)) {
      throw explorerError("explorer_invalid_parameter", {
        reason: `Unknown query parameter ${JSON.stringify(name.slice(0, 40))}.`,
      });
    }
  }
  let limit = DEFAULT_LIMIT;
  const rawLimit = query["limit"];
  if (rawLimit !== undefined) {
    if (!/^\d{1,4}$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > MAX_LIMIT) {
      throw explorerError("explorer_invalid_limit");
    }
    limit = Number(rawLimit);
  }
  const rawCursor = query["cursor"];
  if (rawCursor === undefined || rawCursor === "") return { after: undefined, limit };
  const match = CURSOR.exec(rawCursor);
  if (match === null || match[3] !== tagOf(list)) throw explorerError("explorer_invalid_cursor");
  const ledger = Number(match[1]);
  const txIndex = Number(match[2]);
  if (ledger < 1 || ledger > 0xffffffff) throw explorerError("explorer_invalid_cursor");
  return { after: { ledger, txIndex }, limit };
}
