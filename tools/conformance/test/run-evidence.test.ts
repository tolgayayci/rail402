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
  return [...body.matchAll(/^\s+(?:"([a-z0-9-]+)"|([a-z0-9]+)):\s*\{\s*type:/gm)].map(
    (option) => option[1] ?? option[2] ?? "",
  );
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
    expect(agent).toHaveLength(2);
    for (const { line } of agent) {
      expect(line).toContain('"${NODE[@]}" $H/live-agent.ts');
      expect(line, "pack-check builds the workspace itself").not.toContain("--skip-build");
    }
    expect(SCRIPT).not.toMatch(/^\s*(?:if )?pnpm build\b/m);
  });

  it("installs the published packages in both agent runs when a registry is named", () => {
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
      (entry) => entry.harness === "live-agent" && entry.flags.includes("seller"),
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

  it("records the deployed service's rejection audit beside the local one, only when it is named", () => {
    const audits = invocations.filter((entry) => entry.harness === "rejection-audit");
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
