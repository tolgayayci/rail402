/**
 * The pubnet profiles of the live Bazaar and live agent runs, rehearsed against a fake pubnet
 * (fixtures/fake-pubnet.ts): a fake Rail402 and demo seller behind a stubbed `fetch` that refuses every
 * other request. No RPC, Friendbot or real service is ever contacted; the runs must stop before they
 * spend, with the codes the other pubnet harnesses use. The agent run's packages come from a stand-in
 * npm (fixtures/fake-npm.ts), so where the installed code runs, and what it sees, can be checked.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@stellar/stellar-sdk";
import { afterAll, describe, expect, it, type ExpectStatic } from "vitest";
import { FAKE_FACILITATOR, FAKE_SELLER } from "./fixtures/fake-pubnet.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/fake-pubnet.ts", import.meta.url));
const FAKE_NPM = fileURLToPath(new URL("./fixtures/fake-npm.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "rail402-pubnet-live-"));
// The operator's secrets live in their own directory, apart from the run's HOME, npm and runs dir, as
// on a real host; the agent process masks this directory under isolation.
const secretsDir = join(dir, "secrets");
mkdirSync(secretsDir);
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Whether this host can give the agent process its own user, mount and PID namespaces. */
function isolationAvailable(): boolean {
  const probe = spawnSync(
    "unshare",
    [
      "--user",
      "--map-root-user",
      "--mount",
      "--propagation",
      "private",
      "--pid",
      "--fork",
      "--mount-proc",
      "--",
      "true",
    ],
    { stdio: "ignore" },
  );
  return probe.error === undefined && probe.status === 0;
}
const ISOLATION = isolationAvailable();

function secretFile(name: string, content: string): string {
  const path = join(secretsDir, name);
  writeFileSync(path, `${content}\n`);
  chmodSync(path, 0o600);
  return path;
}

const treasury = secretFile("treasury.txt", Keypair.random().secret());
const apiKey = secretFile("api-key.txt", "r402_fake_pubnet_key");

/** Every pubnet setting a run needs, with no confirmation yet. */
const SETTINGS: Record<string, string> = {
  RAIL402_PUBNET_RPC_URLS: "https://rpc.fake-pubnet.example",
  RAIL402_TREASURY_SECRET_FILE: treasury,
  RAIL402_PUBNET_MAX_SPEND_XLM: "40",
  RAIL402_PUBNET_MAX_SPEND_USDC: "2",
  RAIL402_PUBNET_MAX_SETTLEMENTS: "100",
  RAIL402_PUBNET_MAX_NEW_ACCOUNTS: "12",
  RAIL402_PUBNET_RUN_MAX_XLM: "60",
  RAIL402_PUBNET_RUN_MAX_USDC_LOSS: "1",
  PUBNET_MAX_TX_FEE_STROOPS: "300000",
  PUBNET_UPTO_MAX_TX_FEE_STROOPS: "1000000",
  RAIL402_FACILITATOR_API_KEY_FILE: apiKey,
};

interface Request {
  readonly method: string;
  readonly url: string;
  readonly bearer: boolean;
}

interface Rehearsal {
  /** The harness's own process. */
  readonly pid: number | undefined;
  readonly status: number | null;
  readonly stderr: string;
  readonly requests: readonly Request[];
  readonly runsDir: string;
}

let counter = 0;

/** Runs a harness against the fake pubnet with only the given settings in its environment. */
function rehearse(
  harness: string,
  args: readonly string[],
  settings: Record<string, string>,
): Promise<Rehearsal> {
  const id = String(counter++);
  const logFile = join(dir, `requests-${id}.jsonl`);
  const runsDir = join(dir, `runs-${id}`);
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--conditions=@rail402/source",
        "--import",
        FIXTURE,
        join(ROOT, `tools/conformance/src/${harness}.ts`),
        ...args,
      ],
      {
        cwd: ROOT,
        env: {
          PATH: process.env["PATH"] ?? "",
          HOME: dir,
          TMPDIR: dir,
          FAKE_PUBNET_LOG: logFile,
          RAIL402_PUBNET_RUNS_DIR: runsDir,
          ...settings,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.stdout.resume();
    child.on("error", reject);
    child.on("close", (status) => {
      const requests = existsSync(logFile)
        ? readFileSync(logFile, "utf8")
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => JSON.parse(line) as Request)
        : [];
      resolve({ pid: child.pid, status, stderr, requests, runsDir });
    });
  });
}

const bazaar = (settings: Record<string, string>, seller = FAKE_SELLER) =>
  rehearse(
    "live-bazaar",
    ["--network", "pubnet", "--facilitator", FAKE_FACILITATOR, "--seller", seller],
    settings,
  );
