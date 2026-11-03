import type { MetricValue, Registry } from "prom-client";

/**
 * The pubnet series the public `/metrics` keeps. Every other series labelled `network="stellar:pubnet"`
 * is served only at `/metrics/private`: sponsor balances, committed and wasted fees, guard refusals,
 * channel use, per-provider RPC figures and everything about access keys would let an outsider time a
 * drain of the mainnet budget. The list is an allow-list, so a metric added later is private until
 * someone decides otherwise.
 */
export const PUBLIC_PUBNET_METRICS: ReadonlySet<string> = new Set([
  "rail402_verifications_total",
  "rail402_settlements_total",
  "rail402_settlement_repeats_total",
  "rail402_settlements_finalized_total",
  "rail402_settlement_duration_seconds",
  "rail402_rpc_latest_ledger",
  "rail402_rpc_ledger_age_seconds",
  "rail402_contract_ttl_ledgers",
  "rail402_upto_settlements_total",
  "rail402_network_serving",
]);

/** Networks whose series are private unless allow-listed in `PUBLIC_PUBNET_METRICS`. */
const PRIVATE_NETWORKS: ReadonlySet<string> = new Set(["stellar:pubnet"]);

/**
 * Labels the public `/metrics` drops from a private network's series, adding up the series that then
 * coincide. `reason` carries the refusal code (`…_sponsor_unavailable`, `…_caller_budget_exhausted`,
 * `…_payto_rate_limited`), which would show when the pubnet budget is spent; the private view keeps it.
 */
const PUBLIC_REDACTED_LABELS: readonly string[] = ["reason"];

type Labels = Readonly<Record<string, string | number | undefined>>;

/** The labels a series shows on the public `/metrics`: a private network's lose the redacted ones. */
export function publicLabels(labels: Labels): Labels {
  const network = labels["network"];
  if (typeof network !== "string" || !PRIVATE_NETWORKS.has(network)) return labels;
  if (!PUBLIC_REDACTED_LABELS.some((label) => Object.hasOwn(labels, label))) return labels;
  return Object.fromEntries(
    Object.entries(labels).filter(([label]) => !PUBLIC_REDACTED_LABELS.includes(label)),
  );
}

/**
 * Whether a series belongs on the public `/metrics`: never one labelled with an access key, and a
 * pubnet series only when its metric is allow-listed. `name` is the metric's name (for a histogram,
 * the histogram's, not its `_bucket` series').
 */
export function isPublicSeries(name: string, labels: Labels): boolean {
  if (labels["key_id"] !== undefined) return false;
  const network = labels["network"];
  if (typeof network === "string" && PRIVATE_NETWORKS.has(network)) return PUBLIC_PUBNET_METRICS.has(name);
  return true;
}

interface CollectedValue extends MetricValue<string> {
  readonly metricName?: string;
  readonly sharedLabels?: Labels;
}

interface Collected {
  readonly name: string;
  readonly help: string;
  readonly type: string;
  readonly values: readonly CollectedValue[];
}

interface Collectable {
  get(): Promise<Collected> | Collected;
  getForPromString?: () => Promise<Collected>;
}

/**
 * The registry in the Prometheus text format (0.0.4), keeping only the series `keep` accepts, with the
 * labels `relabel` returns (series that then share their name and labels are added up). Without either
 * the text is byte-for-byte what prom-client serves; filtering works on the collected metric objects,
 * never on the text.
 */
export async function exposition(
  registry: Registry,
  keep: (name: string, labels: Labels) => boolean = () => true,
  relabel?: (labels: Labels) => Labels,
): Promise<string> {
  const metrics = registry.getMetricsAsArray() as unknown as Collectable[];
  const blocks = await Promise.all(
    metrics.map(async (metric) => {
      const data =
        metric.getForPromString === undefined ? await metric.get() : await metric.getForPromString();
      const name = escapeText(data.name);
      const lines = [`# HELP ${name} ${escapeText(data.help)}`, `# TYPE ${name} ${data.type}`];
      // Series in first-seen order; a relabelled series that coincides with an earlier one adds to it.
      const series = new Map<string, { head: string; value: number }>();
      for (const value of data.values) {
        const shared = value.sharedLabels ?? {};
        const own = value.labels as Labels;
        if (!keep(data.name, { ...shared, ...own })) continue;
        const labels = relabel === undefined ? own : relabel(own);
        const parts = [
          ...Object.entries(labels)
            .filter(([label]) => !Object.hasOwn(shared, label))
            .map(([label, labelValue]) => formatLabel(label, labelValue)),
          Object.entries(shared)
            .map(([label, labelValue]) => formatLabel(label, labelValue))
            .join(","),
        ].filter((part) => part !== "");
        const labelText = parts.length === 0 ? "" : `{${parts.join(",")}}`;
        const head = `${value.metricName ?? name}${labelText}`;
        const seen = relabel === undefined ? undefined : series.get(head);
        if (seen !== undefined) seen.value += value.value;
        else
          series.set(relabel === undefined ? `${String(series.size)}\u0000${head}` : head, {
            head,
            value: value.value,
          });
      }
      for (const { head, value } of series.values()) lines.push(`${head} ${formatValue(value)}`);
      return lines.join("\n");
    }),
  );
  return `${blocks.join("\n\n")}\n`;
}

/**
 * The public `/metrics` text: `exposition` filtered by `isPublicSeries`, with pubnet's refusal reasons
 * left out (`publicLabels`), so budget exhaustion cannot be read from it.
 */
export function publicExposition(registry: Registry): Promise<string> {
  return exposition(registry, isPublicSeries, publicLabels);
}

function escapeText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function formatLabel(label: string, value: string | number | undefined): string {
  const text = typeof value === "string" ? escapeText(value).replace(/"/g, '\\"') : String(value);
  return `${label}="${text}"`;
}

function formatValue(value: number): string {
  if (Number.isNaN(value)) return "Nan";
  if (!Number.isFinite(value)) return value < 0 ? "-Inf" : "+Inf";
  return String(value);
}
