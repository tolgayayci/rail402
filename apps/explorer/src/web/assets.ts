import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * The Explorer's only stylesheet, script and fonts, served from its own origin under content-hashed
 * names (immutable), on the Rail402 design system. No style or script is ever inline: the CSP forbids
 * it, so charts and bars are SVG drawn with attributes.
 */

export interface Asset {
  readonly path: string;
  readonly body: string | Uint8Array<ArrayBuffer>;
  readonly type: string;
}

const hashed = (
  name: string,
  extension: string,
  body: string | Uint8Array<ArrayBuffer>,
  type: string,
): Asset => ({
  path: `/assets/${name}-${createHash("sha256").update(body).digest("hex").slice(0, 12)}.${extension}`,
  body,
  type,
});

const FONT_DIR = new URL("../../fonts/", import.meta.url);
const font = (file: string) =>
  hashed(
    file.replace(/\.woff2$/, ""),
    "woff2",
    new Uint8Array(readFileSync(new URL(file, FONT_DIR))),
    "font/woff2",
  );

export const FONTS = {
  head: font("space-grotesk-latin.woff2"),
  sans: font("archivo-latin.woff2"),
  mono: font("jetbrains-mono-latin.woff2"),
} as const;

/** The three typefaces and their SIL Open Font License texts, served at /fonts/OFL-*.txt. */
export const FONT_FAMILIES: readonly { readonly family: string; readonly licence: Asset }[] = [
  ["Space Grotesk", "OFL-space-grotesk.txt"],
  ["Archivo", "OFL-archivo.txt"],
  ["JetBrains Mono", "OFL-jetbrains-mono.txt"],
].map(([family, file]) => ({
  family: String(family),
  licence: {
    path: `/fonts/${String(file)}`,
    body: readFileSync(new URL(String(file), FONT_DIR), "utf8"),
    type: "text/plain; charset=utf-8",
  },
}));

const fontFace = (family: string, weights: string, asset: Asset) =>
  `@font-face { font-family: "${family}"; font-style: normal; font-weight: ${weights}; font-display: swap; src: url("${asset.path}") format("woff2"); }`;

const STYLE_DIR = new URL("./style/", import.meta.url);
const styleFile = (file: string) => readFileSync(new URL(file, STYLE_DIR), "utf8");

/**
 * The design system's tokens and components, then the Explorer's own layer: the same files the approved
 * design was made from, so pages and design share one source.
 */
const CSS = `
${fontFace("Space Grotesk", "300 700", FONTS.head)}
${fontFace("Archivo", "100 900", FONTS.sans)}
${fontFace("JetBrains Mono", "100 800", FONTS.mono)}
${styleFile("tokens.css")}
${styleFile("components.css")}
${styleFile("explorer.css")}
${styleFile("pages-a.css")}
${styleFile("pages-b.css")}
${styleFile("pages-c.css")}
`;

/**
 * Copy buttons, hidden until this script runs, so a page never shows a control that does nothing; and
 * the search box's live results: `form[data-suggest]` asks `<data-suggest>?q=` for JSON and lists the
 * matches under the box. Every value is set as text, never as markup.
 */
