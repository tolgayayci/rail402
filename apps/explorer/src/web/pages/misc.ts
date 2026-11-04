import { h, type Child, type LayoutOptions } from "../components.ts";
import { stellarExpertTx } from "../format.ts";
import { displayText } from "../text.ts";
import { DOCS_URL, bdg, iconBox, miniCard, page } from "../ui.ts";

type Base = Omit<LayoutOptions, "title" | "path" | "section">;

/** The error page: one card with the reason, a word for the state, and where to go next. */
export function errorPage(
  options: Base & { readonly path: string },
  status: number,
  _code: string,
  reason: string,
  extra?: Child,
): string {
  const view = options.view;
  const p = view.prefix;
  const state =
    status === 404
      ? (["Nothing here", "not found", "warn"] as const)
      : status === 429
        ? (["Slow down", "rate limited", "warn"] as const)
        : status === 400
          ? (["Check the address", "invalid", "warn"] as const)
          : status === 405
            ? (["Not allowed", "not allowed", "warn"] as const)
            : (["Try again shortly", "unavailable", "info"] as const);
  // A transaction hash that is not found: offer stellar.expert and the other network.
  const hash = /^\/tx\/([0-9a-f]{64})$/.exec(options.path)?.[1];
  const other = options.networks.find((entry) => entry.network !== view.network);
  const payments = miniCard(`${p}/payments`, "payments", "Payments", "the newest settlements");
  const links =
    hash !== undefined
      ? [
          miniCard(
            stellarExpertTx(view, hash),
            "external",
            "Open in stellar.expert",
            `the hash on ${view.label.toLowerCase()}`,
          ),
          other === undefined
            ? null
            : miniCard(
                `${other.prefix}/tx/${hash}`,
                "globe",
                `Try ${other.label.toLowerCase()}`,
                "the same hash there",
              ),
          payments,
        ]
      : [
          miniCard(p === "" ? "/" : p, "overview", "Overview", `x402 on ${view.label.toLowerCase()}`),
          payments,
          miniCard(DOCS_URL, "info", "How it works", "how payments are counted"),
        ];
  return page(
    { ...options, title: state[0] },
    h(
      "section",
      { class: "card nf oa-b-err" },
      h(
        "div",
        { class: "nfh" },
        iconBox(status === 404 ? "search" : "alert"),
        h("div", null, h("h1", { class: "oa-b-h" }, state[0]), h("p", null, displayText(reason, 300))),
        bdg(`${state[1]} · ${String(status)}`, state[2]),
      ),
      extra ?? null,
      h("div", { class: "g3 oa-b-links" }, ...links),
    ),
  );
}