const agent = (
  settings: Record<string, string>,
  args = ["--bazaar", FAKE_FACILITATOR, "--seller", FAKE_SELLER],
) => rehearse("live-agent", ["--network", "pubnet", "--skip-build", ...args], settings);

/** Nothing reached anything but the fake Rail402 and seller, and nothing was settled. */
function onlyFakes(requests: readonly Request[]) {
  for (const request of requests) {
    expect([FAKE_FACILITATOR, FAKE_SELLER], request.url).toContain(new URL(request.url).origin);
    expect(new URL(request.url).pathname, request.url).not.toBe("/settle");
  }
}

/** The run ids planned in a rehearsal's runs directory, with their ledger state. */
function plannedRuns(runsDir: string): { id: string; state: string }[] {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir).map((id) => ({
    id,
    state: (JSON.parse(readFileSync(join(runsDir, id, "ledger.json"), "utf8")) as { state: string }).state,
  }));
}

describe.concurrent("the live Bazaar run on pubnet", () => {
  it("refuses to start without the pubnet settings, before any request", async () => {
    const { RAIL402_PUBNET_RPC_URLS: _rpc, ...rest } = SETTINGS;
    const run = await bazaar(rest);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("pubnet_rpc_missing");
    expect(run.requests).toEqual([]);
  });

  it("refuses a seller that is not https, before any request", async () => {
    const run = await bazaar(SETTINGS, "http://seller.example");
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("pubnet_target_missing");
    expect(run.requests).toEqual([]);
  });

  it("refuses a keyed service without a key, before anything is planned or spent", async () => {
    const { RAIL402_FACILITATOR_API_KEY_FILE: _key, ...rest } = SETTINGS;
    const run = await bazaar(rest);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("pubnet_api_key_missing");
    expect(plannedRuns(run.runsDir)).toEqual([]);
    onlyFakes(run.requests);
  });

  it("plans the run and spends nothing without a confirmation; the key goes as a Bearer token", async () => {
    const run = await bazaar(SETTINGS);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/pubnet_run_unconfirmed: .*RAIL402_PUBNET_RUN_CONFIRM=[0-9a-f]{16}/);
    expect(plannedRuns(run.runsDir).map((entry) => entry.state)).toEqual(["planned"]);
    onlyFakes(run.requests);
    const access = run.requests.filter((request) => request.url === `${FAKE_FACILITATOR}/verify`);
    expect(access).toEqual([{ method: "POST", url: `${FAKE_FACILITATOR}/verify`, bearer: true }]);
  });

  it("stops a confirmed run whose caps cannot cover it before any account is created, and closes its ledger", async () => {
    const tight = { ...SETTINGS, RAIL402_PUBNET_MAX_SETTLEMENTS: "5" };
    const planned = await bazaar(tight);
    const [run] = plannedRuns(planned.runsDir);
    expect(run).toBeDefined();
    const confirmed = await rehearse(
      "live-bazaar",
      ["--network", "pubnet", "--facilitator", FAKE_FACILITATOR, "--seller", FAKE_SELLER],
      { ...tight, RAIL402_PUBNET_RUN_CONFIRM: run?.id ?? "", RAIL402_PUBNET_RUNS_DIR: planned.runsDir },
    );
    expect(confirmed.status).not.toBe(0);
    expect(confirmed.stderr).toContain("spend_cap_exceeded");
    expect(plannedRuns(planned.runsDir).map((entry) => entry.state)).toEqual(["closed"]);
    onlyFakes(confirmed.requests);
  });
});

describe.concurrent("the live agent run on pubnet", () => {
  it("refuses a pubnet run without a deployed Bazaar and seller, before any request", async () => {
    const run = await agent(SETTINGS, []);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("pubnet_target_missing");
    expect(run.requests).toEqual([]);
  });

  it("plans the run and spends nothing without a confirmation; the key goes as a Bearer token", async () => {
    const run = await agent(SETTINGS);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/pubnet_run_unconfirmed: .*RAIL402_PUBNET_RUN_CONFIRM=[0-9a-f]{16}/);
    expect(plannedRuns(run.runsDir).map((entry) => entry.state)).toEqual(["planned"]);
    onlyFakes(run.requests);
    expect(run.requests).toEqual([{ method: "POST", url: `${FAKE_FACILITATOR}/verify`, bearer: true }]);
  });

  it("stops a confirmed run whose caps cannot fund the payer, before anything is installed or sent", async () => {
    const tight = { ...SETTINGS, RAIL402_PUBNET_MAX_SPEND_USDC: "0.1" };
    const planned = await agent(tight);
    const [run] = plannedRuns(planned.runsDir);
    expect(run).toBeDefined();
    const confirmed = await rehearse(
      "live-agent",
      ["--network", "pubnet", "--skip-build", "--bazaar", FAKE_FACILITATOR, "--seller", FAKE_SELLER],
      { ...tight, RAIL402_PUBNET_RUN_CONFIRM: run?.id ?? "", RAIL402_PUBNET_RUNS_DIR: planned.runsDir },
    );
    expect(confirmed.status).not.toBe(0);
    expect(confirmed.stderr).toContain("spend_cap_exceeded");
    expect(confirmed.stderr).not.toContain("pack-check");
    expect(plannedRuns(planned.runsDir).map((entry) => entry.state)).toEqual(["closed"]);
    onlyFakes(confirmed.requests);
  });
});

