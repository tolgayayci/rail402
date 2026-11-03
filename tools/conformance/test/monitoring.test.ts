import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALERTS,
  CAUSES,
  PROCEDURES,
  ROLES,
  ROLLBACKS,
  RULES_FILE,
  anchor,
  renderRules,
} from "../../../deploy/monitoring/alerts.ts";
import { DRILLS, anchorsOf } from "../src/drills.ts";
import { REPO_ROOT } from "../src/evidence.ts";

const read = (path: string) => readFileSync(join(REPO_ROOT, path), "utf8");
const compose = read("deploy/monitoring/compose.example.yaml");
const prometheus = read("deploy/monitoring/prometheus.yml");
const blackbox = read("deploy/monitoring/blackbox.yml");
const runbook = read("docs/runbook.mdx");
const metricsSource = read("apps/rail402/src/metrics.ts");
const hostCollector = read("deploy/postgres/backup-metrics.sh");
const explorerMetrics = read("apps/explorer/src/metrics.ts") + read("apps/explorer/src/web/metrics.ts");
const mcpMetrics = read("packages/mcp/src/hosted.ts");

/** The block of one top-level service in the compose example. */
function service(name: string): string {
  const lines = compose.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  if (start === -1) throw new Error(`no service ${name}`);
  const end = lines.findIndex((line, index) => index > start && /^ {2}\S|^\S/.test(line));
  return lines.slice(start, end).join("\n");
}

/** Prometheus' own series, the blackbox exporter's and node_exporter's, which Rail402 does not export. */
const EXTERNAL_SERIES = new Set([
  "up",
  "probe_success",
  "vector",
  "node_filesystem_avail_bytes",
  "node_filesystem_size_bytes",
]);

