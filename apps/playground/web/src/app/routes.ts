/** The Playground's pages and their paths. The server answers each path with the page. */
export const PAGES = Object.freeze([
  { id: "lab", path: "/", title: "Lab" },
  { id: "bazaar", path: "/bazaar", title: "Bazaar" },
  { id: "sell", path: "/sell", title: "Sell" },
  { id: "agents", path: "/agents", title: "Agents" },
] as const);

export type PageId = (typeof PAGES)[number]["id"];

/** Paths of pages that were folded into others: each goes to its new home, query kept. */
const MOVED: Readonly<Record<string, string>> = { "/pay": "/" };

function normalized(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

/** The page for a path; unknown paths show the lab. */
export function pageFor(pathname: string): PageId {
  const path = normalized(pathname);
  return PAGES.find((page) => page.path === path)?.id ?? "lab";
}

/**
 * Where a moved page's path goes now, with its query (`/pay?url=…` → `/?url=…`); null otherwise. A
 * listing on the old Pay page (`/pay?listing=…`) opens in the Bazaar.
 */
export function movedTo(pathname: string, search: string): string | null {
  const path = normalized(pathname);
  const listing = new URLSearchParams(search).get("listing");
  if (path === "/pay" && listing !== null) return `/bazaar?${new URLSearchParams({ listing }).toString()}`;
  const target = MOVED[path];
  if (target === undefined) return null;
  return search === "" || search === "?" ? target : `${target}${search.startsWith("?") ? "" : "?"}${search}`;
}

/** The browser tab title of a page. */
export function documentTitle(page: PageId): string {
  const entry = PAGES.find((item) => item.id === page);
  return page === "lab" || entry === undefined ? "Rail402 Playground" : `${entry.title} · Rail402 Playground`;
}

/**
 * The Lab's path for a payment mode: `url` fills its URL field (it never pays until Run), and `watch`
 * plays the Bazaar's last payment of that listing step by step.
 */
export function labPath(
  mode: "exact" | "upto",
  options: { readonly url?: string; readonly watch?: string } = {},
): string {
  const params = new URLSearchParams();
  if (mode === "upto") params.set("mode", "upto");
  if (options.url !== undefined) params.set("url", options.url);
  if (options.watch !== undefined) params.set("watch", options.watch);
  const query = params.toString();
  return query === "" ? "/" : `/?${query}`;
}
