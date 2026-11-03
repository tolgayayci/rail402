import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALERTS } from "../../../deploy/monitoring/alerts.ts";
import { REPO_ROOT } from "../src/evidence.ts";

// The committed Alertmanager configuration, run in the image CI pins for the monitoring example, with
// alerts posted to its API: what it reports as inhibited is what an operator would (not) be told.

const ALERTMANAGER = /^\s+ALERTMANAGER: (\S+)$/m.exec(
  readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8"),
)?.[1];

interface ApiAlert {
  readonly labels: Record<string, string>;
  readonly status: { readonly state: string; readonly inhibitedBy: readonly string[] };
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address !== null && typeof address === "object") resolve(address.port);
        else reject(new Error("no port"));
      });
    });
  });
}

const docker = (...args: string[]) =>
  execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

describe("the Alertmanager inhibition rule", () => {
  let directory = "";
  let name = "";
  let api = "";

  beforeAll(async () => {
    if (ALERTMANAGER === undefined) throw new Error("ci.yml pins no Alertmanager image");
    directory = mkdtempSync(join(tmpdir(), "rail402-am-"));
    // The receivers read their URLs from files; nothing listens there, and delivery is not tested here.
    for (const file of ["alert_webhook_url", "deadman_url"]) {
      writeFileSync(join(directory, file), "http://127.0.0.1:9/\n", { mode: 0o644 });
    }
    const port = await freePort();
    name = `rail402-am-test-${String(process.pid)}-${String(port)}`;
    docker(
      "run",
      "-d",
      "--rm",
      "--network",
      "host",
      "--user",
      String(process.getuid?.() ?? 65534),
      "-v",
      `${join(REPO_ROOT, "deploy/monitoring")}:/m:ro`,
      "-v",
      `${directory}:/run/secrets:ro`,
      "--name",
      name,
      ALERTMANAGER,
      "--config.file=/m/alertmanager.yml",
      "--storage.path=/tmp/am",
      `--web.listen-address=127.0.0.1:${String(port)}`,
      "--cluster.listen-address=",
    );
    api = `http://127.0.0.1:${String(port)}/api/v2`;
    const deadline = Date.now() + 60_000;
    for (;;) {
      const ready = await fetch(`http://127.0.0.1:${String(port)}/-/ready`).then(
        (response) => response.ok,
        () => false,
      );
      if (ready) break;
      if (Date.now() > deadline) throw new Error(`Alertmanager did not start: ${docker("logs", name)}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  });

  afterAll(() => {
    if (name !== "") {
      try {
        docker("rm", "-f", name);
      } catch {
        // already gone
      }
    }
    if (directory !== "") rmSync(directory, { recursive: true, force: true });
  });

  it("lets a page silence only the tickets of its own cause on its own network", async () => {
    // Labels as Prometheus sends them: the rule's own labels from the catalog plus the series' labels.
    const alert = (name: string, labels: Record<string, string> = {}) => {
      const rule = ALERTS.find((entry) => entry.name === name);
      if (rule === undefined) throw new Error(`no alert ${name}`);
      return {
        labels: {
          alertname: name,
          severity: rule.severity,
          owner: rule.owner,
          ...(rule.cause === undefined ? {} : { cause: rule.cause }),
          ...labels,
        },
        startsAt: new Date(Date.now() - 60_000).toISOString(),
        endsAt: new Date(Date.now() + 3_600_000).toISOString(),
      };
    };
    const testnet = { network: "stellar:testnet" };
    const pubnet = { network: "stellar:pubnet" };
    const alerts = [
      // Testnet: the sponsor guard pages while channel leases time out for an unrelated reason. The
      // page covers nothing about channels, so the ticket must still be sent.
      alert("Rail402SponsorGuardRefusing", { ...testnet, reason: "reserve" }),
      alert("Rail402ChannelLeaseTimeouts", testnet),
      alert("Rail402RpcFailover", { ...testnet, from: "primary", to: "fallback" }),
      // Pubnet: every channel is busy and the RPC is stale; each page covers its own consequence only.
      alert("Rail402ChannelsExhausted", pubnet),
      alert("Rail402ChannelLeaseTimeouts", pubnet),
      alert("Rail402RpcStale", pubnet),
      alert("Rail402RpcFailover", { ...pubnet, from: "primary", to: "fallback" }),
      alert("Rail402SponsorBudgetNearlySpent", pubnet),
      // Without a network label: a page and a ticket.
      alert("Rail402Down", { instance: "10.0.0.2:8080" }),
      alert("Rail402BackupMetricsStale"),
    ];
    const posted = await fetch(`${api}/alerts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(alerts),
    });
    expect(posted.status).toBe(200);

    const stateOf = (list: readonly ApiAlert[], alertname: string, network?: string) =>
      list.find((entry) => entry.labels["alertname"] === alertname && entry.labels["network"] === network)
        ?.status;
    let list: ApiAlert[];
    const deadline = Date.now() + 30_000;
    // Inhibition is computed as alerts arrive; wait until all are listed and the two covered tickets'
    // states have settled.
    for (;;) {
      list = (await (await fetch(`${api}/alerts`)).json()) as ApiAlert[];
      if (
        list.length === alerts.length &&
        stateOf(list, "Rail402ChannelLeaseTimeouts", "stellar:pubnet")?.state === "suppressed" &&
        stateOf(list, "Rail402RpcFailover", "stellar:pubnet")?.state === "suppressed"
      )
        break;
      if (Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(list).toHaveLength(alerts.length);
    const active = { state: "active", inhibitedBy: [] };

    // An unrelated page hides nothing: both testnet tickets are sent next to the guard's page.
    expect(stateOf(list, "Rail402ChannelLeaseTimeouts", "stellar:testnet")).toMatchObject(active);
    expect(stateOf(list, "Rail402RpcFailover", "stellar:testnet")).toMatchObject(active);
    // A covering page silences its consequence on its network, and only that ticket.
    for (const name of ["Rail402ChannelLeaseTimeouts", "Rail402RpcFailover"]) {
      const covered = stateOf(list, name, "stellar:pubnet");
      expect(covered?.state, name).toBe("suppressed");
      expect(covered?.inhibitedBy, name).toHaveLength(1);
    }
    expect(stateOf(list, "Rail402SponsorBudgetNearlySpent", "stellar:pubnet")).toMatchObject(active);
    // Alerts without a network label silence nothing and are never silenced.
    expect(stateOf(list, "Rail402BackupMetricsStale")).toMatchObject(active);
    // Pages are never inhibited.
    for (const [name, network] of [
      ["Rail402SponsorGuardRefusing", "stellar:testnet"],
      ["Rail402ChannelsExhausted", "stellar:pubnet"],
      ["Rail402RpcStale", "stellar:pubnet"],
      ["Rail402Down", undefined],
    ] as const) {
      expect(stateOf(list, name, network), name).toMatchObject(active);
    }
  });
});
