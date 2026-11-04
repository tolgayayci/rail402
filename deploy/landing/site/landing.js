/*
 * rail402.dev: the page's animations. One 55 ms tick drives every scene; `frame` turns a tick into the
 * values the page shows, and only values that changed touch the DOM. The HTML already holds the final
 * frame, so the page reads the same without this script, and with reduced motion it stays there.
 */
"use strict";

const ICONS = {
  cloud: "M7 18h10a4 4 0 0 0 0-8 6 6 0 0 0-11.5 1.5A3.5 3.5 0 0 0 7 18z",
  tool: "M14 7l3 3M4 20l8-8M13 4l7 7-3 3-7-7z",
  lang: "M4 6h10M9 4v2c0 5-3 8-5 9M7 10c1 3 4 5 7 6M14 20l4-9 4 9M15.5 17h5",
  pen: "M4 20l4-1 11-11-3-3L5 16zM14 6l3 3",
  meter: "M4 16a8 8 0 0 1 16 0M12 16l4-5",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  star: "M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7z",
};

/** Hero searches: each shows two real Bazaar listings. */
const QUERIES = [
  {
    text: "weather forecast under 1 cent",
    hits: [
      ["tool", "Weather forecast for a city", "MCP tool · forecast · demo.rail402.dev", "0.001"],
      ["cloud", "Current weather for a city", "HTTP GET · demo.rail402.dev/weather", "0.001"],
    ],
  },
  {
    text: "air quality and forecast for my city",
    hits: [
      [
        "cloud",
        "Current air quality index (AQI) for a city",
        "MCP tool · air_quality · demo.rail402.dev",
        "0.001",
      ],
      ["tool", "Weather forecast for a city", "MCP tool · forecast · demo.rail402.dev", "0.001"],
    ],
  },
  {
    text: "translate text or look up a profile",
    hits: [
      ["lang", "Translate a short text into another language", "HTTP · demo.rail402.dev/translate", "0.002"],
      ["user", "Public profile of a user", "HTTP GET · demo.rail402.dev/users/:id", "0.001"],
    ],
  },
  {
    text: "something fun my agent can buy",
    hits: [
      ["pen", "Turns a photo of a pet into a sketch", "HTTP · try-cli-1.onrender.com/sketch", "0.25"],
      [
        "star",
        "A fortune-cookie fortune with six lucky numbers",
        "HTTP · try-cli-jukj.onrender.com/fortune",
        "0.01",
      ],
    ],
  },
  {
    text: "hourly forecast, pay for what you use",
    hits: [
      [
        "meter",
        "Hourly weather forecast for a city, metered",
        "MCP tool · upto · demo.rail402.dev",
        "≤ 0.01",
      ],
      [
        "meter",
        "Daily weather history for a city, metered",
        "HTTP GET · upto · demo.rail402.dev/history",
        "≤ 0.01",
      ],
    ],
  },
];

const RAIL_LOG = [
  ["ASK", "GET https://demo.rail402.dev/weather?city=Istanbul"],
  ["402", "Payment required: 0.0010000 USDC on Stellar, pay to GBSV…ELYP"],
  ["SIGN", "Your wallet signs one authorization. You hold 0 XLM."],
  ["SETTLE", "Rail402 sends it to Stellar and pays the fee · tx b6f035f9…75af"],
  ["200", '{ "city": "Istanbul", "temperature": 21, "conditions": "sunny" }'],
];
const CODE_STEPS = [
  "Point the client at Rail402",
  "Pay on Stellar with the stock scheme",
  "Turn on Bazaar listing",
  "Name the route and its price",
];
const REFUSALS = [
  [
    "invalid_exact_stellar_payload_wrong_asset",
    "400",
    "no",
    "The invoked token contract differs from the required asset.",
  ],
  ["insufficient_funds", "400", "yes", "The payer's token balance is lower than the payment amount."],
  [
    "invalid_exact_stellar_payload_facilitator_is_payer",
    "400",
    "no",
    "The transfer's from address is a facilitator account.",
  ],
];
const PACKAGES = ["sdk", "cli", "mcp", "facilitator", "bazaar", "upto", "errors"];
const TX = "b6f035f9948c43519bcf438e2bba4cee60c08be1eed730974eb78915748075af";

/**
 * The values for one moment. `still` gives every scene's final state, the one the HTML is written with.
 * `t` counts the typing of query `qi` in the hero.
 */