/** What a stub's entry point found when it tried to reach the treasury-holding process through /proc. */
interface Attack {
  readonly procPidCount: number;
  readonly parentPid: string | null;
  readonly treasuryPath: string | null;
  readonly treasurySeedRead: boolean;
  readonly memOpenable: boolean;
  readonly ownEnvHasTreasury: boolean;
}

/** One call of the stand-in npm, or one import of a stub it installed. */
interface Sighting {
  readonly kind: "npm" | "import";
  readonly pid: number;
  readonly ppid: number;
  readonly args?: readonly string[];
  readonly env: Record<string, string>;
  readonly attack?: Attack;
}

/** A directory whose `npm` is the stand-in, with its own log of what it and its stubs saw. */
function fakeNpm(): { readonly bin: string; readonly sightings: () => Sighting[] } {
  const id = String(counter++);
  const bin = join(dir, `npm-${id}`);
  const log = join(dir, `npm-${id}.jsonl`);
  mkdirSync(bin);
  writeFileSync(
    join(bin, "npm"),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_NPM)} ${JSON.stringify(log)} "$@"\n`,
  );
  chmodSync(join(bin, "npm"), 0o755);
  return {
    bin,
    sightings: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => JSON.parse(line) as Sighting)
        : [],
  };
}

/** What a run holds that the packages it installs, and npm, must never see. */
const RUN_SECRETS = [
  "RAIL402_TREASURY_SECRET_FILE",
  "RAIL402_FACILITATOR_API_KEY_FILE",
  "RAIL402_PUBNET_LEDGER",
  "RAIL402_PUBNET_RUN_CONFIRM",
  "RAIL402_SPONSOR_SECRET_FILE",
];

describe.concurrent("the packages the live agent run installs", () => {
  const sponsor = secretFile("sponsor.txt", Keypair.random().secret());
  /** A loopback RPC that refuses connections: the run stops there, after the install and the import. */
  const settings = (npm: { bin: string }) => ({
    ...SETTINGS,
    RAIL402_PUBNET_RPC_URLS: "https://127.0.0.1:9",
    RAIL402_SPONSOR_SECRET_FILE: sponsor,
    PATH: `${npm.bin}:${process.env["PATH"] ?? ""}`,
  });
  const registry = ["--registry", "https://registry.fake-pubnet.example/"];

  /**
   * npm ran with --ignore-scripts and none of the run's secrets; the SDK ran in another process. Each
   * property is checked on its own, so a failure lists every one that does not hold.
   */
  function contained(
    expect: ExpectStatic,
    run: Rehearsal,
    sightings: readonly Sighting[],
    secrets: readonly string[],
  ) {
    const calls = sightings.filter((sighting) => sighting.kind === "npm");
    const imports = sightings.filter((sighting) => sighting.kind === "import");
    expect.soft(calls.map((call) => call.args?.[0])).toEqual(["install"]);
    expect.soft(imports).toHaveLength(1);
    for (const call of calls) expect.soft(call.args).toContain("--ignore-scripts");
    for (const sighting of sightings) {
      const env = sighting.env;
      expect
        .soft(
          Object.keys(env).filter((name) => RUN_SECRETS.includes(name)),
          sighting.kind,
        )
        .toEqual([]);
      for (const secret of [treasury, apiKey, sponsor, ...secrets]) {
        expect.soft(Object.values(env).join("\n"), sighting.kind).not.toContain(secret);
      }
    }
    // The installed SDK's top-level code never runs in the harness's own process.
    expect.soft(imports[0]?.pid).toBeDefined();
    expect.soft(imports[0]?.pid).not.toBe(run.pid);
    // On a host that allows namespaces, the installed code cannot reach the treasury-holding process:
    // /proc holds only its own processes, so it finds no process whose environment names the treasury,
    // and it reads neither that process's memory nor the treasury secret file.
    if (ISOLATION) {
      const attack = imports[0]?.attack;
      expect.soft(attack?.parentPid, "parentPid").toBeNull();
      expect.soft(attack?.treasuryPath, "treasuryPath").toBeNull();
      expect.soft(attack?.treasurySeedRead, "treasurySeedRead").toBe(false);
      expect.soft(attack?.memOpenable, "memOpenable").toBe(false);
      expect.soft(attack?.ownEnvHasTreasury, "ownEnvHasTreasury").toBe(false);
      expect.soft(attack?.procPidCount ?? Infinity, "procPidCount").toBeLessThan(50);
    }
  }

  it("on testnet: npm without install scripts or secrets, and the SDK in a process of its own", async ({
    expect,
  }) => {
    const npm = fakeNpm();
    const run = await rehearse("live-agent", ["--skip-build", ...registry], settings(npm));
    expect(run.status).not.toBe(0);
    contained(expect, run, npm.sightings(), []);
  }, 60_000);

  it("on pubnet: npm without install scripts or secrets, and the SDK away from the treasury", async ({
    expect,
  }) => {
    const npm = fakeNpm();
    const env = settings(npm);
    const planned = await agent(env);
    const [planId] = plannedRuns(planned.runsDir).map((entry) => entry.id);
    expect(planId).toBeDefined();
    // As run-evidence.sh does: the planned run is claimed once, then every harness joins its ledger.
    const claimed = await rehearse("pubnet-run", ["claim", "--run", planId ?? ""], {
      ...env,
      RAIL402_PUBNET_RUNS_DIR: planned.runsDir,
    });
    expect(claimed.status).toBe(0);
    const ledger = join(planned.runsDir, planId ?? "", "ledger.json");
    const run = await rehearse(
      "live-agent",
      [
        "--network",
        "pubnet",
        "--skip-build",
        "--bazaar",
        FAKE_FACILITATOR,
        "--seller",
        FAKE_SELLER,
        ...registry,
      ],
      {
        ...env,
        RAIL402_PUBNET_RUN_CONFIRM: planId ?? "",
        RAIL402_PUBNET_LEDGER: ledger,
        RAIL402_PUBNET_RUNS_DIR: planned.runsDir,
      },
    );
    expect(run.status).not.toBe(0);
    // The run got as far as installing: its ledger was joined and its caps cover the payer.
    expect(run.stderr).not.toMatch(/pubnet_run_unconfirmed|spend_cap_exceeded|pubnet_run_unknown/);
    contained(expect, run, npm.sightings(), [ledger, planId ?? ""]);
    expect(run.requests.filter((request) => new URL(request.url).pathname === "/settle")).toEqual([]);
  }, 60_000);
});

describe.concurrent("the agent process isolation gate on pubnet", () => {
  const sponsor = secretFile("sponsor-gate.txt", Keypair.random().secret());
  // A treasury process holds a mainnet seed, so a host that cannot seal the agent off from it must
  // not run one. Isolation is forced unavailable by pointing `unshare` at a path that does not exist.
  const base = (extra: Record<string, string>) => ({
    ...SETTINGS,
    RAIL402_PUBNET_RPC_URLS: "https://127.0.0.1:9",
    RAIL402_SPONSOR_SECRET_FILE: sponsor,
    RAIL402_AGENT_UNSHARE: join(dir, "no-such-unshare"),
    ...extra,
  });

  it("refuses a pubnet run, before anything is planned or spent, when the agent cannot be isolated", async () => {
    const run = await agent(base({}));
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("pubnet_agent_unisolated");
    expect(plannedRuns(run.runsDir)).toEqual([]);
    onlyFakes(run.requests);
  });

  it("proceeds only with the documented opt-out that the agent runs as a separate OS user", async () => {
    const run = await agent(base({ RAIL402_PUBNET_UNISOLATED_AGENT: "agent-runs-as-a-separate-os-user" }));
    expect(run.status).not.toBe(0);
    // The gate is passed; the run then plans and spends nothing, exactly as a confirmed-free run does.
    expect(run.stderr).not.toContain("pubnet_agent_unisolated");
    expect(run.stderr).toMatch(/pubnet_run_unconfirmed/);
    expect(plannedRuns(run.runsDir).map((entry) => entry.state)).toEqual(["planned"]);
  });

  it("refuses a wrong opt-out value", async () => {
    const run = await agent(base({ RAIL402_PUBNET_UNISOLATED_AGENT: "yes" }));
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("pubnet_agent_unisolated");
    expect(plannedRuns(run.runsDir)).toEqual([]);
  });
});
