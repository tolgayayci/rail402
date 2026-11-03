import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * The Explorer's only stylesheet, script and fonts, served from its own origin under content-hashed
 * names (immutable). Rail402's palette: warm paper neutrals, one orange accent, ink frames, square
 * corners, mono uppercase labels. No style or script is ever inline: the CSP forbids it, so charts and
 * bars are SVG drawn with attributes.
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

const STRIPES =
  "repeating-linear-gradient(45deg, var(--stripe), var(--stripe) 3px, var(--panel) 3px, var(--panel) 6px)";

const CSS = `
${fontFace("Space Grotesk", "300 700", FONTS.head)}
${fontFace("Archivo", "100 900", FONTS.sans)}
${fontFace("JetBrains Mono", "100 800", FONTS.mono)}
:root {
  --page: #e9e9e4; --panel: #f4f4f0; --field: #fbfbf8; --ink: #111111; --muted: #615f58; --soft: #3a3934;
  --line: #c9c9c1; --line-soft: #dcdcd5; --stripe: #dcdcd5; --accent: #ff4d00; --accent-ink: #c43d00;
  --ok: #17663a; --ok-tint: #e5f4ea; --exact: #c43d00; --exact-tint: #fff3ec; --upto: #2457e6; --upto-tint: #eef3ff;
  --warn: #7a5300; --warn-tint: #fff7e0; --danger: #b42318; --danger-tint: #fff4f1;
  --font-head: "Space Grotesk", "Archivo", system-ui, sans-serif;
  --font-sans: "Archivo", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --gutter: 24px;
}
@media (max-width: 760px) { :root { --gutter: 16px; } }
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body { margin: 0; min-height: 100dvh; display: flex; flex-direction: column; background: var(--page); color: var(--ink); font-family: var(--font-sans); font-size: 14px; line-height: 1.45; }
h1, h2, h3 { margin: 0; font-family: var(--font-head); letter-spacing: -0.02em; }
h1 { font-size: 26px; font-weight: 700; line-height: 1.15; }
h2 { font-size: 17px; font-weight: 600; }
h3 { font-size: 15px; font-weight: 600; margin: 16px 0 8px; }
p { margin: 0 0 10px; }
a { color: var(--ink); text-decoration: underline; text-decoration-color: var(--accent); text-decoration-thickness: 1.5px; text-underline-offset: 3px; }
a:hover { color: var(--accent-ink); }
code, pre, .mono { font-family: var(--font-mono); font-size: 13px; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.skip { position: absolute; left: -9999px; }
.skip:focus { left: var(--gutter); top: 8px; background: var(--panel); border: 2px solid var(--ink); padding: 8px 12px; z-index: 10; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.wrap { max-width: 1320px; margin: 0 auto; padding: 0 var(--gutter); }
.muted { color: var(--muted); }
.soft { color: var(--soft); }
.small { font-size: 12px; }
.strong { font-weight: 600; }
.nowrap { white-space: nowrap; }
.full { overflow-wrap: anywhere; word-break: break-all; }
.ellipsis { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.label { font-family: var(--font-mono); font-size: 11px; font-weight: 500; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); }
.eyebrow { font-family: var(--font-mono); font-size: 11px; font-weight: 500; letter-spacing: 0.16em; text-transform: uppercase; color: var(--muted); margin: 0; }

/* header */
header.site { background: var(--panel); border-bottom: 2px solid var(--ink); }
header.site .wrap { min-height: 60px; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 24px; padding-top: 8px; padding-bottom: 8px; }
.logo { display: inline-flex; align-items: center; gap: 10px; text-decoration: none; color: var(--ink); }
.logo .mark { background: var(--accent); color: var(--ink); font: 700 17px var(--font-mono); letter-spacing: 0.02em; padding: 4px 10px; }
.logo .word { font: 500 11px var(--font-mono); letter-spacing: 0.16em; }
nav.main { display: flex; flex-wrap: wrap; flex: 1 1 auto; }
nav.main a { color: var(--muted); padding: 12px 10px; text-decoration: none; font: 500 12px var(--font-mono); letter-spacing: 0.1em; text-transform: uppercase; }
nav.main a:hover { color: var(--ink); }
nav.main a[aria-current="page"] { color: var(--ink); box-shadow: inset 0 -3px 0 var(--accent); }
.netswitch { display: inline-flex; border: 1.5px solid var(--ink); font: 700 11px var(--font-mono); letter-spacing: 0.1em; }
.netswitch a { padding: 8px 12px; color: var(--ink); text-decoration: none; text-transform: uppercase; }
.netswitch a[aria-current="true"] { background: var(--ink); color: var(--panel); }
.netbadge { font: 700 11px var(--font-mono); letter-spacing: 0.1em; background: var(--ink); color: var(--panel); padding: 9px 12px; text-transform: uppercase; }
form.quick { flex: 1 1 260px; display: flex; align-items: center; gap: 8px; height: 40px; border: 1.5px solid var(--ink); padding: 0 4px 0 12px; background: var(--field); }
form.quick input { flex: 1; min-width: 0; border: 0; background: transparent; font: 13px var(--font-mono); color: var(--ink); height: 36px; }
form.quick button { border: 0; background: transparent; padding: 0 8px; height: 36px; cursor: pointer; color: var(--ink); }
.icon { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; flex: 0 0 auto; }
details.menu { display: none; }
details.menu > summary { list-style: none; width: 44px; height: 44px; border: 1.5px solid var(--ink); background: var(--field); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
details.menu > summary::-webkit-details-marker { display: none; }
details.menu .sheet { position: absolute; left: 0; right: 0; top: 100%; background: var(--panel); border-top: 2px solid var(--ink); border-bottom: 2px solid var(--ink); z-index: 20; padding: 8px var(--gutter) 16px; display: flex; flex-direction: column; gap: 4px; }
details.menu .sheet a { padding: 12px 0; font: 600 12px var(--font-mono); letter-spacing: 0.1em; text-transform: uppercase; text-decoration: none; border-bottom: 1px solid var(--line); }
details.menu .sheet a[aria-current="page"], details.menu .sheet a[aria-current="true"] { color: var(--accent-ink); }
details.menu .sheet form.quick { margin-top: 10px; flex: 0 0 auto; }
@media (max-width: 960px) {
  header.site nav.main, header.site .wrap > form.quick, header.site .wrap > .netswitch { display: none; }
  header.site .wrap { position: relative; flex-wrap: nowrap; }
  header.site .netbadge { margin-left: auto; padding: 5px 8px; font-size: 10px; }
  details.menu { display: block; }
  .logo .mark { font-size: 15px; padding: 3px 8px; }
  .logo .word { font-size: 10px; }
}

/* hero search */
.hero { border-bottom: 1.5px solid var(--ink); }
.hero .wrap { padding-top: 40px; padding-bottom: 44px; display: flex; flex-direction: column; gap: 18px; }
.hero .titles { display: flex; flex-direction: column; gap: 6px; }
.hero h1 { font-size: 34px; line-height: 1.1; }
form.big { display: flex; max-width: 900px; border: 2px solid var(--ink); background: var(--field); }
form.big select { border: 0; border-right: 1.5px solid var(--ink); background: var(--page); padding: 0 12px; font: 700 11px var(--font-mono); letter-spacing: 0.1em; color: var(--ink); height: 52px; border-radius: 0; }
form.big input { flex: 1; min-width: 0; border: 0; padding: 0 16px; font: 14px var(--font-mono); color: var(--ink); background: transparent; height: 52px; }
form.big button { border: 0; border-left: 1.5px solid var(--ink); background: var(--accent); color: var(--ink); padding: 0 22px; font: 700 12px var(--font-mono); letter-spacing: 0.1em; cursor: pointer; }
@media (max-width: 760px) {
  .hero .wrap { padding-top: 20px; padding-bottom: 20px; gap: 12px; }
  .hero h1 { font-size: 24px; }
  form.big select { display: none; }
  form.big input { height: 48px; padding: 0 12px; font-size: 13px; }
  form.big button { padding: 0 14px; }
}

/* page body */
main { flex: 1 0 auto; }
main > .wrap { padding-top: 24px; padding-bottom: 64px; display: flex; flex-direction: column; gap: 20px; }
@media (max-width: 760px) { main > .wrap { padding-top: 16px; gap: 16px; } h1 { font-size: 22px; } }
.page-head { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 16px; padding-bottom: 18px; border-bottom: 1.5px solid var(--ink); }
.page-head.split { justify-content: space-between; align-items: flex-end; }
.page-head .titles { display: flex; flex-direction: column; gap: 6px; min-width: 0; flex: 1 1 400px; }
.page-head .line { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.page-head p { margin: 0; }
.page-head .lede { font-size: 16px; }
h1.url { font: 600 22px var(--font-mono); letter-spacing: -0.01em; overflow-wrap: anywhere; }
@media (max-width: 760px) { h1.url { font-size: 16px; } }
.avatar { width: 56px; height: 56px; border: 2px solid var(--ink); background: var(--page); display: flex; align-items: center; justify-content: center; font: 700 16px var(--font-mono); flex: 0 0 auto; }
.avatar.accent, .tile.accent { background: var(--accent); }
.avatar.small { width: 40px; height: 40px; border-width: 1.5px; font-size: 12px; }
.badges { display: flex; flex-wrap: wrap; gap: 6px; }
.badge { display: inline-block; font: 700 10.5px var(--font-mono); letter-spacing: 0.06em; text-transform: uppercase; border: 1.5px solid var(--ink); background: var(--field); color: var(--ink); padding: 1px 7px; white-space: nowrap; vertical-align: middle; }
.badges .badge { padding: 2px 8px; }
.badge.ok { color: var(--ok); background: var(--ok-tint); border-color: var(--ok); }
.badge.exact { color: var(--exact); background: var(--exact-tint); border-color: var(--exact); }
.badge.upto { color: var(--upto); background: var(--upto-tint); border-color: var(--upto); }
.badge.warn, .badge.live, .badge.custom { color: var(--warn); background: var(--warn-tint); border-color: var(--warn); }
.badge.error { color: var(--danger); background: var(--danger-tint); border-color: var(--danger); }
.badge.accent { background: var(--accent); }
.badge.dark { background: var(--ink); color: var(--panel); }
.badge.grey { background: var(--page); }
.badge.stripes, .stripes { background: ${STRIPES}; }

/* panels */
.panel { background: var(--panel); border: 2px solid var(--ink); min-width: 0; }
.panel.live { border-style: dashed; }
.panel.dark { background: var(--ink); color: var(--panel); }
.panel.dark a { color: var(--panel); }
.panel-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px; padding: 14px 20px; border-bottom: 1.5px solid var(--ink); }
.panel.live > .panel-head { border-bottom-style: dashed; }
.panel.dark > .panel-head { border-bottom-color: var(--soft); }
.panel-head .aside { font: 11px var(--font-mono); letter-spacing: 0.06em; color: var(--muted); text-transform: uppercase; }
.panel-body { padding: 14px 20px; }
.panel-body > :last-child { margin-bottom: 0; }
.panel-note { margin: 0; padding: 12px 20px; font-size: 12px; color: var(--muted); }
.panel-note.strong { font-size: 13px; color: var(--ink); }
.panel-note.ok { font-weight: 600; color: var(--ok); }
.panel-foot { display: flex; align-items: center; justify-content: center; min-height: 44px; font: 700 11px var(--font-mono); letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink); background: var(--page); text-decoration: none; margin-top: auto; border-top: 1px solid var(--line); }
.panel.flex { display: flex; flex-direction: column; }
@media (max-width: 760px) { .panel-head { padding: 12px 14px; } .panel-body, .panel-note { padding-left: 14px; padding-right: 14px; } }
.grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 520px), 1fr)); gap: 24px; }
.grid-3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr)); gap: 20px; }
.columns { display: flex; flex-wrap: wrap; gap: 20px; align-items: flex-start; }
.columns > .wide { flex: 3 1 560px; min-width: 0; display: flex; flex-direction: column; gap: 20px; }
.columns > .side { flex: 2 1 340px; min-width: 0; display: flex; flex-direction: column; gap: 20px; }
@media (max-width: 760px) { .grid-2, .grid-3, .columns { gap: 16px; } }

/* stats */
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); }
.stats.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.stat { padding: 16px 20px; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.stat .value { font: 700 24px/1.15 var(--font-head); letter-spacing: -0.02em; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.stat .sub { font-size: 12px; color: var(--muted); }
.pulse { display: flex; flex-wrap: wrap; }
.pulse > .stats { flex: 2 1 520px; }
.pulse .stat { padding: 18px 22px; }
.pulse .stat .value { font-size: 28px; }
.pulse > .chart-box { flex: 1.4 1 360px; padding: 18px 22px; display: flex; flex-direction: column; gap: 10px; border-left: 1.5px solid var(--ink); min-width: 0; }
.chart-box .row { display: flex; justify-content: space-between; gap: 8px; font: 11px var(--font-mono); color: var(--muted); text-transform: uppercase; }
@media (max-width: 760px) {
  .stat, .pulse .stat { padding: 12px 14px; }
  .stat .value, .pulse .stat .value { font-size: 20px; }
  .stat .sub { display: none; }
  .pulse > .chart-box { border-left: 0; padding: 12px 14px; }
  .pulse > .stats { flex-basis: 100%; }
}
svg.chart { width: 100%; height: 120px; display: block; border-bottom: 1.5px solid var(--ink); }
@media (max-width: 760px) { svg.chart { height: 64px; } }
svg.chart rect { fill: var(--ink); }
svg.chart rect.today { fill: var(--accent); }
svg.chart rect.none { fill: var(--line); }
svg.bar { display: block; flex: 1; height: 10px; min-width: 40px; border: 1px solid var(--ink); background: var(--field); }
svg.bar.thin { height: 8px; }
.fill-ink { fill: var(--ink); }
.fill-accent { fill: var(--accent); }
.fill-upto { fill: var(--upto); }
.barline { display: flex; align-items: center; gap: 10px; }
.barline .pct { font: 12px var(--font-mono); min-width: 48px; text-align: right; }
svg.swatch { width: 10px; height: 10px; margin-right: 8px; vertical-align: -1px; }
svg.swatch rect { stroke: var(--ink); stroke-width: 2; }

/* rows of facts */
dl.rows { margin: 0; padding: 6px 20px 12px; }
dl.rows > div { display: flex; flex-wrap: wrap; gap: 2px 16px; padding: 8px 0; border-bottom: 1px solid var(--line-soft); }
dl.rows > div:last-child { border-bottom: 0; }
dl.rows dt { flex: 0 0 170px; font: 500 11px/20px var(--font-mono); letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); }
dl.rows dd { margin: 0; flex: 1 1 260px; min-width: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
dl.rows.group { padding: 8px 22px; border-bottom: 1.5px solid var(--ink); }
dl.rows.group > div { border-bottom: 0; padding: 9px 0; }
dl.rows.group dt { flex-basis: 240px; }
dl.rows.group dd { flex-basis: 420px; }
@media (max-width: 760px) {
  dl.rows, dl.rows.group { padding: 4px 14px 8px; }
  dl.rows > div { flex-direction: column; }
  dl.rows.group > div { border-bottom: 1px solid var(--line); }
  dl.rows dt, dl.rows.group dt { flex-basis: auto; font-size: 10px; }
  dl.rows dd, dl.rows.group dd { flex-basis: auto; }
}

/* tables */
.table-scroll { overflow-x: auto; position: relative; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
thead tr { background: var(--page); }
th { text-align: left; height: 38px; padding: 0 14px; font: 500 10.5px var(--font-mono); letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); border-bottom: 1.5px solid var(--ink); white-space: nowrap; }
td { padding: 11px 14px; border-bottom: 1px solid var(--line); vertical-align: middle; }
th:first-child, td:first-child { padding-left: 20px; }
th:last-child, td:last-child { padding-right: 20px; }
td.num, th.num { text-align: right; }
td.num { font: 13px var(--font-mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
td.arrow { padding: 11px 2px; font: 700 13px var(--font-mono); color: var(--accent-ink); }
td.paidfor { max-width: 280px; }
table.wide { min-width: 1080px; }
table.mid { min-width: 760px; }
@media (min-width: 761px) { table.narrow { min-width: 520px; } }
tr.remainder { background: repeating-linear-gradient(45deg, #e4e4dd, #e4e4dd 3px, var(--panel) 3px, var(--panel) 8px); }
.cell { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.plus { color: var(--ok); }
.minus { color: var(--danger); }

/* lists of payments and services */
.item { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; padding: 12px 20px; border-bottom: 1px solid var(--line); min-width: 0; }
.item .tile { width: 38px; height: 38px; border: 1.5px solid var(--ink); display: flex; align-items: center; justify-content: center; font: 700 10px var(--font-mono); letter-spacing: 0.06em; flex: 0 0 auto; background: var(--page); }
.item .hashcol { flex: 0 0 120px; display: flex; flex-direction: column; }
.item .main { flex: 1 1 220px; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.item .forline { display: flex; align-items: center; gap: 6px; min-width: 0; }
.item .end { margin-left: auto; display: flex; flex-direction: column; align-items: flex-end; }
.item .amount { font: 500 13px var(--font-mono); white-space: nowrap; }
@media (max-width: 760px) {
  .item { padding: 12px 14px; }
  .item .tile { display: none; }
  .item .hashcol { flex: 1 1 auto; }
}

/* segmented controls, filters, pager */
.seg { display: inline-flex; flex-wrap: wrap; border: 1.5px solid var(--ink); font: 700 10.5px var(--font-mono); letter-spacing: 0.1em; text-transform: uppercase; }
.seg a { padding: 5px 10px; color: var(--ink); text-decoration: none; }
.seg a + a { border-left: 1.5px solid var(--ink); }
.seg a[aria-current="true"] { background: var(--ink); color: var(--panel); }
.filters { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1.5px solid var(--ink); }
.filters .seg a { padding: 8px 12px; }
.field { display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 2px 0 10px; border: 1.5px solid var(--ink); background: var(--field); font: 500 10.5px var(--font-mono); letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); }
.field select { border: 0; background: transparent; font: 600 13px var(--font-sans); color: var(--ink); height: 30px; text-transform: none; letter-spacing: 0; border-radius: 0; }
.strip { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 16px; border-bottom: 1px solid var(--line); background: var(--page); font-size: 13px; color: var(--soft); }
.btn { display: inline-flex; align-items: center; justify-content: center; min-height: 38px; padding: 0 14px; border: 1.5px solid var(--ink); background: var(--panel); color: var(--ink); font: 700 11px var(--font-mono); letter-spacing: 0.1em; text-transform: uppercase; text-decoration: none; cursor: pointer; }
.btn.accent { background: var(--accent); }
.btn.on-dark { border-color: var(--panel); background: transparent; color: var(--panel); }
.btn.on-dark.accent { background: var(--accent); border-color: var(--accent); color: var(--ink); }
.btn.small { min-height: 32px; padding: 0 10px; }
.btn[aria-disabled="true"] { border-color: var(--line); color: #8a877f; pointer-events: none; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
.pager { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 20px; padding: 12px 16px; font: 500 11px var(--font-mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
.pager .actions { margin-left: auto; }
@media (max-width: 760px) { .actions.stack { flex-direction: column; width: 100%; } .actions.stack .btn { width: 100%; min-height: 46px; } }

/* sections of a page as tabs */
nav.sections { display: flex; flex-wrap: wrap; border-bottom: 1.5px solid var(--ink); font: 700 11px var(--font-mono); letter-spacing: 0.1em; text-transform: uppercase; }
nav.sections a { padding: 10px 16px; color: var(--muted); text-decoration: none; }
nav.sections a:hover { color: var(--ink); }
nav.sections a[aria-current="true"] { border: 1.5px solid var(--ink); border-bottom: 0; background: var(--panel); color: var(--ink); margin-bottom: -1.5px; box-shadow: inset 0 3px 0 var(--accent); }
@media (max-width: 760px) { nav.sections { border: 1.5px solid var(--ink); overflow-x: auto; flex-wrap: nowrap; } nav.sections a { flex: 1 0 auto; text-align: center; padding: 12px 10px; background: var(--panel); } nav.sections a + a { border-left: 1.5px solid var(--ink); } nav.sections a[aria-current="true"] { background: var(--ink); color: var(--panel); border: 0; margin: 0; box-shadow: none; } }

/* rule checks */
.check { display: flex; gap: 14px; align-items: center; padding: 11px 20px; border-bottom: 1px solid var(--line); }
.check .id { font: 700 11px var(--font-mono); background: var(--ink); color: var(--panel); padding: 2px 6px; flex: 0 0 auto; }
.check .text { flex: 1; min-width: 0; }
.check .read { font: 11px var(--font-mono); color: var(--muted); text-transform: uppercase; white-space: nowrap; }
.check .pass { font: 700 10.5px var(--font-mono); letter-spacing: 0.06em; color: var(--ok); }
@media (max-width: 760px) { .check { padding: 11px 14px; flex-wrap: wrap; } .check .read { display: none; } }

/* paid for, the payment's lead card on phones */
.paid { display: none; }
@media (max-width: 760px) {
  .paid { display: flex; flex-direction: column; gap: 4px; background: var(--ink); color: var(--panel); border: 2px solid var(--ink); padding: 16px; }
  .paid a { color: var(--panel); font: 500 13px var(--font-mono); overflow-wrap: anywhere; }
  .paid .big { font: 700 30px var(--font-head); letter-spacing: -0.02em; margin-top: 8px; color: #ff7a47; }
  .paid .small, .paid .label { color: var(--line); }
}

/* proof strip */
.proof { background: var(--ink); color: var(--panel); border: 2px solid var(--ink); padding: 18px 22px; display: flex; flex-wrap: wrap; align-items: center; gap: 12px 20px; }
.proof h2 { flex: 1 1 260px; }
.proof .rebuild { flex-basis: 100%; margin: 0; font-size: 12px; color: var(--line); display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.proof code { color: var(--panel); overflow-wrap: anywhere; }
.proof button.copy { background: transparent; border-color: var(--panel); color: var(--panel); }

/* code */
pre.code { margin: 0; background: var(--field); border: 1.5px solid var(--ink); padding: 12px 14px; font: 12.5px/1.6 var(--font-mono); overflow-x: auto; white-space: pre; }
pre.code.wrap-lines { white-space: pre-wrap; word-break: break-all; }
pre.dark { margin: 0; background: #1e1e1c; border: 1px solid var(--soft); color: var(--panel); padding: 14px; font: 12.5px/1.6 var(--font-mono); overflow-x: auto; white-space: pre; }
.kv { display: flex; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--line); padding: 6px 0; font: 13px var(--font-mono); }
.kv span:first-child { color: var(--muted); }
.io { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); gap: 16px; padding: 16px 20px 20px; }
.io > div { display: flex; flex-direction: column; gap: 8px; min-width: 0; }

/* tabs: every panel shows without script; the script turns the buttons on */
.tabs { display: flex; flex-direction: column; gap: 12px; padding: 14px 20px 20px; }
.tablist { display: flex; flex-wrap: wrap; align-self: flex-start; border: 1.5px solid var(--panel); font: 700 10.5px var(--font-mono); letter-spacing: 0.1em; }
.tablist[hidden] { display: none; }
.tablist button { border: 0; background: transparent; color: var(--panel); padding: 6px 10px; font: inherit; letter-spacing: inherit; cursor: pointer; text-transform: uppercase; }
.tablist button[aria-selected="true"] { background: var(--accent); color: var(--ink); }
.tabpanel { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.tabpanel[hidden] { display: none; }
.tabpanel h3 { margin: 0; font: 700 10.5px var(--font-mono); letter-spacing: 0.12em; text-transform: uppercase; color: var(--line); }
.tabs.on .tabpanel h3 { display: none; }
.tabpanel .small { color: var(--line); }

/* copy */
button.copy { flex: 0 0 auto; width: 28px; height: 28px; padding: 0; border: 1.5px solid var(--ink); background: var(--field); color: var(--ink); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; vertical-align: middle; }
button.copy[hidden] { display: none; }
button.copy.done { border-color: var(--ok); color: var(--ok); }
button.copy .icon { width: 13px; height: 13px; }
.panel.dark button.copy { background: transparent; border-color: var(--panel); color: var(--panel); }

/* notices */
.notice { border: 1.5px solid var(--warn); background: var(--warn-tint); color: var(--warn); padding: 10px 14px; margin: 0; }
.notice.info { border-color: var(--upto); background: var(--upto-tint); color: var(--upto); }
.notice.error { border-color: var(--danger); background: var(--danger-tint); color: var(--danger); }
.panel > .notice { margin: 14px 20px; }
.empty { padding: 16px 20px; color: var(--muted); margin: 0; }

/* history */
ol.history { margin: 0; padding: 14px 20px; list-style: none; display: flex; flex-direction: column; gap: 12px; }
ol.history li { display: flex; gap: 10px; }
ol.history svg { width: 10px; height: 10px; margin-top: 5px; flex: 0 0 auto; }
ol.history svg rect { stroke: var(--ink); stroke-width: 3; fill: var(--panel); }
ol.history li:first-child svg rect { fill: var(--accent); }

ul.plain { margin: 0; padding: 0 0 0 18px; }
ul.plain li { margin: 4px 0; }
details summary { cursor: pointer; font-weight: 600; }

/* report sections (also in the standalone snapshot) */
.card { background: var(--panel); border: 2px solid var(--ink); padding: 0 20px 16px; min-width: 0; }
.card > h2 { margin: 0 -20px 14px; padding: 14px 20px; border-bottom: 1.5px solid var(--ink); }
.card > h3 { font-family: var(--font-mono); font-size: 11px; font-weight: 500; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); margin: 18px 0 8px; }
.card > p:last-child { margin-bottom: 0; }
.card .table-scroll { margin: 0 -20px; }
.stats.framed { border: 1.5px solid var(--ink); background: var(--field); margin-bottom: 4px; }
.card .notice { margin: 10px 0; }
.badge.verified { color: var(--ok); background: var(--ok-tint); border-color: var(--ok); }
dl.facts { display: grid; grid-template-columns: minmax(140px, 220px) 1fr; gap: 10px 20px; margin: 0; }
dl.facts dt { font: 500 11px/20px var(--font-mono); letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); }
dl.facts dd { margin: 0; min-width: 0; }
@media (max-width: 640px) { dl.facts { grid-template-columns: 1fr; gap: 2px; } dl.facts dd { margin-bottom: 10px; } }
pre.command { margin: 0 0 8px; background: var(--ink); color: var(--panel); padding: 12px 14px; font: 12.5px/1.6 var(--font-mono); overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
figure { margin: 0; }
svg.chart text { fill: var(--muted); font-family: var(--font-mono); font-size: 11px; }
svg.chart .axis { stroke: var(--line); stroke-width: 1; }
svg.chart rect.bar:hover { fill: var(--accent); }
.report-head { display: flex; flex-direction: column; gap: 6px; padding-bottom: 18px; border-bottom: 1.5px solid var(--ink); }

/* footer */
footer.site { background: var(--ink); color: var(--page); margin-top: auto; }
footer.site .wrap { padding-top: 22px; padding-bottom: 22px; display: flex; flex-wrap: wrap; justify-content: space-between; gap: 10px 24px; font-size: 13px; }
footer.site nav { display: flex; flex-wrap: wrap; gap: 8px 20px; font: 500 11px var(--font-mono); letter-spacing: 0.1em; text-transform: uppercase; }
footer.site a { color: var(--page); }
footer.site .versions { flex-basis: 100%; font: 11px var(--font-mono); color: #a9a79f; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
@media print { header.site form, .copy, .netswitch, details.menu { display: none !important; } body { background: #fff; } }
`;