function frame(tick, qi, t, still) {
  const step = (every, n) => (still ? n - 1 : Math.floor(tick / every) % n);
  const cycle = (n) => (still ? n - 1 : tick % n);
  const q = QUERIES[qi];
  const v = {};
  const on = (base, lit) => (lit ? base + " on" : base);

  v.typed = q.text.slice(0, Math.min(t, q.text.length));
  v.shown = t > q.text.length + 4 ? qi : -1;

  const chore = step(16, 12);
  for (let i = 0; i < 5; i++) v["k" + i] = chore > i ? "chore x" : "chore";
  for (let i = 0; i < 4; i++) v["a" + i] = on("s3", chore > i + 5);

  const rs = step(33, 5);
  for (let i = 0; i < 5; i++) v["c" + i] = on("st", i <= rs);
  v.fill = rs * 25 + "%";
  v.packet = ["GET", "402", "SIG", "TX", "200"][rs];
  v.tag = RAIL_LOG[rs][0];
  v.log = RAIL_LOG[rs][1];

  const race = cycle(130);
  v.secs = Math.min(race / 20, 5).toFixed(1);
  v.coinLeft = Math.min(race / 100, 1) * 92 + 4 + "%";
  v.lanePhase = race < 100 ? "on its way" : "final";

  const m = cycle(110);
  const used = m < 70 ? (m / 70) * 0.0042 : 0.0042;
  v.meter = used.toFixed(4);
  v.meterW = (used / 0.01) * 100 + "%";

  const au = step(14, 10);
  for (let i = 0; i < 5; i++) v["f" + i] = on("af", au > i);
  v.f5 = on("auth-f", au > 5);

  const cg = step(36, 4);
  for (let i = 0; i < 4; i++) v["g" + i] = on("cg", cg === i);
  v.gn = String(cg + 1);
  v.gcap = CODE_STEPS[cg];

  const grow = cycle(120) >= 20;
  [
    [0.677, 0.742],
    [0.821, 0.897],
    [0.741, 0.815],
    [0.823, 0.881],
  ].forEach(([base, ours], i) => (v["q" + i] = (grow ? ours : base) * 100 + "%"));

  const chat = step(26, 8);
  for (let i = 0; i < 5; i++) v["m" + i] = on("msg", chat >= i);

  const ub = step(24, 7);
  v.usig = on("sig", ub > 0);
  v.usigt = ub > 0 ? "signed by the buyer · once" : "waiting for the buyer to sign";
  ["good", "info", "bad"].forEach((kind, i) => (v["ue" + i] = on("evr " + kind, ub > i + 1)));

  const bb = step(22, 7);
  const spent = [0, 0.25, 0.5, 0.8, 0.8, 0.8, 0.8][bb];
  v.bleft = (1 - spent).toFixed(2);
  v.bspent = spent.toFixed(2);
  v.bw = spent * 100 + "%";
  ["good", "good", "good", "bad"].forEach((kind, i) => (v["b" + i] = on("evr " + kind, bb > i)));

  const pg = step(30, 5);
  for (let i = 0; i < 4; i++) v["p" + i] = pg === i ? "pg-step on" : pg > i ? "pg-step done" : "pg-step";

  const ec = cycle(150);
  v.hash = TX.slice(0, Math.min(ec * 2, 40)) + (ec * 2 > 40 ? "…" : "");
  v.exc = on("ex-card", ec > 26);

  const [code, status, retry, reason] = REFUSALS[step(60, REFUSALS.length)];
  Object.assign(v, { eCode: code, eStatus: status, eRetry: retry, eRetryC: retry, eReason: reason });

  const pi = step(40, PACKAGES.length);
  const pt = Math.min(cycle(40), PACKAGES[pi].length + 1);
  v.pkg = PACKAGES[pi].slice(0, pt);
  PACKAGES.forEach((_, i) => (v["d" + i] = on("door", pi === i && pt > PACKAGES[pi].length)));
  return v;
}

/** One search result row, built from text only. */
function resultRow([icon, title, where, price]) {
  const svgNs = "http://www.w3.org/2000/svg";
  const row = document.createElement("div");
  row.className = "res";
  const ico = row.appendChild(document.createElement("span"));
  ico.className = "ico";
  const svg = ico.appendChild(document.createElementNS(svgNs, "svg"));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.appendChild(document.createElementNS(svgNs, "path")).setAttribute("d", ICONS[icon]);
  const text = row.appendChild(document.createElement("span"));
  text.appendChild(document.createElement("b")).textContent = title;
  text.appendChild(document.createElement("small")).textContent = where;
  const cost = row.appendChild(document.createElement("span"));
  cost.className = "price";
  cost.append(price);
  cost.appendChild(document.createElement("small")).textContent = " USDC";
  return row;
}

function start() {
  const page = document.querySelector(".l");
  if (!page) return;
  const binds = [];
  for (const [attr, apply] of [
    ["data-text", (el, x) => (el.textContent = x)],
    ["data-cls", (el, x) => (el.className = x)],
    ["data-w", (el, x) => (el.style.width = x)],
    ["data-left", (el, x) => (el.style.left = x)],
  ]) {
    for (const el of page.querySelectorAll("[" + attr + "]"))
      binds.push({ el, key: el.getAttribute(attr), apply, last: null });
  }
  const results = page.querySelector("[data-results]");
  let shownSig = null;

  function show(v) {
    for (const b of binds) {
      const x = v[b.key];
      if (x !== b.last) {
        b.last = x;
        b.apply(b.el, x);
      }
    }
    if (results && v.shown !== shownSig) {
      shownSig = v.shown;
      results.replaceChildren(...(v.shown < 0 ? [] : QUERIES[v.shown].hits.map(resultRow)));
    }
  }

  revealOnScroll(page);
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  let tick = 0;
  let qi = 0;
  let t = 0;
  setInterval(() => {
    if (document.hidden) return;
    tick += 1;
    t += 1;
    if (t > QUERIES[qi].text.length + 40) {
      qi = (qi + 1) % QUERIES.length;
      t = 0;
    }
    show(frame(tick, qi, t, false));
  }, 55);
}

/** A one-time reveal where scroll-driven animations are missing; landing.css handles the rest. */
function revealOnScroll(page) {
  if (!window.IntersectionObserver || (window.CSS && CSS.supports("animation-timeline: view()"))) return;
  page.setAttribute("data-io", "");
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.setAttribute("data-in", "");
          io.unobserve(e.target);
        }
      }
    },
    { threshold: 0.12 },
  );
  for (const el of page.querySelectorAll(".sec, .end")) io.observe(el);
}

if (typeof document !== "undefined") start();
