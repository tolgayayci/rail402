/**
 * Client-side navigation between the Playground's pages: history API only, no router library. The
 * server answers every page path with the same document, so a reload lands on the same page.
 */
import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent, type ReactElement } from "react";

const CHANGE = "rail402:navigate";

function subscribe(listener: () => void): () => void {
  window.addEventListener("popstate", listener);
  window.addEventListener(CHANGE, listener);
  return () => {
    window.removeEventListener("popstate", listener);
    window.removeEventListener(CHANGE, listener);
  };
}

const snapshot = (): string => `${window.location.pathname}${window.location.search}`;

/** The current path and query, updated on navigation and on back/forward. */
export function useLocation(): { readonly pathname: string; readonly search: URLSearchParams } {
  const value = useSyncExternalStore(subscribe, snapshot, snapshot);
  const url = new URL(value, "http://page.invalid");
  return { pathname: url.pathname, search: url.searchParams };
}

/** Goes to a same-origin path such as `/bazaar` or `/?mode=upto`. */
export function navigate(to: string, options: { readonly replace?: boolean } = {}): void {
  if (snapshot() === to) return;
  if (options.replace === true) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);
  window.dispatchEvent(new Event(CHANGE));
  if (options.replace !== true) window.scrollTo({ top: 0 });
}

/** A link to a page of the Playground; a plain click navigates without reloading. */
export function Link({
  to,
  onClick,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { readonly to: string }): ReactElement {
  const handle = (event: MouseEvent<HTMLAnchorElement>): void => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    navigate(to);
  };
  return <a {...props} href={to} onClick={handle} />;
}
