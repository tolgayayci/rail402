/**
 * The Bazaar's reads for the page: every listing (all pages of `/discovery/resources`), and a plain
 * words search (`/discovery/search`, its cursor followed for a few pages). Each hook drops a result
 * that arrives after the page asked for something else.
 */
import { useCallback, useEffect, useState } from "react";
import type { ListingView } from "../../engine/events.ts";
import type { CodedError, Engine } from "../../engine/types.ts";
import { toCodedError } from "../engine.tsx";

/** Listings per page read, the Bazaar's largest page. */
export const LIST_PAGE = 100;
/** Most pages the page reads, so a huge catalog cannot keep it loading forever. */
export const LIST_PAGES_MAX = 20;
export const SEARCH_PAGE = 50;
export const SEARCH_PAGES_MAX = 4;
/** Quiet time after typing before the search runs. */
export const SEARCH_DEBOUNCE_MS = 300;

/** Every listing, page after page, in the Bazaar's order. */
export async function readAllListings(engine: Engine): Promise<readonly ListingView[]> {
  const items: ListingView[] = [];
  for (let page = 0; page < LIST_PAGES_MAX; page += 1) {
    const read = await engine.list({ limit: LIST_PAGE, offset: items.length });
    items.push(...read.items);
    if (read.items.length === 0 || items.length >= read.total) break;
  }
  return items;
}

export interface SearchResult {
  readonly items: readonly ListingView[];
  readonly partialResults: boolean;
  readonly method: string | null;
}

/** The ranked results of a query, following the cursor for a few pages. */
export async function searchAll(engine: Engine, query: string): Promise<SearchResult> {
  const items: ListingView[] = [];
  let partialResults = false;
  let method: string | null = null;
  let cursor: string | undefined;
  for (let page = 0; page < SEARCH_PAGES_MAX; page += 1) {
    const read = await engine.search({
      query,
      limit: SEARCH_PAGE,
      ...(cursor === undefined ? {} : { cursor }),
    });
    items.push(...read.items);
    partialResults ||= read.partialResults;
    method ??= read.method;
    if (read.cursor === null || read.items.length === 0) break;
    cursor = read.cursor;
  }
  return { items, partialResults, method };
}

export interface Loaded<T> {
  readonly data: T | null;
  readonly error: CodedError | null;
  readonly busy: boolean;
  readonly reload: () => void;
}

/** Every listing, read once; `reload` reads them again. */
export function useAllListings(engine: Engine): Loaded<readonly ListingView[]> {
  const [data, setData] = useState<readonly ListingView[] | null>(null);
  const [error, setError] = useState<CodedError | null>(null);
  const [busy, setBusy] = useState(true);
  const [round, setRound] = useState(0);
  useEffect(() => {
    let live = true;
    setBusy(true);
    setError(null);
    readAllListings(engine)
      .then(
        (items) => {
          if (live) setData(items);
        },
        (reason: unknown) => {
          if (live) setError(toCodedError(reason));
        },
      )
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [engine, round]);
  const reload = useCallback(() => {
    setRound((current) => current + 1);
  }, []);
  return { data, error, busy, reload };
}

/** The search for a query, after a short quiet time; null data while the query is empty. */
export function useSearch(engine: Engine, query: string): Loaded<SearchResult> {
  const [data, setData] = useState<SearchResult | null>(null);
  const [error, setError] = useState<CodedError | null>(null);
  const [busy, setBusy] = useState(false);
  const [round, setRound] = useState(0);
  const text = query.trim();
  useEffect(() => {
    setError(null);
    if (text === "") {
      setData(null);
      setBusy(false);
      return undefined;
    }
    let live = true;
    setBusy(true);
    const timer = setTimeout(() => {
      searchAll(engine, text)
        .then(
          (result) => {
            if (live) setData(result);
          },
          (reason: unknown) => {
            if (live) setError(toCodedError(reason));
          },
        )
        .finally(() => {
          if (live) setBusy(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [engine, text, round]);
  const reload = useCallback(() => {
    setRound((current) => current + 1);
  }, []);
  return { data, error, busy, reload };
}
