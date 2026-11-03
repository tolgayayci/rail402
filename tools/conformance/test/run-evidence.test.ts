import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/evidence.ts";

const SCRIPT = readFileSync(join(REPO_ROOT, "tools/conformance/run-evidence.sh"), "utf8");
const COVERAGE_STEP = readFileSync(join(REPO_ROOT, "tools/conformance/codes-coverage-step.sh"), "utf8");
/** The script with its line continuations joined, one command per line. */
const LINES = SCRIPT.replace(/\\\n\s*/g, " ").split("\n");

/** Each harness invocation: the harness file, the flags passed to it and the whole command line. */
const invocations = LINES.flatMap((line) => {
  const match = /\$H\/([a-z0-9-]+)\.ts\b(.*)$/.exec(line);
  if (match === null || /^\s*#/.test(line)) return [];
  const flags = [...(match[2] ?? "").matchAll(/(?:^|\s)--([a-z0-9-]+)/g)].map((flag) => flag[1] ?? "");
  return [{ harness: match[1] ?? "", flags, line }];
});

/** The option names a harness declares in its `parseArgs({ options: { … } })`. */
function declaredOptions(harness: string): string[] {
  const source = readFileSync(join(REPO_ROOT, "tools/conformance/src", `${harness}.ts`), "utf8");
  const start = source.indexOf("parseArgs({");
  expect(start, `${harness}.ts parses no arguments`).toBeGreaterThan(-1);
  const open = source.indexOf("{", source.indexOf("options:", start));
  let depth = 0;
  let end = open;
  for (; end < source.length; end++) {
    if (source[end] === "{") depth++;
    else if (source[end] === "}" && --depth === 0) break;
  }
  const body = source.slice(open, end);
  const options = [...body.matchAll(/^\s+(?:"([a-z0-9-]+)"|([a-z0-9]+)):\s*\{\s*type:/gm)].map(
    (option) => option[1] ?? option[2] ?? "",
  );
  // The shared `--network` option of network.ts.
  return body.includes("...NETWORK_OPTION") ? [...options, "network"] : options;
}

describe("the evidence runbook", () => {
  it("invokes harnesses", () => {
    expect(invocations.map((entry) => entry.harness)).toEqual(
      expect.arrayContaining(["canonical", "live-agent", "ops", "benchmark", "upstream-e2e"]),
    );
  });

  it("passes every harness only flags it declares", () => {
    for (const { harness, flags, line } of invocations) {
      const declared = declaredOptions(harness);
      for (const flag of flags) {
        expect(declared, `${harness}.ts has no --${flag}: ${line.trim()}`).toContain(flag);
      }
    }
  });

  it("runs the live agent under the source condition; its packages come from the clean tarballs", () => {
    const agent = invocations.filter((entry) => entry.harness === "live-agent");
    // The local rehearsal, the hosted run and the pubnet run.
    expect(agent).toHaveLength(3);
    for (const { line } of agent) {
      expect(line).toContain('"${NODE[@]}" $H/live-agent.ts');
      expect(line, "pack-check builds the workspace itself").not.toContain("--skip-build");
    }
    expect(SCRIPT).not.toMatch(/^\s*(?:if )?pnpm build\b/m);
  });

  it("installs the published packages in every agent run when a registry is named", () => {
    expect(SCRIPT).toMatch(
      /^\[\[ -n "\$\{RAIL402_LIVE_AGENT_REGISTRY:-\}" \]\] && REGISTRY=\(--registry "\$RAIL402_LIVE_AGENT_REGISTRY"\)$/m,
    );
    expect(declaredOptions("live-agent")).toContain("registry");
    const agent = invocations.filter((entry) => entry.harness === "live-agent");
    for (const { line } of agent) expect(line).toContain('"${REGISTRY[@]}"');
  });

  it("runs the local agent rehearsal without a Bazaar or seller", () => {
    const local = invocations.filter(
      (entry) => entry.harness === "live-agent" && !entry.flags.includes("seller"),
    );
    expect(local).toHaveLength(1);
    expect(local[0]?.flags).not.toContain("bazaar");
  });

  it("runs the hosted agent run with the Bazaar and seller it names", () => {
    const hosted = invocations.filter(
      (entry) =>
        entry.harness === "live-agent" && entry.flags.includes("seller") && !entry.flags.includes("network"),
    );
    expect(hosted).toHaveLength(1);
    expect(hosted[0]?.flags).toEqual(expect.arrayContaining(["bazaar", "seller"]));
    expect(hosted[0]?.line).toMatch(/^\s*run live-agent-hosted /);
  });

  it("runs the hosted agent and Playground runs after the local ones and before the refusal audit", () => {
    const steps = /STEPS="\$\{RAIL402_EVIDENCE_STEPS:-([a-z0-9,-]+)\}"/.exec(SCRIPT)?.[1]?.split(",") ?? [];
    const at = (step: string) => steps.indexOf(step);
    expect(at("live-agent-hosted")).toBe(at("live-agent") + 1);
    expect(at("live-playground")).toBe(at("live-agent-hosted") + 1);
    expect(at("live-playground-hosted")).toBe(at("live-playground") + 1);
    expect(at("rejection-audit")).toBe(at("live-playground-hosted") + 1);
    expect(steps.slice(-3)).toEqual(["benchmark", "codes-coverage", "report"]);
  });

  it("runs the local Playground run with its own services and the hosted one against a deployed Playground", () => {
    const runs = invocations.filter((entry) => entry.harness === "live-playground");
    expect(runs).toHaveLength(2);
    const [local, hosted] = runs;
    expect(local?.flags, "the local run needs no Rail402, seller or Playground").toEqual([]);
    expect(local?.line).toMatch(
      /run live-playground "\$\{NODE\[@\]\}" \$H\/live-playground\.ts "\$\{WRITE\[@\]\}"/,
    );
    expect(hosted?.flags).toContain("playground");
    expect(hosted?.line).toMatch(
      /^\s*run live-playground-hosted .*--playground "\$RAIL402_EVIDENCE_PLAYGROUND_URL"/,
    );
  });

  it("prints the whole header comment for --help", () => {
    const header = SCRIPT.split("\n").findIndex((line, index) => index > 0 && !line.startsWith("#"));
    expect(SCRIPT).toContain(`sed -n '2,${String(header)}p' "$0"`);
  });

  it("runs only the reduced, capped step list on pubnet, against the deployed service", () => {
    const pubnet = LINES.filter((line) => /--network pubnet/.test(line) && !/^\s*#/.test(line));
    expect(pubnet.map((line) => /\$H\/([a-z0-9-]+)\.ts/.exec(line)?.[1])).toEqual([
      "canonical",
      "live-matrix",
      "concurrency",
      "upstream-e2e",
      // Without its checkout, the suite is recorded as waiting on that dependency.
      "upstream-e2e",
      "rejection-audit",
      "live-bazaar",
      "live-agent",
    ]);
    for (const line of pubnet) {
      expect(line).toMatch(/--(?:facilitator|bazaar) "\$P"/);
      expect(line).not.toMatch(/test6|fault-recovery|benchmark|SPONSOR/);
    }
    expect(pubnet.find((line) => line.includes("--pending"))).toContain(
      "RAIL402_X402_PUBNET_CHECKOUT is not set",
    );
    for (const cap of [
      "RAIL402_PUBNET_MAX_SPEND_XLM",
      "RAIL402_PUBNET_RUN_MAX_XLM",
      "RAIL402_PUBNET_RUN_MAX_USDC_LOSS",
    ]) {
      expect(SCRIPT).toContain(cap);
    }
    expect(SCRIPT).toMatch(/needs_service\(\) \{\n\s+\[\[ "\$NETWORK" == pubnet \]\] && return 1/);
  });

  it("plans a pubnet run first, claims it once, and closes its ledger on every exit", () => {
    const pubnet = SCRIPT.slice(SCRIPT.indexOf("# --- pubnet ---"));
    // Without a confirmation the script plans and exits before any harness runs.
    const plan = pubnet.indexOf('"${PUBNET_RUN[@]}" plan');
    const claim = pubnet.indexOf('"${PUBNET_RUN[@]}" claim --run "$RAIL402_PUBNET_RUN_CONFIRM"');
    const firstHarness = pubnet.indexOf("$H/canonical.ts");
    expect(plan).toBeGreaterThan(-1);
    expect(pubnet.slice(plan, claim)).toMatch(/exit 0/);
    expect(claim).toBeGreaterThan(plan);
    expect(firstHarness).toBeGreaterThan(claim);
    expect(pubnet).toContain("export RAIL402_PUBNET_LEDGER");
    // cleanup runs on every exit and closes the ledger the script claimed.
    const cleanup = SCRIPT.slice(SCRIPT.indexOf("cleanup() {"), SCRIPT.indexOf("trap cleanup EXIT"));
    expect(cleanup).toContain('tools/conformance/src/pubnet-run.ts close --ledger "$PUBNET_LEDGER_TO_CLOSE"');
    expect(pubnet).toContain('PUBNET_LEDGER_TO_CLOSE="$RAIL402_PUBNET_LEDGER"');
  });

  it("records the upstream drift at test time for every harness", () => {
    expect(SCRIPT).toContain("pnpm -s upstream:watch --json");
    expect(SCRIPT).toContain("export RAIL402_UPSTREAM_DRIFT=none");
    expect(SCRIPT.indexOf("RAIL402_UPSTREAM_DRIFT=none")).toBeLessThan(SCRIPT.indexOf("$H/canonical.ts"));
  });

  it("runs every default step", () => {
    const steps = /STEPS="\$\{RAIL402_EVIDENCE_STEPS:-([a-z0-9,-]+)\}"/.exec(SCRIPT)?.[1]?.split(",") ?? [];
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) expect(SCRIPT, `no step handles ${step}`).toContain(`wanted ${step}`);
  });

  it("never passes the sponsor seed on a command line", () => {
    for (const line of LINES.filter((entry) => entry.includes("TESTNET_SPONSOR_SECRET="))) {
      expect(line.trim(), "the seed is exported in the child's subshell only").toMatch(
        /^export TESTNET_SPONSOR_SECRET="\$seed"$/,
      );
    }
  });

  it("keeps the query string of the database URL when it adds the run's schema", () => {
    const helper = /^schema_url\(\) \{\n[\s\S]*?^\}$/m.exec(SCRIPT)?.[0];
    expect(helper, "run-evidence.sh defines schema_url").toBeDefined();
    const url = (base: string) =>
      execFileSync("bash", ["-c", `${helper ?? ""}\nschema_url "$1" evidence_1`, "-", base], {
        encoding: "utf8",
      });
    expect(url("postgres://u:p@db/app")).toBe("postgres://u:p@db/app?options=-c%20search_path%3Devidence_1");
    expect(url("postgres://u:p@db/app?sslmode=require")).toBe(
      "postgres://u:p@db/app?sslmode=require&options=-c%20search_path%3Devidence_1",
    );
    expect(SCRIPT).not.toMatch(/DATABASE_URL_BASE\?options/);
  });

  it("renders the report before the unit suite compares it with the evidence just written", () => {
    const commands = COVERAGE_STEP.split("\n").filter((line) => /^\s*(?:if !\s*)?pnpm /.test(line));
    const at = (pattern: RegExp) => commands.findIndex((line) => pattern.test(line));
    expect(at(/pnpm report\b/)).toBeGreaterThan(-1);
    expect(at(/pnpm report\b/)).toBeLessThan(at(/pnpm test\b(?!:)/));
    expect(at(/pnpm test\b(?!:)/)).toBeLessThan(at(/pnpm test:integration /));
    expect(commands[at(/pnpm test:integration /)]).toContain("--retry=1");
    expect(at(/pnpm test:integration /)).toBeLessThan(at(/pnpm codes:coverage --write/));
    expect(SCRIPT).toContain("run codes-coverage bash tools/conformance/codes-coverage-step.sh --write");
  });

  it("records the deployed service's canonical run beside the local one, only when it is named", () => {
    const hosted = invocations.filter(
      (entry) => entry.harness === "canonical" && entry.line.includes("$HOSTED_URL"),
    );
    expect(hosted).toHaveLength(1);
    expect(hosted[0]?.line).toMatch(/^\s*run canonical-hosted /);
  });

  it("records the deployed catalog's live Bazaar run beside the local one, only when it is named", () => {
    const runs = invocations.filter(
      (entry) => entry.harness === "live-bazaar" && !entry.line.includes("--network pubnet"),
    );
    expect(runs).toHaveLength(2);
    const hosted = runs.filter((entry) => entry.line.includes("$HOSTED_URL"));
    expect(hosted).toHaveLength(1);
    expect(hosted[0]?.line).toMatch(/^\s*run live-bazaar-hosted /);
    expect(hosted[0]?.line).toContain(
      '--seller "${RAIL402_EVIDENCE_HOSTED_SELLER:-https://demo.rail402.dev}"',
    );
  });

  it("pays a public seller in the pubnet Bazaar and agent runs, and fails them without one", () => {
    const pubnet = invocations.filter(
      (entry) =>
        ["live-bazaar", "live-agent"].includes(entry.harness) && entry.line.includes("--network pubnet"),
    );
    expect(pubnet.map((entry) => entry.harness)).toEqual(["live-bazaar", "live-agent"]);
    for (const { line } of pubnet) expect(line).toContain('--seller "$S"');
    expect(SCRIPT).toContain('S="$RAIL402_EVIDENCE_PUBNET_SELLER"');
    expect(SCRIPT).toMatch(
      /RAIL402_EVIDENCE_PUBNET_SELLER \(a public demo seller, https\) is not set"\n\s+FAILED\+=/,
    );
  });

  it("records the deployed service's rejection audit beside the local one, only when it is named", () => {
    const audits = invocations.filter(
      (entry) => entry.harness === "rejection-audit" && !entry.line.includes("--network pubnet"),
    );
    expect(audits).toHaveLength(2);
    const hosted = audits.filter((entry) => entry.line.includes("$HOSTED_URL"));
    expect(hosted).toHaveLength(1);
    expect(hosted[0]?.line).toMatch(/^\s*run rejection-audit-hosted /);
    // Keyed and rate-limited deployments are local only.
    expect(hosted[0]?.flags).toEqual(["facilitator", "mcp"]);
  });

  it("starts the local services with a version that names the commit", () => {
    expect(SCRIPT).toMatch(
      /^RAIL402_VERSION="\$\(jq -er \.version apps\/rail402\/package\.json\)\+\$\(git rev-parse --short=12 HEAD\)"$/m,
    );
    expect(SCRIPT).toMatch(/^export RAIL402_VERSION$/m);
  });
});
