/** The Playground's pages and their paths. The server answers each path with the page. */
export const PAGES = Object.freeze([
  { id: "lab", path: "/", title: "Playground" },
  { id: "pay", path: "/pay", title: "Pay" },
  { id: "sell", path: "/sell", title: "Sell" },
  { id: "agents", path: "/agents", title: "Agents" },
  { id: "bazaar", path: "/bazaar", title: "Bazaar" },
] as const);

export type PageId = (typeof PAGES)[number]["id"];

/** The page for a path; unknown paths show the lab. */
export function pageFor(pathname: string): PageId {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return PAGES.find((page) => page.path === path)?.id ?? "lab";
}

/** The browser tab title of a page. */
export function documentTitle(page: PageId): string {
  const entry = PAGES.find((item) => item.id === page);
  return page === "lab" || entry === undefined ? "Rail402 Playground" : `${entry.title} · Rail402 Playground`;
}
