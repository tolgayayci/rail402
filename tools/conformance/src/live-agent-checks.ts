/**
 * Checks shared by the live agent run and its tests: whether stellar.expert has indexed a
 * transaction, and what a live-agent evidence document must contain beyond the common schema.
 */
import type { Evidence } from "./evidence.ts";

export const STELLAR_EXPERT_API = "https://api.stellar.expert/explorer";

export interface ExplorerCheck {
  readonly hash: string;
  readonly explorerUrl: string;
  /** The HTTP status of the stellar.expert API for the transaction (200 once indexed). */
  readonly apiStatus: number;
  /** The ledger stellar.expert reports; set with a 200 whose hash matches. */
  readonly ledger?: number;
  readonly attempts: number;
}

/**
 * Asks the stellar.expert API for a transaction until it answers 200 with the same hash, or
 * `timeoutMs` passes: the explorer indexes a few seconds behind the network. The web page answers
 * 200 for any path, so only the API proves the transaction is there.
 */
export async function checkStellarExpert(
  hash: string,
  options: {
    readonly network?: "testnet" | "public";
    readonly timeoutMs?: number;
    readonly intervalMs?: number;
    readonly fetch?: typeof fetch;
  } = {},
): Promise<ExplorerCheck> {
  const network = options.network ?? "testnet";
  const get = options.fetch ?? fetch;
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  const explorerUrl = `https://stellar.expert/explorer/${network}/tx/${hash}`;
  let attempts = 0;
  let apiStatus: number;
  for (;;) {
    attempts++;
    try {
      const response = await get(`${STELLAR_EXPERT_API}/${network}/tx/${hash}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      apiStatus = response.status;
      if (response.ok) {
        const body = (await response.json()) as { hash?: unknown; ledger?: unknown };
        if (body.hash === hash && typeof body.ledger === "number") {
          return { hash, explorerUrl, apiStatus, ledger: body.ledger, attempts };
        }
        apiStatus = 0;
      }
    } catch {
      apiStatus = 0;
    }
    if (Date.now() >= deadline) return { hash, explorerUrl, apiStatus, attempts };
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 3_000));
  }
}

/** A client surface a live agent case pays or is refused through. */
export const AGENT_SURFACES = ["sdk", "mcp-server", "cli"] as const;
export type AgentSurface = (typeof AGENT_SURFACES)[number];

/**
 * The refusals every agent surface must give before signing: a network, asset, recipient or amount
 * outside the policy, a price above the per-call cap, and one above what is left of the session.
 */
export const SURFACE_REFUSALS = [
  "payment_network_not_permitted",
  "payment_asset_not_permitted",
  "payment_recipient_not_permitted",
  "payment_amount_not_permitted",
  "payment_per_call_cap_exceeded",
  "payment_session_cap_exceeded",
] as const;

/**
 * What a live-agent document must show beyond the common rules: every transaction has an explorer
 * link and a stellar.expert API status of 200, an HTTP API and an MCP tool were each cataloged (the
 * `cataloging` observation: first cataloging time, and version 1's settlement transaction, found in
 * stellar.expert), found by search and paid, every agent surface paid, refusals moved nothing, every surface gave
 * every refusal of SURFACE_REFUSALS with its payment events showing the refusal and no signature
 * (the `signing` observation), and the secret scan found nothing.
 */
export function liveAgentProblems(evidence: Evidence): string[] {
  const problems: string[] = [];
  if (evidence.kind !== "live-agent") problems.push(`kind is ${evidence.kind}, not live-agent`);
  const explorer = new Map<string, number>();
  const checked = evidence.cases.find((entry) => entry.id === "explorer")?.observations?.["transactions"];
  for (const item of Array.isArray(checked) ? (checked as { hash?: unknown; apiStatus?: unknown }[]) : []) {
    if (typeof item.hash === "string" && typeof item.apiStatus === "number") {
      explorer.set(item.hash, item.apiStatus);
    }
  }
  const surfaces = new Set<string>();
  const kinds = new Set<string>();
  const cataloged = new Set<string>();
  const unsigned = new Set<string>();
  for (const entry of evidence.cases) {
    for (const transaction of entry.transactions ?? []) {
      if (!transaction.explorer.endsWith(`/tx/${transaction.hash}`)) {
        problems.push(`${entry.id}: ${transaction.hash} has no matching explorer link`);
      }
      const status = explorer.get(transaction.hash);
      if (status !== 200) {
        problems.push(
          `${entry.id}: stellar.expert answered ${status === undefined ? "nothing" : String(status)} for ${transaction.hash}`,
        );
      }
    }
    const surface = entry.observations?.["surface"];
    if (typeof surface === "string" && (entry.transactions?.length ?? 0) > 0 && entry.status === "passed") {
      surfaces.add(surface);
    }
    const kind = entry.observations?.["resourceType"];
    if (
      typeof kind === "string" &&
      entry.observations?.["listingId"] !== undefined &&
      entry.status === "passed"
    ) {
      kinds.add(kind);
    }
    const cataloging = entry.observations?.["cataloging"] as
      | {
          catalogedBy?: unknown;
          firstCataloged?: unknown;
          versions?: { cause?: unknown; transaction?: unknown }[];
        }
      | undefined;
    if (cataloging !== undefined) {
      const [first] = Array.isArray(cataloging.versions) ? cataloging.versions : [];
      const by = cataloging.catalogedBy;
      if (typeof by !== "string" || first?.cause !== "settlement" || first.transaction !== by) {
        problems.push(`${entry.id}: the cataloging record does not name the settlement of version 1`);
      } else if (typeof cataloging.firstCataloged !== "string") {
        problems.push(`${entry.id}: the cataloging record has no first cataloging time`);
      } else if (explorer.get(by) !== 200) {
        problems.push(`${entry.id}: the cataloging transaction ${by} was not found in stellar.expert`);
      } else if (typeof kind === "string" && entry.status === "passed") {
        cataloged.add(kind);
      }
    }
    for (const rejection of entry.rejections ?? []) {
      if (entry.observations?.["balancesUnchanged"] !== true) {
        problems.push(`${entry.id}: refusal ${rejection.code} does not prove the balances unchanged`);
      }
    }
    const signing = entry.observations?.["signing"];
    for (const record of Array.isArray(signing) ? (signing as Record<string, unknown>[]) : []) {
      const { surface, code, signedEvents, refusedEvents } = record;
      if (typeof surface !== "string" || typeof code !== "string") continue;
      if (signedEvents !== 0) {
        problems.push(`${entry.id}: ${surface} signed during the refusal ${code}`);
      } else if (!Array.isArray(refusedEvents) || !refusedEvents.includes(code)) {
        problems.push(`${entry.id}: ${surface} emitted no refused event for ${code}`);
      } else if (entry.status === "passed") {
        unsigned.add(`${surface} ${code}`);
      }
    }
  }
  for (const surface of AGENT_SURFACES) {
    if (!surfaces.has(surface)) problems.push(`no passed payment through the ${surface}`);
  }
  for (const surface of AGENT_SURFACES) {
    // Each refusal of SURFACE_REFUSALS, with events proving nothing was signed.
    const missing = SURFACE_REFUSALS.filter((code) => !unsigned.has(`${surface} ${code}`));
    if (missing.length > 0) {
      problems.push(`the ${surface} has no refusal shown before signing for ${missing.join(", ")}`);
    }
  }
  for (const kind of ["http", "mcp"]) {
    if (!kinds.has(kind)) problems.push(`no ${kind} resource was cataloged and paid through its listing`);
    if (!cataloged.has(kind)) problems.push(`no ${kind} listing records how it was cataloged`);
  }
  const scan = evidence.cases.find((entry) => entry.id === "secret-scan");
  const result = scan?.observations?.["secretScan"] as
    { channels?: unknown; needles?: unknown; hits?: unknown } | undefined;
  if (scan?.status !== "passed" || result === undefined) {
    problems.push("the secret scan did not pass");
  } else if (
    result.hits !== 0 ||
    typeof result.channels !== "number" ||
    result.channels < 1 ||
    typeof result.needles !== "number" ||
    result.needles < 1
  ) {
    problems.push(`the secret scan is not clean: ${JSON.stringify(result)}`);
  }
  return problems;
}

/** The parts of an npm `package-lock.json` (lockfile version 2 or 3) a registry install is checked by. */
export interface RegistryLock {
  readonly packages?: Record<
    string,
    { readonly version?: string; readonly resolved?: string; readonly integrity?: string }
  >;
}

/** One Rail402 package as a registry install resolved it. */
export interface RegistryPackage {
  readonly name: string;
  readonly version: string;
  readonly resolved: string;
  readonly integrity: string;
}

const RAIL402_SCOPE = "@rail402.dev/";

/** The registry URL with exactly one trailing slash, which every tarball it serves starts with. */
export function registryBase(registry: string): string {
  return `${registry.replace(/\/+$/, "")}/`;
}

/** Every Rail402 package in an npm lockfile, by its install path. */
export function registryPackages(lock: RegistryLock): RegistryPackage[] {
  return Object.entries(lock.packages ?? {}).flatMap(([path, entry]) => {
    const at = path.lastIndexOf("node_modules/");
    const name = at < 0 ? path : path.slice(at + "node_modules/".length);
    if (!name.startsWith(RAIL402_SCOPE)) return [];
    return [
      {
        name,
        version: entry.version ?? "",
        resolved: entry.resolved ?? "",
        integrity: entry.integrity ?? "",
      },
    ];
  });
}

/**
 * What is wrong with an install of the published packages: every Rail402 package must come from the
 * given https registry (never a local tarball or the workspace), with a sha512 integrity, at the
 * expected version, and every expected package must be there.
 */
export function registryInstallProblems(
  lock: RegistryLock,
  expected: { readonly names: readonly string[]; readonly version: string; readonly registry: string },
): string[] {
  const problems: string[] = [];
  if (!URL.canParse(expected.registry) || new URL(expected.registry).protocol !== "https:") {
    problems.push(`the registry ${expected.registry} is not an https URL`);
  }
  const base = registryBase(expected.registry);
  const installed = registryPackages(lock);
  for (const entry of installed) {
    if (!entry.resolved.startsWith(base)) {
      problems.push(`${entry.name} resolved from ${entry.resolved || "nowhere"}, not ${base}`);
    }
    if (!entry.integrity.startsWith("sha512-")) {
      problems.push(`${entry.name} has no sha512 integrity`);
    }
    if (entry.version !== expected.version) {
      problems.push(`${entry.name} is ${entry.version || "unversioned"}, not ${expected.version}`);
    }
  }
  for (const name of expected.names) {
    if (!installed.some((entry) => entry.name === name)) problems.push(`${name} is not installed`);
  }
  return problems;
}