const JS = `
document.querySelectorAll("[data-copy]").forEach(function (button) {
  if (!navigator.clipboard) return;
  button.hidden = false;
  var label = button.getAttribute("aria-label");
  button.addEventListener("click", function () {
    navigator.clipboard.writeText(button.getAttribute("data-copy") || "").then(function () {
      button.classList.add("done");
      if (label) button.setAttribute("aria-label", "Copied");
      setTimeout(function () { button.classList.remove("done"); if (label) button.setAttribute("aria-label", label); }, 1500);
    });
  });
});
document.querySelectorAll("form[data-autosubmit] select").forEach(function (select) {
  select.addEventListener("change", function () { if (select.form) select.form.submit(); });
});
document.querySelectorAll("form[data-suggest]").forEach(function (form) {
  var input = form.querySelector("input[name=q]");
  var url = form.getAttribute("data-suggest");
  if (!input || !url) return;
  var box = document.createElement("div");
  box.className = "sdrop";
  box.id = (input.id || "q") + "-drop";
  box.setAttribute("role", "listbox");
  box.hidden = true;
  form.parentNode.insertBefore(box, form.nextSibling);
  input.setAttribute("aria-controls", box.id);
  input.setAttribute("aria-expanded", "false");
  var timer = 0, seq = 0;
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function icon(d) {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
    var wrap = el("span", "ic");
    wrap.appendChild(svg);
    return wrap;
  }
  function title(item) {
    var b = el("b", item.mono ? "mono" : "");
    var t = String(item.title || ""), m = item.mark;
    if (m && m.length === 2 && m[1] > m[0]) {
      b.appendChild(document.createTextNode(t.slice(0, m[0])));
      b.appendChild(el("mark", "", t.slice(m[0], m[1])));
      b.appendChild(document.createTextNode(t.slice(m[1])));
    } else b.textContent = t;
    return b;
  }
  function show(open) { box.hidden = !open; input.setAttribute("aria-expanded", String(open)); }
  function render(data) {
    box.textContent = "";
    if (!data || data.kind === "empty") {
      if (!data || !data.tries) return show(false);
      box.appendChild(el("div", "sdh", "Try"));
      data.tries.forEach(function (t) {
        var row = el("button", "sdr"); row.type = "button";
        row.appendChild(icon(t.icon)); var sm = el("span", "sm"); sm.appendChild(title(t)); sm.appendChild(el("small", "", t.sub)); row.appendChild(sm);
        row.addEventListener("mousedown", function (e) { e.preventDefault(); input.value = t.q; lookup(); });
        box.appendChild(row);
      });
      return show(true);
    }
    if (data.kind === "short") {
      var s = el("div", "sdn"); s.appendChild(icon(data.icon)); var st = el("span"); st.appendChild(el("b", "", "Keep typing")); st.appendChild(el("small", "", data.hint)); s.appendChild(st); box.appendChild(s);
      return show(true);
    }
    if (data.total === 0) {
      var n = el("div", "sdn"); n.appendChild(icon(data.icon)); var nt = el("span"); nt.appendChild(el("b", "", data.noneTitle)); nt.appendChild(el("small", "", data.noneWhy)); n.appendChild(nt); n.appendChild(el("span", "bdg warn", "not found")); box.appendChild(n);
      var links = el("div", "sdl");
      (data.links || []).forEach(function (l) { var a = el("a", "", l.label); a.href = l.href; links.appendChild(a); });
      box.appendChild(links);
      return show(true);
    }
    data.groups.forEach(function (g) {
      var head = el("div", "sdh", g.label); head.appendChild(el("em", "", g.n)); box.appendChild(head);
      g.items.forEach(function (item) {
        var a = el("a", "sdr"); a.href = item.href; a.setAttribute("role", "option");
        a.appendChild(icon(item.icon));
        var sm = el("span", "sm"); sm.appendChild(title(item)); sm.appendChild(el("small", "", item.sub)); a.appendChild(sm);
        var bl = el("span", "bl2");
        (item.badges || []).forEach(function (bd) { var p = el("span", bd.cls, bd.text); if (bd.scheme) p.setAttribute("data-scheme", bd.scheme); if (/\\bfac\\b/.test(bd.cls)) p.insertBefore(el("i"), p.firstChild); bl.appendChild(p); });
        a.appendChild(bl);
        a.appendChild(el("span", "sr2", item.right));
        box.appendChild(a);
      });
    });
    var all = el("a", "sdf"); all.href = data.searchHref;
    all.appendChild(el("span", "", "See all " + data.total + " results for \\u201c" + data.q + "\\u201d"));
    all.appendChild(el("span", "k", data.kindLabel));
    box.appendChild(all);
    show(true);
  }
  function lookup() {
    var mine = ++seq;
    fetch(url + "?q=" + encodeURIComponent(input.value.trim()), { headers: { accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) { if (mine === seq) render(data); })
      .catch(function () { if (mine === seq) show(false); });
  }
  input.setAttribute("autocomplete", "off");
  input.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(lookup, 120); });
  input.addEventListener("focus", lookup);
  input.addEventListener("blur", function () { setTimeout(function () { show(false); }, 150); });
  input.addEventListener("keydown", function (e) { if (e.key === "Escape") show(false); });
});
`;

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#ff4d00"/><path d="M9 23V9h8a4.5 4.5 0 0 1 0 9H9m7 0 6 5" stroke="#111" stroke-width="3" fill="none"/></svg>`;

export const STYLESHEET = hashed("explorer", "css", CSS.trim(), "text/css; charset=utf-8");
export const SCRIPT = hashed("explorer", "js", JS.trim(), "text/javascript; charset=utf-8");
export const FAVICON_ASSET: Asset = { path: "/favicon.svg", body: FAVICON, type: "image/svg+xml" };
export const ASSETS: readonly Asset[] = [STYLESHEET, SCRIPT, FONTS.head, FONTS.sans, FONTS.mono];
export const LICENCE_ASSETS: readonly Asset[] = FONT_FAMILIES.map((entry) => entry.licence);

/** The stylesheet's text, for a standalone snapshot page that has no server behind it. */
export const STYLESHEET_TEXT = CSS.trim();