/** The networks a service of the compose example joins. */
function networksOf(name: string): string[] {
  const match = /^ {4}networks: \[([^\]]*)\]$/m.exec(service(name));
  return (match?.[1] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

describe("the monitoring example", () => {
  it("publishes no monitoring port and probes only listed targets", () => {
    expect(compose).not.toMatch(/^\s+ports:/m);
    for (const network of ["scrape", "alerting", "host-metrics"]) {
      expect(compose).toMatch(new RegExp(`^ {2}${network}:\\n {4}internal: true$`, "m"));
    }
    for (const name of ["prometheus", "alertmanager", "blackbox", "node-exporter"]) {
      expect(service(name), name).toMatch(/image: \S+@sha256:[0-9a-f]{64}$/m);
      expect(service(name), name).toContain("read_only: true");
      expect(service(name), name).toContain("cap_drop: [ALL]");
    }
    // The exporter knows only these modules, and neither follows redirects.
    const modules = [...blackbox.matchAll(/^ {2}([a-z0-9_]+):$/gm)].map((match) => match[1]);
    expect(modules).toEqual(["rail402_ready", "rail402_supported"]);
    expect(blackbox.match(/follow_redirects: false/g)).toHaveLength(2);
    // Every probe job names one of those modules, sends the probe to the exporter and takes its
    // targets from Prometheus' own configuration.
    const jobs = prometheus.split("  - job_name: ").slice(1);
    const probes = jobs.filter((job) => job.includes("metrics_path: /probe"));
    expect(probes).toHaveLength(4);
    for (const job of probes) {
      expect(job).toMatch(/module: \[(rail402_ready|rail402_supported)\]/);
      expect(job).toContain("replacement: blackbox:9115");
      expect(job).toMatch(
        /static_configs:\n\s+- targets: \["http:\/\/facilitator:8080\/|dns_sd_configs:\n\s+- names: \[facilitator\]/,
      );
    }
  });

  it("keeps the service off the alerting network: only Prometheus reaches Alertmanager", () => {
    // The facilitator replicas join `scrape` only (the file's header says so); Alertmanager, whose API
    // can silence alerts without authentication, shares no network with them.
    expect(compose).toMatch(/add the facilitator replicas to the `scrape` network, and to no other/);
    expect(networksOf("alertmanager")).toEqual(["alerting", "alerting-egress"]);
    expect(networksOf("prometheus")).toEqual(["scrape", "alerting", "host-metrics"]);
    expect(networksOf("blackbox")).toEqual(["scrape"]);
    expect(networksOf("node-exporter")).toEqual(["host-metrics"]);
    for (const name of ["blackbox", "node-exporter"]) {
      expect(networksOf(name), name).not.toContain("alerting");
    }
    // Prometheus can be read from the scrape network, but not changed or stopped.
    expect(service("prometheus")).not.toMatch(/^\s+- --web\.enable-(admin-api|lifecycle)/m);
    const alerting = prometheus.split("alerting:")[1]?.split("scrape_configs:")[0] ?? "";
    expect(alerting).toContain('targets: ["alertmanager:9093"]');
  });

  it("scrapes the private metrics with a token read from a file", () => {
    const rail402 = prometheus.split("  - job_name: ")[1] ?? "";
    expect(rail402).toMatch(/^rail402\n/);
    expect(rail402).toContain("metrics_path: /metrics/private");
    expect(rail402).toContain("credentials_file: /run/secrets/metrics_private_token");
  });
});

describe("the alert catalog", () => {
  it("every alert has a severity, an owner and a runbook link", () => {
    const names = ALERTS.map((alert) => alert.name);
    expect(new Set(names).size).toBe(names.length);
    for (const alert of ALERTS) {
      expect(["page", "ticket", "heartbeat"], alert.name).toContain(alert.severity);
      expect(ROLES, alert.name).toContain(alert.owner);
      for (const text of [alert.summary, alert.meaning, alert.firstStep, alert.escalation, alert.recovery]) {
        expect(text.trim().length, alert.name).toBeGreaterThan(0);
      }
      expect(runbook, alert.name).toContain(`### ${alert.name}\n`);
      expect(anchor(alert.name)).toBe(alert.name.toLowerCase());
    }
    expect(ALERTS.filter((alert) => alert.severity === "heartbeat").map((alert) => alert.name)).toEqual([
      "Watchdog",
    ]);
  });

  it("every alert says whether to roll back and links a recovery procedure that exists", () => {
    const headings = (path: string) =>
      new Map(
        [...read(path).matchAll(/^#{2,4} (.+)$/gm)].map((match) => [
          [...anchorsOf(`## ${match[1] ?? ""}`)][0],
          match[1],
        ]),
      );
    const pages = { "": headings("docs/runbook.mdx"), "/operations": headings("docs/operations.md") };
    for (const [link, title] of Object.entries(PROCEDURES)) {
      const [page, name] = link.split("#") as [keyof typeof pages, string];
      expect(pages[page].get(name), link).toBe(title);
    }
    for (const alert of ALERTS) {
      expect(ROLLBACKS, alert.name).toContain(alert.rollback);
      expect(Object.keys(PROCEDURES), alert.name).toContain(alert.procedure);
      const section = runbook.split(`### ${alert.name}\n`)[1]?.split("\n### ")[0] ?? "";
      expect(section, alert.name).toContain(
        `**Procedure.** [${PROCEDURES[alert.procedure]}](${alert.procedure})`,
      );
      expect(section, alert.name).toContain("**Rollback.** ");
    }
  });

  it("names roles, not people, and keeps who fills them in the role sheet", () => {
    // The role sheet is the operator setting: one entry per role, every one left empty in the example.
    const sheet = read("deploy/monitoring/roles.example.yml");
    const entries = [...sheet.matchAll(/^ {2}([a-z][a-z -]+):$/gm)].map((match) => match[1]);
    expect(entries).toEqual([...ROLES]);
    expect(sheet.match(/^ {4}people: \[\]$/gm)).toHaveLength(ROLES.length);
    expect(sheet.match(/^ {4}schedule: ""$/gm)).toHaveLength(ROLES.length);
    // The runbook's role table lists every role, and points at the sheet.
    for (const role of ROLES) {
      expect(runbook, role).toMatch(
        new RegExp(`^\\| ${role.charAt(0).toUpperCase()}${role.slice(1)} +\\|`, "m"),
      );
    }
    expect(runbook).toContain("deploy/monitoring/roles.example.yml");
  });

  it("names the drill exercise of every recovery procedure that is drilled", () => {
    for (const drill of DRILLS) {
      const name = drill.runbook.split("#")[1] ?? "";
      const section =
        runbook
          .split("\n### ")
          .find((part) => [...anchorsOf(`## ${part.split("\n")[0] ?? ""}`)][0] === name) ?? "";
      const exercise = section.split("**Exercise:**")[1]?.split("\n\n")[0] ?? "";
      expect(exercise, drill.exercise).toContain(`\`${drill.exercise}\``);
    }
  });

  it("reads only series Rail402 exports, or marks the alert as waiting for a newer series", () => {
    for (const alert of ALERTS) {
      const series = new Set(
        [...alert.expr.matchAll(/\b([a-z_][a-z0-9_]*)\s*(?:\{|\[|\(|\)|\s|>|<|=|$)/g)]
          .map((match) => match[1] ?? "")
          .filter((name) => name.startsWith("rail402_") || EXTERNAL_SERIES.has(name)),
      );
      expect(series.size, alert.name).toBeGreaterThan(0);
      // Host alerts read the textfile the collector script writes; Explorer and MCP alerts, those
      // components' metrics; the others, the service's metrics.
      const scope = alert.scope ?? "service";
      const source = {
        host: hostCollector,
        explorer: explorerMetrics,
        mcp: mcpMetrics,
        service: metricsSource,
      }[scope];
      const quoted =
        scope === "host" || scope === "mcp" ? (name: string) => name : (name: string) => `"${name}"`;
      const missing = [...series].filter(
        (name) => name.startsWith("rail402_") && !source.includes(quoted(name)),
      );
      if (alert.pending === undefined) expect(missing, alert.name).toEqual([]);
      else expect(missing.length, `${alert.name} is pending but every series exists`).toBeGreaterThan(0);
    }
  });

  it("scrapes the Explorer and the hosted MCP endpoint, and alerts when they stop", () => {
    const jobs = new Map(
      prometheus
        .split("  - job_name: ")
        .slice(1)
        .map((job) => [job.split("\n")[0] ?? "", job] as const),
    );
    expect(jobs.get("rail402-explorer-indexer")).toContain(
      'targets: ["explorer-indexer-testnet:9464", "explorer-indexer-pubnet:9464"]',
    );
    expect(jobs.get("rail402-explorer-web")).toContain('targets: ["explorer-web:9465"]');
    expect(jobs.get("rail402-mcp")).toContain('targets: ["rail402-mcp:9464"]');
    for (const job of ["rail402-explorer-indexer", "rail402-explorer-web", "rail402-mcp"]) {
      expect(
        ALERTS.some((alert) => alert.expr === `up{job="${job}"} == 0`),
        job,
      ).toBe(true);
    }
    expect(ALERTS.filter((alert) => alert.pending !== undefined)).toEqual([]);
    expect(read("apps/explorer/src/web/config.ts")).toContain('env["EXPLORER_METRICS_HOST"]');
    const group = renderRules().split("  - name: rail402-apps\n")[1] ?? "";
    for (const alert of ALERTS.filter((entry) => entry.scope === "explorer" || entry.scope === "mcp")) {
      expect(group, alert.name).toContain(`- alert: ${alert.name}\n`);
    }
  });

  it("lets a page silence only the tickets of its own cause, on its own network", () => {
    const alertmanager = read("deploy/monitoring/alertmanager.yml");
    const rules = alertmanager.split("inhibit_rules:\n")[1]?.split("\nreceivers:")[0] ?? "";
    expect(rules.match(/source_matchers/g)).toHaveLength(1);
    expect(rules).toContain(`source_matchers: ['severity="page"', 'network=~".+"', 'cause=~".+"']`);
    expect(rules).toContain(`target_matchers: ['severity="ticket"', 'network=~".+"', 'cause=~".+"']`);
    expect(rules).toContain("equal: [network, cause]");
    for (const cause of CAUSES) {
      const of = (severity: string) =>
        ALERTS.filter((alert) => alert.cause === cause && alert.severity === severity);
      // Every cause names a page that covers it and at least one ticket it covers.
      expect(of("page").length, cause).toBeGreaterThan(0);
      expect(of("ticket").length, cause).toBeGreaterThan(0);
    }
    for (const alert of ALERTS.filter((entry) => entry.cause !== undefined)) {
      // A cause needs the network label on both sides: service series only, never aggregated away.
      expect(alert.scope ?? "service", alert.name).toBe("service");
      expect(alert.expr, alert.name).not.toMatch(/\b(?:sum|count|max|min|avg)\b(?! by \(network\))/);
      expect(alert.severity, alert.name).not.toBe("heartbeat");
    }
    // The drill: the sponsor guard's page covers no ticket, so it can never hide a channel failure.
    expect(ALERTS.find((alert) => alert.name === "Rail402SponsorGuardRefusing")?.cause).toBeUndefined();
  });

  it("is the source of the committed rule file", () => {
    expect(readFileSync(RULES_FILE, "utf8")).toBe(renderRules());
  });

  it("watches WAL archiving, backups and host disk space, and pages on each", () => {
    const host = ALERTS.filter((alert) => alert.scope === "host");
    for (const name of [
      "Rail402WalArchiveFailing",
      "Rail402WalArchiveBehind",
      "Rail402BackupStale",
      "Rail402DiskAlmostFull",
      "Rail402DiskFillingFast",
    ]) {
      expect(host.find((alert) => alert.name === name)?.severity, name).toBe("page");
    }
    const group = renderRules().split("  - name: rail402-host\n")[1] ?? "";
    for (const alert of host) expect(group, alert.name).toContain(`- alert: ${alert.name}\n`);
  });

  it("follows each network on its own: per-network readiness, per-network sponsor thresholds", () => {
    const byName = (name: string) => ALERTS.find((alert) => alert.name === name);
    expect(byName("Rail402NetworkNotReady")?.expr).toMatch(/rail402-ready-\(testnet\|pubnet\)/);
    // One sponsor alert for every network, against that network's own exported floor: a page for the
    // key custodian, a ticket for the on-call on testnet.
    expect(byName("Rail402SponsorBalanceLow")?.expr).toContain("rail402_sponsor_balance_floor_stroops");
    expect(byName("Rail402SponsorBalanceLow")?.expr).not.toContain("network=");
    expect(byName("Rail402SponsorBalanceLow")).toMatchObject({
      severity: "page",
      owner: "key custodian",
      onTestnet: { severity: "ticket", owner: "primary on-call" },
    });
    expect(renderRules()).toContain(
      `severity: '{{ if eq $labels.network "stellar:testnet" }}ticket{{ else }}page{{ end }}'`,
    );
    expect(byName("Rail402SponsorBudgetNearlySpent")?.expr).toContain("rail402_sponsor_budget_used_ratio");
    for (const network of ["testnet", "pubnet"]) {
      expect(prometheus).toContain(`replacement: http://\${1}/ready/${network}`);
    }
  });
});
