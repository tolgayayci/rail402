/**
 * The Bazaar's pages of listings: as many rows as fit the list's height on a wide screen (at least
 * 5), a fixed number where the page scrolls instead, and the page a listing is on.
 */
import { useEffect, useState, type RefObject } from "react";

/** Rows per page when the list does not have a height of its own (narrow screens). */
export const FLOW_PAGE_SIZE = 8;
export const MIN_PAGE_SIZE = 5;
export const MAX_PAGE_SIZE = 25;
/** A row's height with its hairline, used before a row has been drawn. */
export const ROW_HEIGHT = 57;

/** Rows that fit a list `height` px tall, rows `rowHeight` px each, within the page size limits. */
export function rowsThatFit(height: number, rowHeight: number): number {
  if (!(height > 0) || !(rowHeight > 0)) return MIN_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(MIN_PAGE_SIZE, Math.floor(height / rowHeight)));
}

/** The number of pages for `count` items, at least one. */
export function pageCount(count: number, size: number): number {
  return Math.max(1, Math.ceil(count / size));
}

/** The page (from 0) that holds the item at `index`. */
export function pageOf(index: number, size: number): number {
  return index < 0 ? 0 : Math.floor(index / size);
}

/** The first and last item numbers (from 1) a page shows, for "Showing 1–7 of 12". */
export function pageRange(
  page: number,
  size: number,
  count: number,
): { readonly from: number; readonly to: number } {
  if (count === 0) return { from: 0, to: 0 };
  const from = page * size + 1;
  return { from, to: Math.min(count, from + size - 1) };
}

/**
 * The page size for the list in `box`: rows that fit its height while the list scrolls inside it
 * (a wide screen), else FLOW_PAGE_SIZE. It follows the window as it resizes.
 */
export function usePageSize(box: RefObject<HTMLElement | null>): number {
  const [size, setSize] = useState(FLOW_PAGE_SIZE);
  useEffect(() => {
    const element = box.current;
    if (element === null) return undefined;
    const measure = (): void => {
      const fixed = getComputedStyle(element).overflowY !== "visible";
      const row = element.querySelector<HTMLElement>(".listing-row:not(.listing-row-ghost)");
      const rowHeight = row === null ? ROW_HEIGHT : row.getBoundingClientRect().height;
      // Without a laid-out height (not drawn yet, or no layout at all) the list flows.
      setSize(
        fixed && element.clientHeight > 0 ? rowsThatFit(element.clientHeight - 2, rowHeight) : FLOW_PAGE_SIZE,
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [box]);
  return size;
}
