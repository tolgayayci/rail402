/**
 * What the Lab runs: each mode's default target, how a URL the visitor typed becomes an engine
 * request, and how the seller's lane is named. The demo seller's own routes run as the lab scenario
 * (its parameters from the URL's query); any other URL is paid as it is.
 */
import type { PayRequest, PublicConfig, ScenarioRequest } from "../engine/types.ts";
import { SCENARIO_DEFAULTS, type ExperimentId } from "../../../src/shared/lab.ts";
import { displayUrl, hostOf, toAtomic } from "./format.ts";

/** The Lab's three ways to pay. */
export const LAB_MODES = Object.freeze(["exact", "upto", "agent"] as const);
export type LabMode = (typeof LAB_MODES)[number];

export function isLabMode(value: string | null): value is LabMode {
  return value !== null && (LAB_MODES as readonly string[]).includes(value);
}

/** The refusals a visitor can trigger after signing: the same payment sent twice, a seller overcharging. */
export type LabExperiment = Extract<ExperimentId, "replay" | "overcharge">;

function withQuery(base: string, path: string, query: Readonly<Record<string, string>>): string {
  const url = new URL(path, base.endsWith("/") ? base : `${base}/`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.href;
}

/** The demo seller's route a mode pays by default, as an absolute URL. */
export function defaultTarget(mode: Exclude<LabMode, "agent">, config: PublicConfig): string {
  const defaults = mode === "exact" ? SCENARIO_DEFAULTS.pay : SCENARIO_DEFAULTS.upto;
  return withQuery(config.urls.demoSeller, defaults.path, defaults.query);
}

/**
 * The text the URL field starts with: the default target without its scheme when that is https, which
 * a typed URL without a scheme means. An http target (a local demo seller) keeps its scheme, so the
 * field pays exactly the default target.
 */
export function defaultTargetText(mode: Exclude<LabMode, "agent">, config: PublicConfig): string {
  const target = defaultTarget(mode, config);
  return new URL(target).protocol === "https:" ? displayUrl(target) : target;
}

/** What the agent mode's field shows: the tools the scripted agent calls, in order. */
export const AGENT_TARGET_TEXT = "rail402-mcp · search_stellar_resources → pay_and_call";

/** The question the scripted agent answers, from its default tool arguments. */
export function agentPrompt(cap: string, symbol: string): string {
  const { city } = SCENARIO_DEFAULTS.agent.arguments;
  return `What is the air quality in ${city}? Spend at most ${cap} ${symbol}.`;
}

/** The cap the agent mode starts with: the agent's suggested per-call limit, within the ceiling. */
export function agentDefaultCap(config: PublicConfig): string {
  const decimals = config.asset.decimals;
  const suggested = toAtomic(SCENARIO_DEFAULTS.agent.cap, decimals);
  const ceiling = toAtomic(config.caps.perCallCeiling, decimals);
  return suggested !== undefined && ceiling !== undefined && suggested <= ceiling
    ? SCENARIO_DEFAULTS.agent.cap
    : config.caps.perCallDefault;
}

/**
 * A typed URL as an absolute http(s) URL: a missing scheme means https. Undefined when it does not
 * parse, has credentials, or uses another scheme.
 */
export function normalizeTarget(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  if (!URL.canParse(candidate)) return undefined;
  const url = new URL(candidate);
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.username !== "" || url.password !== "" || url.hostname === "") return undefined;
  return url.href;
}

export type LabRequest =
  | { readonly kind: "scenario"; readonly request: ScenarioRequest }
  | { readonly kind: "pay"; readonly request: PayRequest };

/**
 * The engine request for a mode, a URL and a cap. A demo seller route whose query only names the
 * scenario's parameters runs as that scenario; anything else is paid as typed, so what is paid is
 * always exactly the URL shown.
 */
export function labRequest(
  mode: Exclude<LabMode, "agent">,
  url: string,
  cap: string,
  config: PublicConfig,
): LabRequest {
  const parsed = new URL(url);
  const demo = new URL(config.urls.demoSeller);
  for (const [scenario, defaults] of [
    ["pay", SCENARIO_DEFAULTS.pay],
    ["upto", SCENARIO_DEFAULTS.upto],
  ] as const) {
    const known = Object.keys(defaults.query);
    const names = [...parsed.searchParams.keys()];
    const sameRoute =
      parsed.origin === demo.origin &&
      parsed.pathname === new URL(defaults.path, demo).pathname &&
      parsed.hash === "" &&
      names.every((name) => known.includes(name)) &&
      new Set(names).size === names.length;
    if (sameRoute && (scenario === "pay") === (mode === "exact")) {
      const params: Record<string, string> = {};
      for (const [name, value] of parsed.searchParams) params[name] = value;
      return { kind: "scenario", request: { scenario, experiment: "normal", cap, params } };
    }
  }
  return { kind: "pay", request: { target: url, cap } };
}

/** How the seller's lane is named for the URL it serves. */
export interface SellerLane {
  readonly label: string;
  readonly role: string;
  /** The Playground's own demo seller or lab routes, which settle through Rail402. */
  readonly ours: boolean;
}

export function sellerLaneFor(url: string | undefined, config: PublicConfig): SellerLane {
  if (url === undefined || !URL.canParse(url)) return { label: "API", role: "any x402 URL", ours: false };
  const parsed = new URL(url);
  const demo = new URL(config.urls.demoSeller);
  if (parsed.origin === demo.origin) {
    const path = parsed.pathname;
    const label = path.startsWith(SCENARIO_DEFAULTS.pay.path)
      ? "Weather API"
      : path.startsWith(SCENARIO_DEFAULTS.upto.path)
        ? "History API"
        : "Demo API";
    return { label, role: "demo seller", ours: true };
  }
  if (parsed.origin === new URL(config.urls.public).origin) {
    if (parsed.pathname.startsWith(config.lab.paths.greedy))
      return { label: "Greedy API", role: "charges over the cap", ours: true };
    if (Object.values(config.lab.paths.offers).some((path) => parsed.pathname.startsWith(path)))
      return { label: "Test offer", role: "a 402 to refuse", ours: true };
    return { label: "Lab API", role: "this Playground", ours: true };
  }
  return { label: "API", role: hostOf(url), ours: false };
}