/**
 * Copy buttons and tab sets, both hidden until this script runs, so a page never shows a control that
 * does nothing; filter selects submit their form on change.
 */
const JS = `
document.querySelectorAll("button.copy[data-copy]").forEach(function (button) {
  if (!navigator.clipboard) return;
  button.hidden = false;
  var label = button.getAttribute("aria-label") || "Copy";
  button.addEventListener("click", function () {
    navigator.clipboard.writeText(button.getAttribute("data-copy") || "").then(function () {
      button.classList.add("done");
      button.setAttribute("aria-label", "Copied");
      setTimeout(function () { button.classList.remove("done"); button.setAttribute("aria-label", label); }, 1500);
    });
  });
});
document.querySelectorAll("[data-tabs]").forEach(function (set) {
  var list = set.querySelector("[role=tablist]");
  var buttons = set.querySelectorAll("[data-tab]");
  var panels = set.querySelectorAll("[data-panel]");
  if (list === null || buttons.length === 0) return;
  function show(id) {
    buttons.forEach(function (button) { button.setAttribute("aria-selected", String(button.getAttribute("data-tab") === id)); });
    panels.forEach(function (panel) { panel.hidden = panel.getAttribute("data-panel") !== id; });
  }
  list.hidden = false;
  set.classList.add("on");
  buttons.forEach(function (button) { button.addEventListener("click", function () { show(button.getAttribute("data-tab")); }); });
  show(buttons[0].getAttribute("data-tab"));
});
document.querySelectorAll("form[data-autosubmit] select").forEach(function (select) {
  select.addEventListener("change", function () { if (select.form) select.form.submit(); });
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
