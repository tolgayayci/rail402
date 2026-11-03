/**
 * Live agent run on the public Stellar testnet: an HTTP API and an MCP tool are cataloged by a paid
 * call (each case records its listing's first cataloging, the settlement transaction that cataloged it
 * and its version history), found by natural-language search, paid through their listings and called, by the
 * buyer SDK, the MCP server (`rail402-mcp`) and the CLI (`rail402`), for `exact` and `upto`; then the
 * refusals an agent relies on (a cap below the price, SSRF literals, a tiny session budget, a
 * network, asset, recipient or amount outside the policy) move nothing on every surface, and each
 * surface's payment events show the refusal and no signature; every receipt links the Rail402 Explorer
 * page of its transaction, which answers naming the same hash, and every transaction also opens in
 * stellar.expert, independently of Rail402; and a canary scan finds no secret in anything the agent
 * tools produced.
 *
 *   node --conditions=@rail402/source tools/conformance/src/live-agent.ts [--skip-build] [--only id,id] \
 *     [--keep] [--bazaar https://… --seller https://… [--impostor-listing <id>]] \
 *     [--registry https://registry.npmjs.org/] [--write [--allow-branch <branch>]]
 *
 * The packages under test are always installed with npm: their published manifests carry no
 * repository-only export condition, so they resolve to their own `dist` under any conditions.
 *
 * Two modes:
 * - local (the default), a rehearsal whose listings live only as long as the run:
 *   - Rail402 (apps/rail402) as a local process, in memory, against the public testnet RPC, with a
 *     Friendbot-funded fee sponsor and `DISCOVERY_ALLOW_LOOPBACK=true` so it catalogs a local seller;
 *   - the demo seller (apps/demo-seller) on loopback, settling through that Rail402, paid to a fresh
 *     account in Circle's testnet USDC;
 * - hosted (`--bazaar` and `--seller`): no local Rail402 and no local seller. The agent pays a deployed
 *   demo seller (for example https://demo.rail402.dev) that settles through a deployed Rail402 (for
 *   example https://testnet.rail402.dev), and finds and pays its listings in that public Bazaar, so
 *   anyone can re-check the listings, their versions and the transactions afterwards. With
 *   `--impostor-listing <id>`, a listing whose live payment requirements do not pay its owner must be
 *   refused (`payment_listing_mismatch`) before anything is signed.
 * In both modes the SDK, `rail402` and `rail402-mcp` are installed with npm from the tarballs
 * `pnpm pack:check` builds, never from the workspace; with `--registry`, every publishable package is
 * installed from that registry instead, at this checkout's version, and the run stops unless each one
 * resolved from it with a sha512 integrity (the evidence records both). The payer is onboarded by `rail402 account
 * setup` (Friendbot, a USDC trustline and USDC from the testnet exchange); a loopback impostor seller
 * offers options on another network, in another asset or of zero (so plain http and loopback are
 * allowed for it); and every receipt's Rail402 Explorer link and stellar.expert page are opened.
 *
 * Fresh accounts are created for every run, so the script needs no secrets. Without --write the
 * evidence document is printed; with --write it is recorded, from a clean commit on main, as
 * tools/conformance/evidence/live-agent-local-stellar-testnet.json (local) or
 * tools/conformance/evidence/live-agent-stellar-testnet.json (hosted).
 *
 * The packages under test, and every dependency npm resolves for them, are third-party code to this
 * run. They are installed with npm's lifecycle scripts off, and they never run in the process the
 * operator starts: that process starts this script again as its agent process (`--agent-process`,
 * set by the run itself), with the toolchain environment only (never the treasury file, the API key
 * file, the run's ledger or its confirmation) and an IPC channel back. On a host that allows it the
 * agent process is launched in its own user, mount and PID namespaces (`unshare`), so it cannot see
 * the run's process in /proc (no reading its environment or memory) and the treasury secret file, the
 * API key file and the runs directory are masked by an unreadable tmpfs; the agent keeps the network,
 * for npm and the RPC. On pubnet, where the run holds a mainnet treasury, this isolation is required:
 * the run refuses to start without it unless the operator opts out and states the agent runs under a
 * different OS user. On testnet it is used when available and its absence is logged. The agent process
 * installs the packages and runs every case; on pubnet it asks the run's process for its payer, which
 * the treasury funds for this run only, and to count each payment against the run's caps, and it
 * writes the evidence once the run's process has returned the run's funds. Its standard output goes to
 * standard error; a printed evidence document comes back over the channel, and the run prints it.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ok, strictEqual } from "node:assert/strict";
import { Asset, Keypair } from "@stellar/stellar-sdk";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { decodePaymentRequiredHeader, encodePaymentRequiredHeader } from "@x402/core/http";
import { HTTPFacilitatorClient, type FacilitatorClient } from "@x402/core/server";
import type { PaymentRequirements } from "@x402/core/types";
import { USDC_PUBNET_ADDRESS, USDC_TESTNET_ADDRESS } from "@x402/stellar";
import { createSeller, METERED_PRICES, PRICES, TOOL_PRICES } from "@rail402.dev/demo-seller";
import { LocalNetwork, SecretScanner, ServiceProcess } from "@rail402.dev/testkit";
import type * as Sdk from "@rail402.dev/sdk";
import type * as SdkSqlite from "@rail402.dev/sdk/sqlite";
import {
  EVIDENCE_DIR,
  evidenceFileName,
  harnessProvenance,
  recheckProvenance,
  writeEvidence,
} from "./evidence.ts";
import {
  CaseRecorder,
  baseUrl,
  buildEvidence,
  explorerUrl,
  readTarget,
  runToStderr,
  settledTransaction,
  type CaseContext,
  type CaseSpec,
} from "./harness.ts";
import {
  checkExplorerPage,
  checkStellarExpert,
  explorerPageProblems,
  liveAgentProblems,
  PUBNET_UNREACHABLE_REFUSALS,
  rail402ExplorerTx,
  registryBase,
  registryInstallProblems,
  registryPackages,
  type AgentSurface,
  type RegistryLock,
  type ExplorerCheck,
  type ExplorerPageCheck,
} from "./live-agent-checks.ts";
import { TESTNET_FRIENDBOT_URL, TESTNET_RPC_URL, Treasury, gitCommit, log } from "./testnet.ts";
import {
  NETWORK_OPTION,
  ProfileError,
  ProfileNetwork,
  assertSwept,
  feeCeilingStroops,
  parseNetworkId,
  profileEvidence,
  resolveProfile,
  startRun,
  sweepObservation,
  unfundedProfile,
  withRun,
  type SweepResult,
} from "./network.ts";
import { NPM_INSTALL_FLAGS, toolchainEnvironment } from "./upstream-e2e-env.ts";

const { values: args } = parseArgs({
  options: {
    "skip-build": { type: "boolean", default: false },
    only: { type: "string" },
    keep: { type: "boolean", default: false },
    write: { type: "boolean", default: false },
    "allow-branch": { type: "string" },
    bazaar: { type: "string" },
    seller: { type: "string" },
    "impostor-listing": { type: "string" },
    registry: { type: "string" },
    // Set by the run for the agent process it starts; never by an operator.
    "agent-process": { type: "boolean", default: false },
    ...NETWORK_OPTION,
  },
});

/** Whether this is the agent process, which installs and runs the packages under test. */
const AGENT_PROCESS = args["agent-process"];
if (AGENT_PROCESS && process.send === undefined) {
  throw new Error("--agent-process is set by the live agent run for the process it starts, not by hand");
}
/**
 * The run's process resolves the full profile (on pubnet the treasury file, the caps and the API key
 * file); the agent process only the network's public settings, so it can neither fund nor sign.
 */
const PROFILE = AGENT_PROCESS
  ? unfundedProfile(parseNetworkId(args.network))
  : resolveProfile(parseNetworkId(args.network));
const NETWORK = PROFILE.caip2;
const PUBNET = PROFILE.id === "pubnet";
const USDC_ADDRESS = PROFILE.usdc.contract;
const RPC_URL = PROFILE.rpcUrls[0] ?? TESTNET_RPC_URL;
if (
  args.registry !== undefined &&
  (!URL.canParse(args.registry) || new URL(args.registry).protocol !== "https:")
) {
  throw new Error("--registry needs an https URL, for example https://registry.npmjs.org/");
}

/** Hosted mode: a deployed Rail402 and demo seller instead of local processes. */
const hosted =
  args.seller === undefined && args.bazaar === undefined
    ? undefined
    : { bazaar: baseUrl(args.bazaar ?? ""), seller: baseUrl(args.seller ?? "") };
if (hosted !== undefined) {
  for (const [flag, value] of [
    ["--bazaar", args.bazaar],
    ["--seller", args.seller],
  ] as const) {
    if (value === undefined || !URL.canParse(value) || new URL(value).protocol !== "https:") {
      throw new Error(`hosted mode needs ${flag} as an https URL`);
    }
  }
}
if (PUBNET && hosted === undefined) {
  // A pubnet run never starts a Rail402 of its own: it pays a deployed seller through a deployed Rail402.
  throw new ProfileError(
    "pubnet_target_missing",
    "a pubnet run needs --bazaar and --seller as the https URLs of public deployments",
  );
}
if (args["impostor-listing"] !== undefined && hosted === undefined) {
  throw new Error("--impostor-listing names a listing in a hosted Bazaar: use it with --bazaar and --seller");
}

// Evidence is recorded only from a clean commit on main, checked before any testnet funds are spent.
const provenance = args.write ? harnessProvenance({ allowBranch: args["allow-branch"] }) : undefined;

// Standard output carries the evidence document only; the stock x402 packages log to console.log.
console.log = (...values: unknown[]) => {
  console.error(...values);
};

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PASSPHRASE = PROFILE.passphrase;
/**
 * A real token the buyer's policy does not allow: the 6-decimal test token on testnet, the XLM
 * contract on pubnet.
 */
const OTHER_ASSET = PUBNET
  ? Asset.native().contractId(PASSPHRASE)
  : "CDS45IRSWVDBV4JM2FPZ52EYXYO54J6DJL35GOSXOTRA4BYM6FFRK2BK";
/** What a pubnet payer is funded with: the most the run's agent can spend, and its session budget. */
const PUBNET_PAYER_USDC = "0.25";
/** The most payments a pubnet run makes, counted against the run's settlement cap. */
const PUBNET_MAX_PAYMENTS = 30;
/** The agent's session budget: on pubnet, all the payer holds. */
const SESSION_TOTAL = PUBNET ? PUBNET_PAYER_USDC : "1";
const USDC_DECIMALS = 7;
/** How far this machine's clock may be ahead of the catalog's when a settlement's time is compared. */
const CLOCK_SLACK_MS = 5_000;
/** How long cataloging (settlement, then the origin check) and indexing may take. */
const CATALOG_WAIT_MS = 120_000;

const atomic = (amount: string) => {
  const [whole = "0", fraction = ""] = amount.split(".");
  return BigInt(whole) * 10n ** BigInt(USDC_DECIMALS) + BigInt(fraction.padEnd(USDC_DECIMALS, "0"));
};

// --- the installed packages -----------------------------------------------------------------------

interface Installed {
  readonly project: string;
  readonly sdk: typeof Sdk;
  readonly bin: (name: "rail402" | "rail402-mcp") => string;
  /** Name → version of every package that matters, as installed. */
  readonly versions: Record<string, string>;
  /** Where the packages came from, for the evidence. */
  readonly source: string;
  /** Config entries naming each Rail402 package's tarball or registry integrity. */
  readonly integrity: Record<string, string>;
}

type Placed = Pick<Installed, "project" | "source" | "integrity">;

/** The publishable packages: every package under packages/ that is not private. */
function publishableNames(): string[] {
  const directory = join(ROOT, "packages");
  return readdirSync(directory)
    .filter((entry) => existsSync(join(directory, entry, "package.json")))
    .map(
      (entry) =>
        JSON.parse(readFileSync(join(directory, entry, "package.json"), "utf8")) as {
          name: string;
          private?: boolean;
        },
    )
    .filter((manifest) => manifest.private !== true)
    .map((manifest) => manifest.name)
    .sort();
}

/** A fresh, empty npm project under the system temp directory. */
function freshProject(): string {
  const project = mkdtempSync(join(tmpdir(), "rail402-live-agent-"));
  writeFileSync(
    join(project, "package.json"),
    `${JSON.stringify({ name: "rail402-agent", private: true, type: "module" })}\n`,
  );
  return project;
}

/**
 * `npm install` into `project`. npm resolves the dependencies from the registry, so it runs with the
 * toolchain environment only and with lifecycle scripts off: no dependency runs code while it installs.
 */
function npmInstall(project: string, specs: readonly string[]) {
  return spawnSync("npm", ["install", ...NPM_INSTALL_FLAGS, ...specs], {
    cwd: project,
    encoding: "utf8",
    env: toolchainEnvironment(process.env),
  });
}

/** Builds and checks the tarballs with pack-check, then installs them into a fresh project. */
function installTarballs(): Placed {
  log("packing and checking the publishable packages (pnpm pack:check)");
  const packCheck = runToStderr(
    process.execPath,
    [join(ROOT, "tools/pack-check/src/main.ts"), ...(args["skip-build"] ? ["--skip-build"] : [])],
    ROOT,
    toolchainEnvironment(process.env),
  );
  if (packCheck !== 0) throw new Error("pack-check failed; see its output above");
  const packed = JSON.parse(
    readFileSync(join(ROOT, "tools/pack-check/.work/pack-evidence.json"), "utf8"),
  ) as {
    packages: { name: string; version: string; integrity: string; size: number }[];
  };
  const tarballs = join(ROOT, "tools/pack-check/.work/tarballs");
  const project = freshProject();
  log(`installing the tarballs into ${project}`);
  const npm = npmInstall(
    project,
    readdirSync(tarballs).map((file) => join(tarballs, file)),
  );
  if (npm.status !== 0) throw new Error(`npm install failed: ${npm.stderr.slice(-2000)}`);
  return {
    project,
    source: "npm install of the pnpm pack tarballs",
    integrity: Object.fromEntries(
      packed.packages.map(({ name, integrity }) => [`tarball ${name}`, integrity]),
    ),
  };
}

/**
 * Installs every publishable package at this checkout's version from `registry` into a fresh project,
 * and stops unless each Rail402 package in the lockfile resolved from that registry.
 */
function installFromRegistry(registry: string): Placed {
  const { version } = JSON.parse(readFileSync(join(ROOT, "packages/sdk/package.json"), "utf8")) as {
    version: string;
  };
  const names = publishableNames();
  const project = freshProject();
  log(`installing ${String(names.length)} packages at ${version} from ${registry} into ${project}`);
  const npm = npmInstall(project, [
    "--prefer-online",
    `--registry=${registry}`,
    ...names.map((name) => `${name}@${version}`),
  ]);
  if (npm.status !== 0) throw new Error(`npm install failed: ${npm.stderr.slice(-2000)}`);
  const lock = JSON.parse(readFileSync(join(project, "package-lock.json"), "utf8")) as RegistryLock;
  const problems = registryInstallProblems(lock, { names, version, registry });
  if (problems.length > 0) {
    throw new Error(`the install is not the published ${version}: ${problems.join("; ")}`);
  }
  return {
    project,
    source: `npm install of the published ${version} packages from ${registryBase(registry)}`,
    integrity: Object.fromEntries(
      registryPackages(lock)
        .filter((entry) => names.includes(entry.name))
        .map((entry) => [`npm ${entry.name}`, entry.integrity]),
    ),
  };
}

/**
 * Installs the packages under test into a fresh project: the published ones from `--registry`, or
 * else the tarballs pack-check builds and checks. Their code is imported here, so this runs in the
 * agent process only.
 */
async function install(): Promise<Installed> {
  if (!AGENT_PROCESS)
    throw new Error("the packages under test are installed and run in the agent process only");
  const { project, source, integrity } =
    args.registry === undefined ? installTarballs() : installFromRegistry(args.registry);
  const modules = join(project, "node_modules");
  const versionOf = (name: string) =>
    (JSON.parse(readFileSync(join(modules, name, "package.json"), "utf8")) as { version: string }).version;
  const sdk = (await import(
    pathToFileURL(join(modules, "@rail402.dev/sdk/dist/index.js")).href
  )) as typeof Sdk;
  const names = [
    "@rail402.dev/sdk",
    "@rail402.dev/cli",
    "@rail402.dev/mcp",
    "@rail402.dev/safe-fetch",
    "@rail402.dev/upto",
    "@x402/core",
    "@x402/stellar",
    "@stellar/stellar-sdk",
    "@modelcontextprotocol/client",
    "@modelcontextprotocol/server",
  ];
  return {
    project,
    sdk,
    bin: (name) => join(modules, ".bin", name),
    versions: Object.fromEntries(
      names.filter((name) => existsSync(join(modules, name))).map((name) => [name, versionOf(name)]),
    ),
    source,
    integrity,
  };
}

// --- processes --------------------------------------------------------------------------------------

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runProcess(
  command: string,
  commandArgs: readonly string[],
  env: Record<string, string>,
  input?: string,
): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { env, stdio: "pipe" });
    // A seed given on stdin, as `rail402 keys import` reads it; otherwise stdin is closed at once.
    child.stdin.end(input ?? "");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

/** One `rail402 … --json` document. */
interface CliDocument {
  readonly exit: number | null;
  readonly ok: boolean;
  readonly command: string;
  readonly result?: Record<string, unknown>;
  readonly error?: { code: string; reason: string; paid: string };
}

/** Starts the installed rail402 Rail402 MCP server over stdio, keeping every frame it sends. */
async function startMcp(command: string, env: Record<string, string>, scanner: SecretScanner, label: string) {
  const transport = new StdioClientTransport({ command, env, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  const client = new Client(
    { name: "rail402-live-agent", version: "1" },
    { versionNegotiation: { mode: "auto" } },
  );
  await client.connect(transport);
  const frames: string[] = [];
  const deliver = transport.onmessage?.bind(transport);
  transport.onmessage = (...message: Parameters<NonNullable<typeof transport.onmessage>>) => {
    frames.push(JSON.stringify(message[0]));
    deliver?.(...message);
  };
  const tools = await client.listTools();
  return {
    tools: tools.tools.map((tool) => tool.name),
    /** Everything the server wrote to stderr so far: its JSON log lines. */
    stderr: () => stderr,
    call: async (name: string, toolArgs: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: toolArgs });
      return {
        isError: result.isError === true,
        content: (result.structuredContent ?? {}) as Record<string, unknown>,
      };
    },
    close: async () => {
      await client.close();
      scanner.capture(`${label}: JSON-RPC frames`, frames.join("\n"));
      scanner.capture(`${label}: tools/list`, tools);
      scanner.capture(`${label}: stderr`, stderr);
    },
  };
}

type McpServer = Awaited<ReturnType<typeof startMcp>>;

// --- the run ------------------------------------------------------------------------------------------

/** The network client every transaction of the run goes through; capped on pubnet. */
const net: LocalNetwork = PUBNET
  ? new ProfileNetwork(PROFILE)
  : new LocalNetwork(TESTNET_RPC_URL, TESTNET_FRIENDBOT_URL);

// --- the agent process ------------------------------------------------------------------------------

/**
 * What the agent process asks of the run's process on pubnet: the payer, funded by the treasury for
 * this run only (its seed reaches the installed packages), and each payment counted against the run's
 * caps.
 */
interface RunBroker {
  payer(): Promise<Keypair>;
  settlement(scheme: "exact" | "upto", what: string): Promise<void>;
}

/** What the run's process sends the agent process on pubnet once the run's funds are back. */
interface RunEnd {
  readonly sweep: SweepResult;
  readonly profile: ReturnType<typeof profileEvidence>;
  readonly treasury: string;
  readonly apiKey: "none" | "bearer, from a file";
}

type AgentRequest =
  | { readonly type: "payer"; readonly id: number }
  | { readonly type: "settlement"; readonly id: number; readonly scheme: unknown; readonly what: unknown };
type AgentMessage =
  AgentRequest | { readonly type: "cases-run" } | { readonly type: "evidence"; readonly document: unknown };
type RunMessage =
  | { readonly type: "reply"; readonly id: number; readonly secret?: string; readonly error?: string }
  | { readonly type: "end"; readonly end: RunEnd | undefined };

/**
 * The agent process's environment: this process's toolchain variables only (the allow-list the
 * upstream suite runs with: never a secret, a secret file, the run's ledger or its confirmation),
 * the primary RPC URL on pubnet (the installed CLI and MCP server are handed it too) and the upstream
 * drift the evidence records.
 */
function agentEnvironment(): Record<string, string> {
  const drift = process.env["RAIL402_UPSTREAM_DRIFT"];
  return {
    ...toolchainEnvironment(process.env),
    ...(PUBNET ? { RAIL402_PUBNET_RPC_URLS: RPC_URL } : {}),
    ...(drift === undefined ? {} : { RAIL402_UPSTREAM_DRIFT: drift }),
  };
}

/** How the run's process answers its agent process; on testnet nothing is funded or counted here. */
interface Answers {
  /** The payer's seed. */
  payer(): Promise<string>;
  settlement(scheme: "exact" | "upto", what: string): void;
}

/** The `unshare` binary; an operator or a test may point it elsewhere (or at nothing). */
const UNSHARE = process.env["RAIL402_AGENT_UNSHARE"] ?? "unshare";

/**
 * The opt-out that lets a pubnet run start without namespace isolation. The operator sets it to assert
 * that the agent process runs under a different OS user, which contains it instead.
 */
const ISOLATION_OPT_OUT = "RAIL402_PUBNET_UNISOLATED_AGENT";
const ISOLATION_OPT_OUT_VALUE = "agent-runs-as-a-separate-os-user";

/** Whether this host can give the agent process its own user, mount and PID namespaces. */
function isolationAvailable(): { ok: true } | { ok: false; reason: string } {
  const probe = spawnSync(
    UNSHARE,
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
  if (probe.error !== undefined)
    return { ok: false, reason: `${UNSHARE} is not available (${probe.error.message})` };
  if (probe.status !== 0)
    return { ok: false, reason: "this host does not allow unprivileged user, mount and PID namespaces" };
  return { ok: true };
}

/**
 * Paths the agent process must not see on pubnet, where the run holds a treasury: the directory
 * holding the treasury secret file (and so the API key file and the ledger, when they share it), and
 * the API key file and runs directory when they lie outside the worktree (the agent needs the
 * worktree itself). Each is masked in the agent's mount namespace by an empty, unreadable tmpfs (a
 * directory) or a bind over /dev/null (a file). A path already covered by a masked directory, or one
 * that does not exist (nothing to hide), is dropped, so no mask fails or targets a path a tmpfs
 * before it has already made disappear. Testnet has no treasury, so it masks nothing.
 */
function maskPaths(): string[] {
  if (!PUBNET) return [];
  const worktree = `${resolve(ROOT).replace(/\/+$/, "")}/`;
  const outside = (path: string) => !resolve(path).startsWith(worktree);
  const dirs: string[] = [];
  if (PROFILE.funding.kind === "treasury" && PROFILE.funding.secretFile !== "") {
    dirs.push(dirname(resolve(PROFILE.funding.secretFile)));
  }
  const runsDir = process.env["RAIL402_PUBNET_RUNS_DIR"];
  if (runsDir !== undefined && runsDir !== "" && outside(runsDir)) dirs.push(resolve(runsDir));
  const files: string[] = [];
  const apiKeyFile = PROFILE.facilitator.apiKeyFile;
  if (apiKeyFile !== undefined && apiKeyFile !== "" && outside(apiKeyFile)) files.push(resolve(apiKeyFile));
  const underDir = (path: string, from: readonly string[]) =>
    from.some((dir) => dir !== path && path.startsWith(`${dir}/`));
  const keptDirs = dirs.filter((dir) => existsSync(dir) && !underDir(dir, dirs));
  const keptFiles = files.filter((file) => existsSync(file) && !underDir(file, keptDirs));
  return [...keptDirs.map((dir) => `dir:${dir}`), ...keptFiles.map((file) => `file:${file}`)];
}

/**
 * How to launch the agent process. Without isolation it is this `node` with the same flags. With it,
 * `unshare` gives it fresh user, mount and PID namespaces: as the mapped root it masks each path with
 * a tmpfs or a /dev/null bind, then drops back to this user in a nested user namespace (so the agent
 * can neither unmount the masks nor override their permissions) before exec'ing the agent. The PID
 * namespace hides the run's process, so /proc holds only the agent's own processes. No network
 * namespace, so npm and the RPC still work.
 */
function agentCommand(isolate: boolean): { command: string; args: string[] } {
  const nodeArgs = [
    ...process.execArgv,
    fileURLToPath(import.meta.url),
    ...process.argv.slice(2),
    "--agent-process",
  ];
  if (!isolate) return { command: process.execPath, args: nodeArgs };
  const uid = String(process.getuid?.() ?? 0);
  const gid = String(process.getgid?.() ?? 0);
  const wrapper = [
    "set -eu",
    "uid=$1; gid=$2; shift 2",
    'while [ "$1" != "--" ]; do',
    '  case "$1" in',
    '    dir:*) mount -t tmpfs -o size=4k,mode=000,nosuid,nodev,noexec rail402-agent-mask "${1#dir:}" ;;',
    '    file:*) mount --bind /dev/null "${1#file:}" ;;',
    "  esac",
    "  shift",
    "done",
    "shift",
    'exec unshare --user --map-user="$uid" --map-group="$gid" -- "$@"',
  ].join("\n");
  return {
    command: UNSHARE,
    args: [
      "--user",
      "--map-root-user",
      "--mount",
      "--propagation",
      "private",
      "--pid",
      "--fork",
      "--kill-child",
      "--mount-proc",
      "--",
      "/bin/sh",
      "-c",
      wrapper,
      "rail402-agent",
      uid,
      gid,
      ...maskPaths(),
      "--",
      process.execPath,
      ...nodeArgs,
    ],
  };
}

/**
 * Starts this script again as the agent process and answers its requests with `answers`. With
 * `isolate`, it runs in its own user, mount and PID namespaces (`agentCommand`). Its standard output
 * goes to standard error, as every child's does: only the evidence document it sends back is printed.
 * A signal to this process ends the agent process first, before a pubnet run's sweep starts.
 */
function startAgentProcess(answers: Answers | undefined, isolate: boolean) {
  const { command, args } = agentCommand(isolate);
  const child = spawn(command, args, {
    env: agentEnvironment(),
    stdio: ["ignore", 2, 2, "ipc"],
    serialization: "advanced",
  });
  const stop = () => {
    child.kill("SIGTERM");
  };
  process.prependListener("SIGINT", stop);
  process.prependListener("SIGTERM", stop);
  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve(code ?? 1);
    });
  });
  let casesDone = false;
  let payers = 0;
  const answer = async (request: AgentRequest): Promise<RunMessage> => {
    try {
      if (answers === undefined || casesDone) throw new Error(`${request.type}: not asked for here`);
      if (request.type === "payer") {
        // One payer per run: the caps bound it too, but the agent has no reason to ask twice.
        if (++payers > 1) throw new Error("the run funds one payer");
        return { type: "reply", id: request.id, secret: await answers.payer() };
      }
      if ((request.scheme !== "exact" && request.scheme !== "upto") || typeof request.what !== "string") {
        throw new Error("a settlement names its scheme and what it paid");
      }
      answers.settlement(request.scheme, request.what.slice(0, 200));
      return { type: "reply", id: request.id };
    } catch (error) {
      return { type: "reply", id: request.id, error: error instanceof Error ? error.message : String(error) };
    }
  };
  const casesRun = new Promise<void>((resolve, reject) => {
    child.on("message", (message: AgentMessage) => {
      if (message.type === "cases-run") {
        casesDone = true;
        resolve();
        return;
      }
      if (message.type === "evidence") {
        if (typeof message.document === "string") process.stdout.write(message.document);
        return;
      }
      void answer(message).then((reply) => {
        if (child.connected) child.send(reply);
      });
    });
    void exited.then((status) => {
      reject(new Error(`the agent process ended (exit ${String(status)}) before its cases ran`));
    }, reject);
  });
  return {
    /** Resolves once the agent process ran every case; rejects when it ends before that. */
    casesRun,
    /** Lets the agent process write the evidence, with the run's end on pubnet. */
    end: (end: RunEnd | undefined) => {
      if (child.connected) child.send({ type: "end", end } satisfies RunMessage);
    },
    /** The agent process's exit status. */
    exited,
  };
}

/** The agent process's side of the channel: its requests to the run's process, and the run's end. */
function runChannel() {
  const send = (message: AgentMessage) => {
    if (process.send === undefined) throw new Error("the agent process has no channel to its run");
    process.send(message);
  };
  const pending = new Map<number, (reply: RunMessage & { type: "reply" }) => void>();
  let next = 0;
  let resolveEnd: (end: RunEnd | undefined) => void = () => undefined;
  const ended = new Promise<RunEnd | undefined>((resolve) => {
    resolveEnd = resolve;
  });
  let closing = false;
  process.on("message", (message: RunMessage) => {
    if (message.type === "end") resolveEnd(message.end);
    else {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  // The run's process is gone: nothing is funded or counted any more, so the run stops here.
  process.on("disconnect", () => {
    if (closing) return;
    log("the run's process ended; stopping the agent process");
    process.exit(1);
  });
  const request = (body: { type: "payer" } | { type: "settlement"; scheme: string; what: string }) =>
    new Promise<RunMessage & { type: "reply" }>((resolve, reject) => {
      const id = next++;
      pending.set(id, (reply) => {
        if (reply.error === undefined) resolve(reply);
        else reject(new Error(reply.error));
      });
      send({ ...body, id });
    });
  const broker: RunBroker = {
    payer: async () => Keypair.fromSecret((await request({ type: "payer" })).secret ?? ""),
    settlement: async (scheme, what) => {
      await request({ type: "settlement", scheme, what });
    },
  };
  return {
    broker,
    /** Hands an evidence document to the run's process, which prints it on its standard output. */
    print: (document: string) =>
      new Promise<void>((resolve, reject) => {
        if (process.send === undefined) throw new Error("the agent process has no channel to its run");
        process.send({ type: "evidence", document } satisfies AgentMessage, undefined, {}, (error) => {
          if (error === null) resolve();
          else reject(error);
        });
      }),
    /** Tells the run's process every case ran, and waits for the run's end. */
    casesRun: () => {
      send({ type: "cases-run" });
      return ended;
    },
    close: () => {
      closing = true;
      process.disconnect();
    },
  };
}

/** The agent process: installs the packages, runs every case, then writes the evidence. */
async function agentMain() {
  const channel = runChannel();
  const finish = await runAgent(PUBNET ? channel.broker : undefined, channel.print);
  await finish(await channel.casesRun());
  channel.close();
}

// --- the run's process ----------------------------------------------------------------------------

/**
 * Starts the agent process, which runs every case. On testnet that is the whole run. On pubnet the
 * run's ledger is claimed first (nothing is spent without RAIL402_PUBNET_RUN_CONFIRM, and the caps are
 * checked before anything is sent); this process then holds the treasury, funds the agent's payer and
 * counts its payments, and returns the run's funds to the treasury at the end, also when the agent
 * fails or the run is interrupted.
 */
async function main() {
  if (AGENT_PROCESS) {
    await agentMain();
    return;
  }
  // Whether the agent process can be sealed off from the run's process. On pubnet it is required,
  // since the run holds a mainnet treasury; a host that cannot provide it fails closed unless the
  // operator opts out and states the agent runs under a different OS user.
  const isolation = isolationAvailable();
  if (PUBNET && !isolation.ok) {
    if (process.env[ISOLATION_OPT_OUT] === ISOLATION_OPT_OUT_VALUE) {
      log(
        `the agent process cannot be isolated (${isolation.reason}); proceeding because ${ISOLATION_OPT_OUT} ` +
          "asserts it runs under a separate OS user",
      );
    } else {
      throw new ProfileError(
        "pubnet_agent_unisolated",
        `the agent process cannot be isolated from the treasury (${isolation.reason}); run on a host that ` +
          `allows unprivileged namespaces, or set ${ISOLATION_OPT_OUT}=${ISOLATION_OPT_OUT_VALUE} only when the ` +
          "agent process runs under a separate OS user that cannot read the treasury",
      );
    }
  } else if (!isolation.ok) {
    log(
      `the agent process is not isolated (${isolation.reason}); testnet uses no treasury, so this is allowed`,
    );
  }
  const isolate = isolation.ok;
  if (!PUBNET || hosted === undefined) {
    const agent = startAgentProcess(undefined, isolate);
    agent.casesRun.then(
      () => {
        agent.end(undefined);
      },
      () => undefined,
    );
    process.exitCode = await agent.exited;
    return;
  }
  const funder = await startRun("live-agent", PROFILE, net, { facilitators: [hosted.bazaar] });
  // The treasury and API key files have been read; the run no longer needs their paths in its own
  // environment. Dropping them is belt and braces (namespace isolation is the real control: a
  // process's /proc environment reflects its exec-time environment, which this does not rewrite).
  delete process.env["RAIL402_TREASURY_SECRET_FILE"];
  delete process.env["RAIL402_FACILITATOR_API_KEY_FILE"];
  try {
    funder.meter.ensure(
      {
        newAccounts: 1,
        usdcBaseUnits: atomic(PUBNET_PAYER_USDC),
        settlements: PUBNET_MAX_PAYMENTS,
        xlmStroops: feeCeilingStroops(PROFILE, "upto") * BigInt(PUBNET_MAX_PAYMENTS),
      },
      `a payer of ${PUBNET_PAYER_USDC} USDC and up to ${String(PUBNET_MAX_PAYMENTS)} payments`,
    );
  } catch (error) {
    // Nothing was sent: the claimed run ends here, and its ledger refuses any later debit.
    funder.finish();
    throw error;
  }
  let agent: ReturnType<typeof startAgentProcess> | undefined;
  const sweep = await withRun(funder, async () => {
    agent = startAgentProcess(
      {
        payer: async () => {
          // The payer's seed reaches the installed packages: it is derived for this run only, so it
          // never controls a later run's payer, and the sweep reports it if it is merged away.
          const [account] = await funder.accounts(1, PUBNET_PAYER_USDC, true, {
            role: "payer",
            perRun: true,
          });
          if (account === undefined) throw new Error("no payer account");
          return account.secret();
        },
        // The seller's facilitator settles each payment, so the run counts it here, against its caps.
        settlement: (scheme, what) => {
          funder.meter.settlement(feeCeilingStroops(PROFILE, scheme), what);
        },
      },
      isolate,
    );
    await agent.casesRun;
  });
  agent?.end({
    sweep,
    profile: profileEvidence(PROFILE, funder, sweep),
    treasury: funder.keypair.publicKey(),
    apiKey: PROFILE.facilitator.apiKeyFile === undefined ? "none" : "bearer, from a file",
  });
  process.exitCode = (await agent?.exited) ?? 1;
}

/**
 * Runs every case and returns what writes the evidence, given the run's end on pubnet. On pubnet,
 * `run` is the run's process: it funds the payer from the treasury and counts each payment against the
 * run's caps. `print` puts a printed evidence document on the run's standard output.
 */
async function runAgent(
  run: RunBroker | undefined,
  print: (document: string) => Promise<void>,
): Promise<(end: RunEnd | undefined) => Promise<void>> {
  const installed = await install();
  const { sdk } = installed;
  const recorder = new CaseRecorder(args.only?.split(",").map((id) => id.trim()));
  const directory = mkdtempSync(join(tmpdir(), "rail402-live-agent-home-"));
  const cleanups: (() => Promise<void> | void)[] = [];
  const explorerHashes = new Set<string>();
  /** Settlement hash → the Rail402 Explorer link its receipt gave. */
  const receiptLinks = new Map<string, string>();

  try {
    const models = join(ROOT, ".models");
    const embeddings = existsSync(models);
    // Everything the seller's facilitator is handed carries the buyer's signed authorization: each one
    // becomes a needle for the secret scan, whichever agent surface paid. Only a local seller shows it.
    const scanning: { scanner?: SecretScanner } = {};
    const pendingPayments: Record<string, unknown>[] = [];
    const recordPayment = (payload: unknown) => {
      if (scanning.scanner === undefined) pendingPayments.push(payload as Record<string, unknown>);
      else scanning.scanner.addPayment(payload as Record<string, unknown>, PASSPHRASE);
    };

    let bazaarUrl: string;
    let seller: string;
    let sellerPort: number;
    let payTo: string;
    let sponsor: Keypair | undefined;
    let treasury: Treasury | undefined;
    if (hosted === undefined) {
      // Rail402, local, on the public testnet.
      sponsor = Keypair.random();
      log("funding the fee sponsor with Friendbot");
      await net.fund(sponsor);
      const serviceConfig = {
        STORE: "memory",
        TESTNET_RPC_URL,
        TESTNET_SPONSOR_SECRET: sponsor.secret(),
        TESTNET_CHANNEL_COUNT: "2",
        TESTNET_MAX_TX_FEE_STROOPS: "1000000",
        TESTNET_MIN_SPONSOR_BALANCE_XLM: "1",
        RATE_LIMIT_PER_MINUTE: "0",
        DISCOVERY_ALLOW_LOOPBACK: "true",
        ORIGIN_CHECK_INTERVAL_MS: "3000",
        SEARCH_EMBEDDINGS: String(embeddings),
        SEARCH_MODEL_DIR: models,
        RAIL402_VERSION: installed.versions["@rail402.dev/sdk"] ?? "local",
      };
      log("starting Rail402 against the public testnet RPC");
      const service = await ServiceProcess.start({
        entry: join(ROOT, "apps/rail402/src/main.ts"),
        env: serviceConfig,
      });
      cleanups.push(() => service.kill("SIGTERM").then(() => undefined));
      await service.listening(180_000);
      for (let ready = false, deadline = Date.now() + 180_000; !ready;) {
        ready = (await fetch(`${service.url}/ready`).catch(() => undefined))?.status === 200;
        if (!ready && Date.now() > deadline)
          throw new Error(`Rail402 never became ready:\n${service.stderr.slice(-2000)}`);
        if (!ready) await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      bazaarUrl = service.url;

      // The seller: a fresh account with a USDC trustline, served on loopback.
      log("opening a treasury: Friendbot XLM and USDC from the testnet exchange");
      treasury = await new Treasury(net).open("1");
      const [sellerAccount] = await treasury.accounts(1, "0");
      if (sellerAccount === undefined) throw new Error("no seller account");
      payTo = sellerAccount.publicKey();
      const facilitatorClient = new HTTPFacilitatorClient({ url: service.url });
      const facilitator: FacilitatorClient = {
        getSupported: () => facilitatorClient.getSupported(),
        verify: (payload, requirements) => {
          recordPayment(payload);
          return facilitatorClient.verify(payload, requirements);
        },
        settle: (payload, requirements) => {
          recordPayment(payload);
          return facilitatorClient.settle(payload, requirements);
        },
      };
      const sellerServer = createSeller({ payTo, facilitator }).listen(0, "127.0.0.1");
      await new Promise((resolve) => sellerServer.once("listening", resolve));
      cleanups.push(async () => {
        sellerServer.closeAllConnections();
        await new Promise((resolve) => sellerServer.close(resolve));
      });
      sellerPort = (sellerServer.address() as AddressInfo).port;
      seller = `http://127.0.0.1:${String(sellerPort)}`;
    } else {
      bazaarUrl = hosted.bazaar;
      seller = hosted.seller;
      sellerPort = 443;
      payTo = await livePayTo(`${seller}/weather?city=Ankara`);
      log(`hosted run: Bazaar ${bazaarUrl}, seller ${seller} paying ${payTo}`);
    }
    const target = await readTarget(bazaarUrl, hosted === undefined ? "local" : "hosted");
    const kinds =
      (target.supported as { kinds?: { scheme: string; extra?: { facilitatorAddress?: string } }[] }).kinds ??
      [];
    const authority = kinds.find((kind) => kind.scheme === "upto")?.extra?.facilitatorAddress;
    ok(authority !== undefined, `Rail402 serves upto on ${NETWORK}`);
    const sellerStart = await net.tokenBalance(USDC_ADDRESS, payTo);

    // Sellers whose single option names another network or an asset outside the policy.
    const impostor = await startImpostor(payTo);
    cleanups.push(() => impostor.close());

    // The installed CLI and MCP server, configured through the environment only.
    const keyFile = join(directory, "payer.key");
    const env: Record<string, string> = {
      PATH: process.env["PATH"] ?? "",
      HOME: directory,
      XDG_CONFIG_HOME: join(directory, "config"),
      XDG_STATE_HOME: join(directory, "state"),
      RAIL402_NETWORK: NETWORK,
      RAIL402_RPC_URL: RPC_URL,
      RAIL402_BAZAAR_URL: bazaarUrl,
      RAIL402_SECRET_KEY_FILE: keyFile,
      RAIL402_MAX_PER_CALL: "0.05 USDC",
      RAIL402_MAX_TOTAL: `${SESSION_TOTAL} USDC`,
      // Debug: rail402-mcp logs every payment event, so a refusal shows that nothing was signed.
      RAIL402_LOG_LEVEL: "debug",
      ...(PUBNET
        ? {
            // Pubnet pins the upto settlement authorities; the run, not a person, confirms payments.
            RAIL402_UPTO_FACILITATORS: authority,
            RAIL402_MCP_CONFIRM: "never",
          }
        : {
            // The hosted seller is https on 443; plain http and loopback stay allowed for the impostor.
            // Pubnet never allows them, so there the impostor's offers are out of reach.
            RAIL402_ALLOW_HTTP: "true",
            RAIL402_ALLOW_PRIVATE_NETWORK: "loopback",
            RAIL402_ALLOWED_PORTS: `${String(sellerPort)},${String(impostor.port)}`,
          }),
    };
    /** The default egress policy: https on 443 to public addresses only. */
    const strictEnv: Record<string, string> = Object.fromEntries(
      Object.entries(env).filter(
        ([name]) =>
          !["RAIL402_ALLOW_HTTP", "RAIL402_ALLOW_PRIVATE_NETWORK", "RAIL402_ALLOWED_PORTS"].includes(name),
      ),
    );
    const cliRuns: { command: string; exit: number | null; ok: boolean; code?: string }[] = [];
    const cliCaptures: { label: string; run: Run }[] = [];
    const cli = async (
      cliArgs: readonly string[],
      extra: Record<string, string> = {},
      base: Record<string, string> = env,
      input?: string,
    ): Promise<CliDocument> => {
      // On pubnet the CLI asks before its first payment; --yes is the run's answer.
      const confirm = PUBNET && ["pay", "purchase"].includes(cliArgs[0] ?? "") ? ["--yes"] : [];
      const output = await runProcess(
        installed.bin("rail402"),
        [...cliArgs, ...confirm, "--json"],
        { ...base, ...extra },
        input,
      );
      cliCaptures.push({ label: `rail402 ${cliArgs[0] ?? ""}`, run: output });
      const lines = output.stdout.trim().split("\n");
      strictEqual(
        lines.length,
        1,
        `rail402 ${cliArgs.join(" ")} prints one JSON document: ${output.stderr.slice(-500)}`,
      );
      const document = { exit: output.status, ...(JSON.parse(lines[0] ?? "") as Omit<CliDocument, "exit">) };
      cliRuns.push({
        // The run's temporary home is machine-local: evidence names it `<home>`.
        command: `rail402 ${cliArgs
          .map((arg) => (arg.startsWith(directory) ? `<home>${arg.slice(directory.length)}` : arg))
          .map((arg) => (arg.includes(" ") ? JSON.stringify(arg) : arg))
          .join(" ")} --json`,
        exit: document.exit,
        ok: document.ok,
        ...(document.error === undefined ? {} : { code: document.error.code }),
      });
      return document;
    };

    // Onboarding: a key made by the CLI, funded by Friendbot, with a USDC trustline and testnet USDC.
    let payer: Keypair | undefined;
    if (run === undefined) {
      await recorder.run(
        spec(
          "onboarding",
          "The CLI creates a key and onboards it: Friendbot, a USDC trustline, USDC from the testnet exchange",
          ["agent-payments"],
        ),
        async (context) => {
          const created = await cli(["keys", "new", "--key-file", keyFile]);
          ok(created.ok, JSON.stringify(created.error));
          const setup = await cli(["account", "setup", "--usdc", "1"]);
          ok(setup.ok, JSON.stringify(setup.error));
          const result = setup.result as {
            address: string;
            funded: unknown;
            trustline: unknown;
            transactions: string[];
          };
          // The CLI writes a network-tagged key file; the installed SDK's parser reads it as any buyer would.
          const keyContent = sdk.parseKeyFile(readFileSync(keyFile, "utf8"));
          strictEqual(keyContent.network, "stellar:testnet", "the CLI tags the key file for testnet");
          payer = Keypair.fromSecret(keyContent.secret);
          strictEqual(result.address, payer.publicKey());
          ok(result.transactions.length >= 2, "a trustline and a swap were submitted");
          for (const hash of result.transactions) explorerHashes.add(hash);
          ok(
            (await net.tokenBalance(USDC_ADDRESS, payer.publicKey())) >= atomic("1"),
            "the payer holds 1 USDC",
          );
          context.observe("surface", "cli");
          context.observe("payer", payer.publicKey());
          context.observe(
            "classicTransactions",
            result.transactions.map((hash) => ({ hash, explorerUrl: explorerUrl(hash) })),
          );
        },
      );
    } else {
      // Pubnet: the payer is a treasury account (derived, so the run can return its funds), funded with
      // all the session may spend, and the CLI imports its seed from stdin into a key file tagged for
      // pubnet, as an operator moving a funded key to an agent does.
      await recorder.run(
        spec(
          "onboarding",
          `The CLI imports a funded key into a key file tagged for pubnet and reads its ${PUBNET_PAYER_USDC} USDC from the chain`,
          ["agent-payments"],
        ),
        async (context) => {
          const account = await run.payer();
          const imported = await cli(
            ["keys", "import", "--key-file", keyFile, "--network", NETWORK],
            {},
            env,
            `${account.secret()}\n`,
          );
          ok(imported.ok, JSON.stringify(imported.error));
          const keyContent = sdk.parseKeyFile(readFileSync(keyFile, "utf8"));
          strictEqual(keyContent.network, NETWORK, "the CLI tags the key file for pubnet");
          strictEqual(Keypair.fromSecret(keyContent.secret).publicKey(), account.publicKey());
          const status = await cli(["account", "status"]);
          ok(status.ok, JSON.stringify(status.error));
          const report = status.result as {
            address: string;
            exists: boolean;
            assets: { asset: string; trustline: boolean | null; balance?: string | null }[];
          };
          strictEqual(report.address, account.publicKey());
          strictEqual(report.exists, true);
          strictEqual(
            await net.tokenBalance(USDC_ADDRESS, account.publicKey()),
            atomic(PUBNET_PAYER_USDC),
            `the payer holds ${PUBNET_PAYER_USDC} USDC`,
          );
          payer = account;
          context.observe("surface", "cli");
          context.observe("payer", account.publicKey());
          context.observe("assets", report.assets);
        },
      );
    }
    if (payer === undefined) throw new Error("the payer could not be onboarded; nothing else can run");
    const payerKey = payer;
    const scan = new SecretScanner(payerKey.secret());
    scanning.scanner = scan;
    for (const payment of pendingPayments.splice(0)) scan.addPayment(payment, PASSPHRASE);

    // The SDK, as installed, signing through a tapped key so every preimage and signature is a needle.
    const events: unknown[] = [];
    const signer = scan.tap(sdk.KeyHolder.fromSecret(payerKey.secret()));
    const buyerOptions = (overrides: Partial<Sdk.BuyerOptions> = {}): Sdk.BuyerOptions => ({
      network: NETWORK,
      signer,
      rpcUrl: RPC_URL,
      bazaarUrl,
      facilitatorUrl: bazaarUrl,
      policy: {
        assets: [
          {
            asset: USDC_ADDRESS,
            symbol: "USDC",
            decimals: USDC_DECIMALS,
            perCall: "0.05",
            sessionTotal: SESSION_TOTAL,
          },
        ],
      },
      // On pubnet only the default egress policy: https on 443 to public addresses.
      egress: PUBNET
        ? {}
        : {
            schemes: hosted === undefined ? ["http:"] : ["https:", "http:"],
            ports: [sellerPort, impostor.port],
            allowPrivateNetwork: "loopback",
          },
      onEvent: (event) => events.push(event),
      ...overrides,
    });
    const buyer = await sdk.createBuyer(buyerOptions());
    cleanups.push(() => buyer.close());
    const maxAmount = { amount: "0.01", asset: "USDC" };

    const balances = async () => ({
      payer: await net.tokenBalance(USDC_ADDRESS, payerKey.publicKey()),
      seller: await net.tokenBalance(USDC_ADDRESS, payTo),
    });
    const settledTotal = { value: 0n };

    /** Records a settled payment: the receipt, the transaction as read from the chain, the transfer. */
    const paid = async (
      context: CaseContext,
      surface: string,
      receipt: Partial<Sdk.Receipt> | null | undefined,
      expected: { scheme: "exact" | "upto"; amount: bigint; authorized?: bigint },
    ) => {
      ok(receipt !== undefined && receipt !== null, `${surface}: a receipt`);
      strictEqual(receipt.status, "settled", `${surface}: settled`);
      strictEqual(receipt.scheme, expected.scheme);
      strictEqual(receipt.payTo, payTo);
      strictEqual(receipt.payer, payerKey.publicKey());
      const hash = receipt.transaction ?? "";
      ok(/^[0-9a-f]{64}$/.test(hash), `${surface}: a transaction hash`);
      // The installed packages link the Rail402 Explorer by default; the link is opened at the end.
      strictEqual(
        receipt.explorerUrl,
        rail402ExplorerTx(NETWORK, hash),
        `${surface}: the receipt links the Rail402 Explorer`,
      );
      receiptLinks.set(hash, receipt.explorerUrl);
      const transaction = await settledTransaction(net, hash, {
        scheme: expected.scheme,
        asset: USDC_ADDRESS,
        decimals: USDC_DECIMALS,
        amount: expected.amount,
        payerType: "G",
      });
      ok(
        transaction.transfers.some(
          (transfer) =>
            transfer.from === payerKey.publicKey() &&
            transfer.to === payTo &&
            transfer.amount === expected.amount.toString(),
        ),
        `${surface}: the chain shows ${expected.amount.toString()} from the payer to the seller`,
      );
      ok(transaction.feeSource !== payerKey.publicKey(), "the fee was sponsored");
      // The seller's facilitator sent this settlement, so the run counts it, against its caps.
      await run?.settlement(expected.scheme, `${surface}: a payment`);
      context.transaction(transaction);
      context.observe("surface", surface);
      context.observe("receipt", receipt);
      explorerHashes.add(hash);
      settledTotal.value += expected.amount;
      return hash;
    };

    /**
     * Refused with `code`, nothing paid, and the payer's balance did not move. The run's payer is a
     * fresh key, so its unchanged balance proves that nothing reached the seller. A local seller's
     * balance is checked too; a hosted seller may be paid by others at the same time.
     *
     * With `trace`, the surface's payment events during the attempt are read as well: they must hold
     * a `refused` event with the same code (the event channel is live) and no `signed` event (the
     * refusal came before any signature). The result is kept under the case's `signing` observation.
     */
    const signing = new WeakMap<CaseContext, SigningRecord[]>();
    const refused = async (
      context: CaseContext,
      surface: AgentSurface,
      operation: string,
      code: string,
      attempt: () => Promise<{ code: string; reason: string; paid: string } | undefined>,
      trace?: EventTrace,
    ) => {
      const before = await balances();
      const since = trace?.mark();
      const failure = await attempt();
      ok(failure !== undefined, `${operation}: refused`);
      strictEqual(failure.code, code, `${operation}: ${failure.reason}`);
      ok(failure.reason.trim() !== "", `${operation}: a reason`);
      strictEqual(failure.paid, "none", `${operation}: nothing paid`);
      context.rejection({
        surface: surface === "mcp-server" ? "mcp" : "http",
        operation: `${surface}: ${operation}`,
        code,
        reason: failure.reason,
      });
      if (since !== undefined) {
        const seen = since();
        ok(
          seen.refused.includes(code),
          `${operation}: a refused event with ${code} (${JSON.stringify(seen)})`,
        );
        strictEqual(seen.signed, 0, `${operation}: nothing was signed`);
        const records = signing.get(context) ?? [];
        records.push({ surface, operation, code, signedEvents: seen.signed, refusedEvents: seen.refused });
        signing.set(context, records);
        context.observe("signing", records);
      }
      const after = await balances();
      strictEqual(after.payer, before.payer, `${operation}: the payer's balance did not move`);
      if (hosted === undefined) {
        strictEqual(after.seller, before.seller, `${operation}: the seller's balance did not move`);
      }
    };
    /** The SDK's payment events, as its `onEvent` listener received them. */
    const sdkTrace: EventTrace = {
      mark: () => {
        const start = events.length;
        return () => countEvents(events.slice(start) as { type?: unknown; code?: unknown }[]);
      },
    };
    /** The CLI's payment events: `--verbose` writes them as `{"event": …}` lines on stderr. */
    const cliTrace: EventTrace = {
      mark: () => {
        const start = cliCaptures.length;
        return () =>
          countEvents(
            cliCaptures
              .slice(start)
              .flatMap(({ run }) => jsonLines(run.stderr))
              .map((line) => (line as { event?: unknown }).event as { type?: unknown; code?: unknown }),
          );
      },
    };
    /** An MCP server's payment events: at debug level it logs each as a "payment event" line. */
    const mcpTrace = (server: { stderr: () => string }): EventTrace => ({
      mark: () => {
        const start = server.stderr().length;
        return () =>
          countEvents(
            jsonLines(server.stderr().slice(start))
              .filter((line) => (line as { msg?: unknown }).msg === "payment event")
              .map((line) => line as { type?: unknown; code?: unknown }),
          );
      },
    });
    const sdkFailure = async (promise: Promise<unknown>) => {
      try {
        await promise;
        return undefined;
      } catch (error) {
        scan.capture("sdk: refusal", error);
        if (!sdk.isPaymentError(error)) throw error;
        return { code: error.code, reason: error.reason, paid: error.paid };
      }
    };

    /** Waits for search to find a listing; returns its id and its rank among the hits. */
    const findListing = async (
      query: string,
      filters: Sdk.SearchFilters,
      match: (hit: Sdk.SearchHit) => boolean,
    ): Promise<{ listingId: string; rank: number; hits: number }> => {
      const deadline = Date.now() + CATALOG_WAIT_MS;
      for (;;) {
        const page = await buyer.search(query, { ...filters, payTo });
        const index = page.hits.findIndex((hit) => match(hit) && hit.listingId !== null);
        const hit = page.hits[index];
        if (hit !== undefined && hit.listingId !== null)
          return { listingId: hit.listingId, rank: index + 1, hits: page.hits.length };
        if (Date.now() > deadline) throw new Error(`search "${query}" never found the listing`);
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
    };

    /**
     * How a listing came to be, read from `/discovery/resources`: when it was first cataloged, the
     * settlement transaction that cataloged it (its version 1), its public version history, and that
     * this run's payment counted against it (its last settlement is at or after the payment was made).
     * A local catalog is new, so this run's payment cataloged it; a hosted catalog keeps its listings
     * across runs, so there an earlier settlement to the same payTo did, and it is recorded as such.
     */
    const recordCataloging = async (
      context: CaseContext,
      listingId: string,
      payment: { readonly hash: string; readonly startedAt: number },
    ) => {
      const read = async (path: string): Promise<unknown> => {
        const response = await fetch(`${bazaarUrl}${path}`, { signal: AbortSignal.timeout(30_000) });
        ok(response.ok, `GET ${path} answered ${String(response.status)}`);
        return response.json();
      };
      type Summary = { id: string; settlements: number; firstCataloged: string; lastSettled: string };
      const deadline = Date.now() + CATALOG_WAIT_MS;
      let summary: Summary | undefined;
      for (;;) {
        const item = (await read(`/discovery/resources/${listingId}`)) as {
          rail402?: { listings?: Summary[] };
        };
        summary = item.rail402?.listings?.find((entry) => entry.id === listingId);
        // A few seconds of slack for the difference between this machine's clock and the catalog's.
        if (summary !== undefined && Date.parse(summary.lastSettled) >= payment.startedAt - CLOCK_SLACK_MS)
          break;
        if (Date.now() > deadline)
          throw new Error(`listing ${listingId} never counted the payment ${payment.hash}`);
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
      const { versions } = (await read(`/discovery/resources/${listingId}/versions`)) as {
        versions: {
          version: number;
          createdAt: string;
          cause: string;
          transaction?: string;
          owner: string;
          trust: string;
          state: string;
        }[];
      };
      const [first] = versions;
      ok(first !== undefined, "the listing has a version history");
      strictEqual(first.version, 1);
      strictEqual(first.cause, "settlement", "version 1 was created by a settlement");
      strictEqual(first.owner, payTo, "the settlement that cataloged it paid the listing's owner");
      const catalogedBy = first.transaction ?? "";
      ok(/^[0-9a-f]{64}$/.test(catalogedBy), "version 1 names its settlement transaction");
      ok(
        Math.abs(Date.parse(first.createdAt) - Date.parse(summary.firstCataloged)) < 1_000,
        "version 1 is the listing's first cataloging",
      );
      if (hosted === undefined) strictEqual(catalogedBy, payment.hash, "this run's payment cataloged it");
      explorerHashes.add(catalogedBy);
      context.observe("cataloging", {
        listingId,
        firstCataloged: summary.firstCataloged,
        catalogedBy,
        catalogedByThisRun: catalogedBy === payment.hash,
        settlements: summary.settlements,
        lastSettled: summary.lastSettled,
        versions: versions.map((version) => ({
          version: version.version,
          createdAt: version.createdAt,
          cause: version.cause,
          ...(version.transaction === undefined ? {} : { transaction: version.transaction }),
          owner: version.owner,
          trust: version.trust,
          state: version.state,
        })),
      });
    };

    const listings: { http?: string; mcp?: string } = {};
    const agentChecks = (...more: CaseSpec["checks"]) => ["agent-payments", ...more] as CaseSpec["checks"];

    await recorder.run(
      spec(
        "sdk-http-cataloged",
        "SDK: pays an HTTP API; search finds its listing, cataloged by a settlement to its payTo, which counts the payment",
        agentChecks("scheme-exact", "discovery"),
      ),
      async (context) => {
        const startedAt = Date.now();
        const result = await buyer.pay(
          { kind: "http", url: `${seller}/weather`, query: { city: "Ankara" } },
          { maxAmount },
        );
        strictEqual((result.response as { status?: number }).status, 200);
        scan.capture("sdk: result", result);
        const hash = await paid(context, "sdk", result.payment, {
          scheme: "exact",
          amount: atomic(PRICES.weather),
        });
        const found = await findListing(
          "current weather for a city",
          { type: "http" },
          (hit) => hit.resource === `${seller}/weather`,
        );
        listings.http = found.listingId;
        const listing = await buyer.listing(found.listingId);
        strictEqual(listing.owner, payTo, "the listing is bound to the settled payTo");
        await recordCataloging(context, found.listingId, { hash, startedAt });
        context.observe("resourceType", "http");
        context.observe("listingId", found.listingId);
        context.observe("search", {
          query: "current weather for a city",
          rank: found.rank,
          hits: found.hits,
        });
        context.observe("trust", listing.trust);
      },
    );

    await recorder.run(
      spec(
        "sdk-mcp-cataloged",
        "SDK: pays an MCP tool; search finds its listing, keyed by endpoint and tool name and cataloged by a settlement to its payTo, which counts the payment",
        agentChecks("scheme-exact", "discovery", "mcp"),
      ),
      async (context) => {
        const startedAt = Date.now();
        const result = await buyer.pay(
          { kind: "mcp", url: `${seller}/mcp`, toolName: "air_quality", arguments: { city: "Izmir" } },
          { maxAmount },
        );
        ok((result.response as { isError?: boolean }).isError === false, "the tool answered");
        scan.capture("sdk: result", result);
        const hash = await paid(context, "sdk", result.payment, {
          scheme: "exact",
          amount: atomic(TOOL_PRICES.airQuality),
        });
        const found = await findListing(
          "air quality for a city",
          { type: "mcp" },
          (hit) => hit.resource === `${seller}/mcp` && hit.toolName === "air_quality",
        );
        listings.mcp = found.listingId;
        const listing = await buyer.listing(found.listingId);
        strictEqual(listing.resource, `${seller}/mcp`);
        strictEqual(listing.owner, payTo);
        await recordCataloging(context, found.listingId, { hash, startedAt });
        context.observe("resourceType", "mcp");
        context.observe("listingId", found.listingId);
        context.observe("search", { query: "air quality for a city", rank: found.rank, hits: found.hits });
      },
    );

    await recorder.run(
      spec(
        "sdk-search-and-pay",
        "SDK: searches for the HTTP API and pays it through its listing",
        agentChecks("scheme-exact", "discovery"),
      ),
      async (context) => {
        const result = await buyer.searchAndPay("current weather for a city", {
          maxAmount,
          filters: { type: "http", payTo },
          call: { query: { city: "Istanbul" } },
        });
        strictEqual(result.chosen.listingId, listings.http, "the chosen result is the cataloged API");
        scan.capture("sdk: result", result);
        await paid(context, "sdk", result.payment, {
          scheme: "exact",
          amount: atomic(PRICES.weather),
        });
        context.observe("resourceType", "http");
        context.observe("listingId", result.chosen.listingId);
      },
    );

    // The MCP server, installed, over stdio.
    let mcp: McpServer | undefined;
    try {
      mcp = await startMcp(installed.bin("rail402-mcp"), env, scan, "rail402-mcp");
    } catch (error) {
      log(`rail402-mcp did not start: ${error instanceof Error ? error.message : String(error)}`);
    }
    const mcpCall = async (name: string, toolArgs: Record<string, unknown>) => {
      if (mcp === undefined) throw new Error("rail402-mcp is not running");
      return mcp.call(name, toolArgs);
    };

    await recorder.run(
      spec(
        "mcp-server-search-and-pay-tool",
        "MCP server: search_stellar_resources finds the MCP tool; pay_and_call pays it through its listing",
        agentChecks("scheme-exact", "discovery", "mcp"),
      ),
      async (context) => {
        const search = await mcpCall("search_stellar_resources", {
          query: "air quality for a city",
          type: "mcp",
          payTo,
        });
        ok(!search.isError, JSON.stringify(search.content));
        const results = (search.content["results"] ?? []) as {
          listingId?: string;
          toolName?: string;
          callable?: boolean;
          withinPolicy?: boolean;
        }[];
        const rank = results.findIndex((hit) => hit.listingId === listings.mcp) + 1;
        ok(rank > 0, "the tool's listing is among the results");
        const call = await mcpCall("pay_and_call", {
          listingId: listings.mcp,
          arguments: { city: "Bursa", pollutant: "o3" },
          spendingCap: { amount: "0.01" },
          idempotencyKey: `live-agent-mcp-${Date.now().toString(36)}`,
        });
        ok(!call.isError, JSON.stringify(call.content));
        strictEqual(call.content["paid"], true);
        await paid(context, "mcp-server", call.content["payment"] as Sdk.Receipt, {
          scheme: "exact",
          amount: atomic(TOOL_PRICES.airQuality),
        });
        context.observe("resourceType", "mcp");
        context.observe("listingId", listings.mcp);
        context.observe("search", { query: "air quality for a city", rank, hits: results.length });
        context.observe("tools", mcp?.tools);
      },
    );

    await recorder.run(
      spec(
        "mcp-server-pay-api",
        "MCP server: pay_and_call pays the HTTP API through its listing",
        agentChecks("scheme-exact", "mcp"),
      ),
      async (context) => {
        const call = await mcpCall("pay_and_call", {
          listingId: listings.http,
          query: { city: "Konya" },
          spendingCap: { amount: "0.01" },
          idempotencyKey: `live-agent-api-${Date.now().toString(36)}`,
        });
        ok(!call.isError, JSON.stringify(call.content));
        await paid(context, "mcp-server", call.content["payment"] as Sdk.Receipt, {
          scheme: "exact",
          amount: atomic(PRICES.weather),
        });
        context.observe("resourceType", "http");
        context.observe("listingId", listings.http);
        const budget = await mcpCall("get_budget", {});
        ok(!budget.isError);
        context.observe("budget", budget.content);
      },
    );

    await recorder.run(
      spec(
        "cli-purchase-tool",
        "CLI: purchase finds the MCP tool by search and pays it through its listing",
        agentChecks("scheme-exact", "mcp", "discovery"),
      ),
      async (context) => {
        const document = await cli([
          "purchase",
          "air quality for a city",
          "--pick",
          listings.mcp ?? "",
          "--args",
          '{"city":"Van","pollutant":"pm10"}',
          "--max",
          "0.01 USDC",
        ]);
        ok(document.ok && document.exit === 0, JSON.stringify(document.error));
        await paid(context, "cli", (document.result as { payment: Sdk.Receipt }).payment, {
          scheme: "exact",
          amount: atomic(TOOL_PRICES.airQuality),
        });
        context.observe("resourceType", "mcp");
        context.observe("listingId", listings.mcp);
      },
    );

    await recorder.run(
      spec(
        "cli-purchase-api",
        "CLI: purchase finds the HTTP API by search and pays it through its listing",
        agentChecks("scheme-exact", "discovery"),
      ),
      async (context) => {
        const document = await cli([
          "purchase",
          "current weather for a city",
          "--pick",
          listings.http ?? "",
          "--query",
          "city=Trabzon",
          "--max",
          "0.01 USDC",
        ]);
        ok(document.ok && document.exit === 0, JSON.stringify(document.error));
        await paid(context, "cli", (document.result as { payment: Sdk.Receipt }).payment, {
          scheme: "exact",
          amount: atomic(PRICES.weather),
        });
        context.observe("resourceType", "http");
        context.observe("listingId", listings.http);
      },
    );

    let translateHash = "";
    await recorder.run(
      spec(
        "cli-pay-idempotent",
        "CLI: pay with an idempotency key pays once; the repeat replays the stored result",
        agentChecks("scheme-exact", "idempotency"),
      ),
      async (context) => {
        const key = `live-agent-${Date.now().toString(36)}`;
        const command = [
          "pay",
          `${seller}/translate`,
          "--method",
          "POST",
          "--data",
          '{"text":"Hello","to":"tr"}',
          "--max",
          "0.01 USDC",
          "--idempotency-key",
          key,
        ];
        const first = await cli(command);
        ok(first.ok && first.exit === 0, JSON.stringify(first.error));
        translateHash = await paid(context, "cli", (first.result as { payment: Sdk.Receipt }).payment, {
          scheme: "exact",
          amount: atomic(PRICES.translate),
        });
        const before = await balances();
        const again = await cli(command);
        ok(again.ok, JSON.stringify(again.error));
        strictEqual((again.result as { replayed?: boolean }).replayed, true, "the repeat is a replay");
        strictEqual(
          (again.result as { payment: Sdk.Receipt }).payment.transaction,
          translateHash,
          "the same transaction",
        );
        const after = await balances();
        strictEqual(after.payer, before.payer, "the repeat paid nothing");
        context.observe("replayed", true);
      },
    );

    await recorder.run(
      spec(
        "cli-tx",
        "CLI: tx explains a settlement and attributes it to the facilitator",
        agentChecks("fees-sponsored"),
      ),
      async (context) => {
        ok(translateHash !== "", "a transaction to explain");
        const document = await cli(["tx", translateHash]);
        ok(document.ok, JSON.stringify(document.error));
        const report = document.result as {
          status: string;
          x402: { shape: string };
          facilitator: { attributed: boolean };
          transfers: { from: string; to: string; amount: { atomic: string } }[];
        };
        strictEqual(report.status, "SUCCESS");
        strictEqual(report.x402.shape, "exact");
        strictEqual(report.facilitator.attributed, true);
        ok(
          report.transfers.some(
            (transfer) => transfer.from === payerKey.publicKey() && transfer.to === payTo,
          ),
        );
        context.observe("report", report);
      },
    );

    // upto: the seller settles what the call used, the rest of the cap is never taken.
    const cap = atomic(METERED_PRICES.cap);
    await recorder.run(
      spec(
        "sdk-upto-api",
        "SDK: a metered API paid with upto settles the days returned, not the cap",
        agentChecks("scheme-upto"),
        "upto",
      ),
      async (context) => {
        const result = await buyer.pay(
          { kind: "http", url: `${seller}/history`, query: { city: "Ankara", days: "3" } },
          { maxAmount },
        );
        scan.capture("sdk: result", result);
        strictEqual(result.payment?.authorized.atomic, cap.toString(), "the cap was authorized");
        await paid(context, "sdk", result.payment, {
          scheme: "upto",
          amount: atomic(METERED_PRICES.perDay) * 3n,
        });
        const [budget] = (await buyer.budget()).assets;
        context.observe("budget", budget);
      },
    );

    await recorder.run(
      spec(
        "mcp-server-upto-tool",
        "MCP server: a metered MCP tool paid with upto settles the hours returned; its listing, cataloged by a settlement to its payTo, is listed at its cap",
        agentChecks("scheme-upto", "mcp", "discovery"),
        "upto",
      ),
      async (context) => {
        const startedAt = Date.now();
        const call = await mcpCall("pay_and_call", {
          resource: `${seller}/mcp`,
          toolName: "hourly_forecast",
          arguments: { city: "Antalya", hours: 4 },
          spendingCap: { amount: "0.01" },
          idempotencyKey: `live-agent-upto-${Date.now().toString(36)}`,
        });
        ok(!call.isError, JSON.stringify(call.content));
        const hash = await paid(context, "mcp-server", call.content["payment"] as Sdk.Receipt, {
          scheme: "upto",
          amount: atomic(METERED_PRICES.perHour) * 4n,
        });
        const found = await findListing(
          "hourly weather forecast",
          { type: "mcp" },
          (hit) => hit.resource === `${seller}/mcp` && hit.toolName === "hourly_forecast",
        );
        const listing = await buyer.listing(found.listingId);
        ok(
          listing.prices.some((price) => price.scheme === "upto" && price.atomic === cap.toString()),
          "listed at its cap",
        );
        context.observe("meteredListingId", found.listingId);
        await recordCataloging(context, found.listingId, { hash, startedAt });
      },
    );

    await recorder.run(
      spec(
        "cli-upto-api",
        "CLI: pay settles a metered API with upto for the days returned",
        agentChecks("scheme-upto"),
        "upto",
      ),
      async (context) => {
        const document = await cli(["pay", `${seller}/history?city=Van&days=2`, "--max", "0.02 USDC"]);
        ok(document.ok && document.exit === 0, JSON.stringify(document.error));
        await paid(context, "cli", (document.result as { payment: Sdk.Receipt }).payment, {
          scheme: "upto",
          amount: atomic(METERED_PRICES.perDay) * 2n,
        });
      },
    );

    // Refusals: none of them signs, pays or moves a balance. Each surface's payment events show the
    // refusal and no signature.
    const mainMcpTrace: EventTrace = {
      mark: () => {
        if (mcp === undefined) throw new Error("rail402-mcp is not running");
        return mcpTrace(mcp).mark();
      },
    };
    /** A CLI refusal before signing: exit status 3 and the coded error. */
    const cliRefusal = async (cliArgs: readonly string[], extra: Record<string, string> = {}) => {
      const document = await cli([...cliArgs, "--verbose"], extra);
      strictEqual(document.exit, 3, `a refusal before signing exits 3: ${JSON.stringify(document.error)}`);
      return document.error;
    };
    const mcpRefusal = async (call: Promise<{ isError: boolean; content: Record<string, unknown> }>) => {
      const result = await call;
      ok(result.isError, JSON.stringify(result.content));
      return result.content["error"] as { code: string; reason: string; paid: string };
    };
    await recorder.run(
      spec(
        "cap-below-price",
        "A spending cap below the price is refused before signing, on every surface",
        agentChecks("rejection-codes"),
      ),
      async (context) => {
        const tiny = { amount: "0.0001", asset: "USDC" };
        await refused(
          context,
          "sdk",
          "pay below the price",
          "payment_per_call_cap_exceeded",
          () =>
            sdkFailure(
              buyer.pay(
                { kind: "http", url: `${seller}/weather`, query: { city: "Ankara" } },
                { maxAmount: tiny },
              ),
            ),
          sdkTrace,
        );
        await refused(
          context,
          "mcp-server",
          "pay_and_call below the price",
          "payment_per_call_cap_exceeded",
          () =>
            mcpRefusal(
              mcpCall("pay_and_call", {
                listingId: listings.http,
                query: { city: "Ankara" },
                spendingCap: { amount: "0.0001" },
              }),
            ),
          mainMcpTrace,
        );
        await refused(
          context,
          "cli",
          "pay below the price",
          "payment_per_call_cap_exceeded",
          () => cliRefusal(["pay", `${seller}/weather?city=Ankara`, "--max", "0.0001 USDC"]),
          cliTrace,
        );
        context.observe("balancesUnchanged", true);
      },
    );

    await recorder.run(
      spec(
        "ssrf-literals",
        "Private, loopback and metadata destinations, plain http and odd ports are refused before any request",
        agentChecks("rejection-codes"),
      ),
      async (context) => {
        const strict = await sdk.createBuyer(buyerOptions({ egress: {} }));
        try {
          for (const [url, code] of [
            ["https://169.254.169.254/latest/meta-data/", "egress_destination_not_allowed"],
            ["https://0x7f.1/", "egress_destination_not_allowed"],
            ["https://2130706433/", "egress_destination_not_allowed"],
            ["https://[::ffff:127.0.0.1]/", "egress_destination_not_allowed"],
            ["https://localhost/", "egress_destination_not_allowed"],
            ["http://example.com/", "egress_scheme_not_allowed"],
            ["https://example.com:8443/", "egress_port_not_allowed"],
          ] as const) {
            await refused(context, "sdk", `pay ${url}`, code, () =>
              sdkFailure(strict.pay({ kind: "http", url }, { maxAmount })),
            );
          }
        } finally {
          await strict.close();
        }
        const strictMcp = await startMcp(
          installed.bin("rail402-mcp"),
          strictEnv,
          scan,
          "rail402-mcp (default egress)",
        );
        try {
          await refused(
            context,
            "mcp-server",
            "pay_and_call https://127.0.0.1/",
            "egress_destination_not_allowed",
            async () => {
              const call = await strictMcp.call("pay_and_call", {
                resource: "https://127.0.0.1/",
                spendingCap: { amount: "0.01" },
              });
              ok(call.isError);
              return call.content["error"] as { code: string; reason: string; paid: string };
            },
          );
        } finally {
          await strictMcp.close();
        }
        await refused(
          context,
          "cli",
          "pay the metadata address",
          "egress_destination_not_allowed",
          async () => {
            const document = await cli(
              ["pay", "https://169.254.169.254/latest/meta-data/", "--max", "0.01 USDC"],
              {},
              strictEnv,
            );
            ok(!document.ok);
            return document.error;
          },
        );
        context.observe("balancesUnchanged", true);
      },
    );

    await recorder.run(
      spec(
        "session-cap",
        "A named session with a tiny budget pays until the next payment would exceed it; then the CLI, the SDK and the MCP server sharing its ledger refuse",
        agentChecks("rejection-codes"),
      ),
      async (context) => {
        // A session total must cover the per-call ceiling, so this session's calls are capped at its total:
        // the first weather call fits, the second would exceed the session.
        const tiny = { RAIL402_MAX_PER_CALL: "0.0015 USDC" };
        const started = await cli(["session", "start", "--name", "tiny", "--max-total", "0.0015 USDC"], tiny);
        ok(started.ok, JSON.stringify(started.error));
        const weather = ["pay", `${seller}/weather?city=Ankara`, "--max", "0.01 USDC", "--session", "tiny"];
        const first = await cli(weather, tiny);
        ok(first.ok && first.exit === 0, JSON.stringify(first.error));
        await paid(context, "cli", (first.result as { payment: Sdk.Receipt }).payment, {
          scheme: "exact",
          amount: atomic(PRICES.weather),
        });
        await refused(
          context,
          "cli",
          "pay beyond the tiny session",
          "payment_session_cap_exceeded",
          () => cliRefusal(weather, tiny),
          cliTrace,
        );

        // The SDK and the MCP server open the same session in the same budget ledger file.
        const { SqliteSpendLedger } = (await import(
          pathToFileURL(join(installed.project, "node_modules/@rail402.dev/sdk/dist/sqlite/index.js")).href
        )) as typeof SdkSqlite;
        const ledger = new SqliteSpendLedger(join(directory, "state", "rail402", "ledger.sqlite"));
        try {
          const inSession = await sdk.createBuyer(
            buyerOptions({ ledger, session: { name: "tiny", autoCreate: false } }),
          );
          try {
            await refused(
              context,
              "sdk",
              "pay beyond the tiny session",
              "payment_session_cap_exceeded",
              () =>
                sdkFailure(
                  inSession.pay(
                    { kind: "http", url: `${seller}/weather`, query: { city: "Ankara" } },
                    { maxAmount },
                  ),
                ),
              sdkTrace,
            );
          } finally {
            await inSession.close();
          }
        } finally {
          ledger.close();
        }
        const sessionMcp = await startMcp(
          installed.bin("rail402-mcp"),
          { ...env, RAIL402_SESSION: "tiny" },
          scan,
          "rail402-mcp (session tiny)",
        );
        try {
          await refused(
            context,
            "mcp-server",
            "pay_and_call beyond the tiny session",
            "payment_session_cap_exceeded",
            () =>
              mcpRefusal(
                sessionMcp.call("pay_and_call", {
                  resource: `${seller}/weather`,
                  query: { city: "Ankara" },
                  spendingCap: { amount: "0.01" },
                }),
              ),
            mcpTrace(sessionMcp),
          );
        } finally {
          await sessionMcp.close();
        }
        context.observe("balancesUnchanged", true);
      },
    );

    await recorder.run(
      spec(
        "policy-refusals",
        "A network, asset, recipient or amount outside the spending policy is refused before signing, on every surface",
        agentChecks("rejection-codes"),
      ),
      async (context) => {
        // Offers on another network, in an asset outside the policy and of zero come from the
        // impostor; the recipient refusal denies the seller's own payTo.
        const offers = [
          ["network", "/network", "payment_network_not_permitted"],
          ["asset", "/asset", "payment_asset_not_permitted"],
          ["amount", "/amount", "payment_amount_not_permitted"],
        ] as const;
        // On pubnet no agent reaches a seller on plain http or loopback, where the impostor listens:
        // the configuration that would let it is itself refused, before any key is read.
        if (PUBNET) {
          const opened = await cli(["pay", `${impostor.url}/network`, "--max", "0.01 USDC"], {
            RAIL402_ALLOW_HTTP: "true",
            RAIL402_ALLOW_PRIVATE_NETWORK: "loopback",
          });
          strictEqual(opened.ok, false);
          const error = opened.error;
          ok(error !== undefined, "a coded error");
          strictEqual(error.code, "payment_policy_invalid", JSON.stringify(error));
          ok(error.reason.trim() !== "", "a reason");
          context.rejection({
            surface: "http",
            operation: "cli: plain http and loopback on pubnet",
            code: error.code,
            reason: error.reason,
          });
          context.observe("offersOutOfReach", PUBNET_UNREACHABLE_REFUSALS);
        }
        for (const [what, path, code] of PUBNET ? [] : offers) {
          await refused(
            context,
            "sdk",
            `pay an offer whose ${what} is not permitted`,
            code,
            () => sdkFailure(buyer.pay({ kind: "http", url: `${impostor.url}${path}` }, { maxAmount })),
            sdkTrace,
          );
          await refused(
            context,
            "mcp-server",
            `pay_and_call an offer whose ${what} is not permitted`,
            code,
            () =>
              mcpRefusal(
                mcpCall("pay_and_call", {
                  resource: `${impostor.url}${path}`,
                  spendingCap: { amount: "0.01" },
                }),
              ),
            mainMcpTrace,
          );
          await refused(
            context,
            "cli",
            `pay an offer whose ${what} is not permitted`,
            code,
            () => cliRefusal(["pay", `${impostor.url}${path}`, "--max", "0.01 USDC"]),
            cliTrace,
          );
        }

        const denying = await sdk.createBuyer(
          buyerOptions({
            policy: {
              assets: [
                {
                  asset: USDC_ADDRESS,
                  symbol: "USDC",
                  decimals: USDC_DECIMALS,
                  perCall: "0.05",
                  sessionTotal: "1",
                },
              ],
              recipients: { deny: [payTo] },
            },
          }),
        );
        try {
          await refused(
            context,
            "sdk",
            "pay a denied recipient",
            "payment_recipient_not_permitted",
            () =>
              sdkFailure(
                denying.pay(
                  { kind: "http", url: `${seller}/weather`, query: { city: "Ankara" } },
                  { maxAmount },
                ),
              ),
            sdkTrace,
          );
        } finally {
          await denying.close();
        }
        const deny = { RAIL402_DENIED_RECIPIENTS: payTo };
        const denyingMcp = await startMcp(
          installed.bin("rail402-mcp"),
          { ...env, ...deny },
          scan,
          "rail402-mcp (recipient denied)",
        );
        try {
          await refused(
            context,
            "mcp-server",
            "pay_and_call a denied recipient",
            "payment_recipient_not_permitted",
            () =>
              mcpRefusal(
                denyingMcp.call("pay_and_call", {
                  resource: `${seller}/weather`,
                  query: { city: "Ankara" },
                  spendingCap: { amount: "0.01" },
                }),
              ),
            mcpTrace(denyingMcp),
          );
        } finally {
          await denyingMcp.close();
        }
        await refused(
          context,
          "cli",
          "pay a denied recipient",
          "payment_recipient_not_permitted",
          () => cliRefusal(["pay", `${seller}/weather?city=Ankara`, "--max", "0.01 USDC"], deny),
          cliTrace,
        );
        strictEqual(impostor.paidRequests(), 0, "no payment ever reached the impostor");
        context.observe("balancesUnchanged", true);
      },
    );

    const impostorListing = args["impostor-listing"];
    const impostorSpec = spec(
      "listing-impostor",
      "A listing whose live payment requirements do not pay its owner is refused before signing",
      agentChecks("rejection-codes", "discovery"),
    );
    if (impostorListing === undefined) {
      recorder.skip(
        impostorSpec,
        hosted === undefined
          ? "a local run has no impostor listing; the hosted run names one with --impostor-listing"
          : "no --impostor-listing was given",
        hosted === undefined ? "not-applicable" : "environment",
      );
    } else {
      await recorder.run(impostorSpec, async (context) => {
        const listing = await buyer.listing(impostorListing);
        context.observe("impostor", {
          listingId: impostorListing,
          owner: listing.owner,
          resource: listing.resource,
          trust: listing.trust,
        });
        await refused(context, "sdk", "pay the impostor listing", "payment_listing_mismatch", () =>
          sdkFailure(
            buyer.payListing(
              impostorListing,
              listing.type === "mcp" ? { arguments: { city: "Ankara" } } : {},
              { maxAmount },
            ),
          ),
        );
        await refused(
          context,
          "mcp-server",
          "pay_and_call the impostor listing",
          "payment_listing_mismatch",
          async () => {
            const call = await mcpCall("pay_and_call", {
              listingId: impostorListing,
              arguments: { city: "Ankara" },
              spendingCap: { amount: "0.01" },
            });
            ok(call.isError);
            return call.content["error"] as { code: string; reason: string; paid: string };
          },
        );
        context.observe("balancesUnchanged", true);
      });
    }

    const custodySpec = spec(
      "non-custodial",
      "The seller received exactly what was settled, all of it from the payer; the sponsor paid fees only",
      agentChecks("fees-sponsored"),
    );
    if (hosted !== undefined) {
      recorder.skip(
        custodySpec,
        "a hosted seller may be paid by others during the run; each settlement's transfer from the payer is checked instead",
        "not-applicable",
      );
    } else {
      await recorder.run(custodySpec, async (context) => {
        const received = (await net.tokenBalance(USDC_ADDRESS, payTo)) - sellerStart;
        strictEqual(received, settledTotal.value, "the seller received the sum of the settlements");
        context.observe("settledTotal", settledTotal.value.toString());
      });
    }

    await mcp?.close();
    mcp = undefined;

    await recorder.run(
      spec(
        "explorer",
        "Every receipt's Rail402 Explorer link answers 200 naming the same hash; every transaction of the run also opens in stellar.expert (its API answers 200 with the hash and ledger), an on-chain cross-check independent of Rail402",
        agentChecks(),
      ),
      async (context) => {
        // Each link is polled on its own: an explorer that indexes from the ledgers may lag a little.
        const pages: ExplorerPageCheck[] = await Promise.all(
          [...receiptLinks].map(([hash, link]) => checkExplorerPage(link, hash)),
        );
        context.observe("receiptLinks", pages);
        const checks: ExplorerCheck[] = [];
        for (const hash of explorerHashes) {
          checks.push(await checkStellarExpert(hash, { network: PUBNET ? "public" : "testnet" }));
        }
        context.observe("transactions", checks);
        const unresolved = explorerPageProblems(NETWORK, [...receiptLinks.keys()], pages);
        strictEqual(unresolved.length, 0, unresolved.join("; "));
        const missing = checks.filter((check) => check.apiStatus !== 200);
        strictEqual(missing.length, 0, `not indexed: ${missing.map((check) => check.hash).join(", ")}`);
      },
    );

    await recorder.run(
      spec(
        "secret-scan",
        "No channel an agent or a user sees carries the payer's seed, a signature, a preimage or a signed authorization",
        agentChecks(),
      ),
      (context) => {
        for (const { label, run } of cliCaptures) {
          scan.capture(`${label}: stdout`, run.stdout);
          scan.capture(`${label}: stderr`, run.stderr);
        }
        scan.capture("sdk: events", events);
        const state = join(directory, "state");
        for (const file of listFiles(state))
          scan.capture(`state file ${file.slice(state.length + 1)}`, readFileSync(file));
        const findings = scan.findings();
        context.observe("secretScan", {
          channels: scan.channels.length,
          needles: scan.needles,
          hits: findings.length,
          ...(findings.length === 0 ? {} : { where: findings }),
        });
        ok(scan.needles > 20, `needles: ${String(scan.needles)}`);
        strictEqual(findings.length, 0, `leaks: ${JSON.stringify(findings)}`);
        return Promise.resolve();
      },
    );

    return async (end) => {
      if (end !== undefined) {
        await recorder.run(
          {
            id: "sweep-back",
            title: "the run's USDC is back in the operator treasury and its accounts are merged",
            checks: ["pubnet-config"],
          },
          (context) => {
            context.observe("sweep", sweepObservation(end.sweep));
            assertSwept(end.sweep);
            return Promise.resolve();
          },
        );
      }
      const evidence = buildEvidence(
        {
          kind: "live-agent",
          // Without --write the document is printed only; its commit may then describe a dirty tree.
          provenance: provenance ?? { commit: gitCommit().replace(/-dirty$/, ""), dirty: false },
          network: NETWORK,
          target,
          packages: installed.versions,
          command: `${
            hosted === undefined
              ? "node --conditions=@rail402/source tools/conformance/src/live-agent.ts"
              : `node --conditions=@rail402/source tools/conformance/src/live-agent.ts --bazaar ${hosted.bazaar} --seller ${hosted.seller}${impostorListing === undefined ? "" : ` --impostor-listing ${impostorListing}`}`
          }${args.registry === undefined ? "" : ` --registry ${registryBase(args.registry)}`}${PUBNET ? " --network pubnet" : ""}`,
          config: {
            mode: hosted === undefined ? "local rehearsal" : "hosted",
            rail402: hosted === undefined ? "local process, public testnet RPC" : hosted.bazaar,
            ...(PUBNET
              ? {
                  apiKey: end?.apiKey ?? "none",
                  payerFunding: `${PUBNET_PAYER_USDC} USDC from the operator treasury, returned at the end`,
                  confirmations: "rail402 --yes; RAIL402_MCP_CONFIRM=never (the run confirms)",
                }
              : {}),
            bazaar: hosted === undefined ? "the same Rail402 (memory store)" : hosted.bazaar,
            seller: hosted === undefined ? "apps/demo-seller on loopback" : hosted.seller,
            explorer:
              "the Rail402 Explorer (receipt links, the packages' default); stellar.expert as an on-chain cross-check",
            packagesFrom: installed.source,
            searchEmbeddings: embeddings,
            maxTxFeeStroops: 1_000_000,
            buyerMaxPerCall: "0.05 USDC",
            buyerMaxTotal: `${SESSION_TOTAL} USDC`,
            asset: USDC_ADDRESS,
            ...installed.integrity,
          },
          accounts: {
            payer: payerKey.publicKey(),
            payTo,
            uptoAuthority: authority,
            ...(sponsor === undefined ? {} : { sponsor: sponsor.publicKey() }),
            ...(treasury === undefined ? {} : { treasury: treasury.keypair.publicKey() }),
            ...(end === undefined ? {} : { treasury: end.treasury }),
          },
          ...(end === undefined ? {} : { profile: end.profile }),
          startedAt: recorder.startedAt,
        },
        [...recorder.cases].map((entry) =>
          entry.id === "onboarding"
            ? { ...entry, observations: { ...entry.observations, cli: cliRuns } }
            : entry,
        ),
      );
      // The document itself is a channel too.
      scan.capture("evidence", evidence);
      const leaks = scan.findings();
      if (leaks.length > 0) throw new Error(`the evidence document would leak: ${JSON.stringify(leaks)}`);
      const problems = liveAgentProblems(evidence);
      for (const problem of problems) log(`PROBLEM ${problem}`);

      if (provenance === undefined) {
        await print(`${JSON.stringify(evidence, null, 2)}\n`);
      } else if (problems.length === 0 && recorder.failed === 0) {
        recheckProvenance(provenance, { allowBranch: args["allow-branch"] });
        const file = evidenceFileName("live-agent", NETWORK, hosted === undefined ? "local" : undefined);
        log(`evidence written to ${writeEvidence(evidence, { allowBranch: args["allow-branch"], file })}`);
      } else {
        log(`nothing written to ${EVIDENCE_DIR}: the run has failures`);
      }
      log(
        `${String(evidence.summary.passed)} passed, ${String(evidence.summary.failed)} failed, ${String(evidence.summary.skipped)} skipped`,
      );
      if (recorder.failed > 0 || problems.length > 0) process.exitCode = 1;
    };
  } finally {
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch {
        // Best effort: the run's outcome is already decided.
      }
    }
    if (args.keep) log(`kept ${installed.project} and ${directory}`);
    else {
      rmSync(installed.project, { recursive: true, force: true });
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

function spec(
  id: string,
  title: string,
  checks: CaseSpec["checks"],
  scheme: "exact" | "upto" = "exact",
): CaseSpec {
  return { id, title, checks, scheme, asset: "USDC", payer: "G", payTo: "G" };
}

/** The payment events a surface emitted since `mark()`: how many were `signed`, and the refused codes. */
interface EventTrace {
  mark(): () => { signed: number; refused: string[] };
}

/** One refusal's signing record: the events its surface emitted during the attempt. */
interface SigningRecord {
  readonly surface: AgentSurface;
  readonly operation: string;
  readonly code: string;
  readonly signedEvents: number;
  readonly refusedEvents: readonly string[];
}

function countEvents(events: readonly ({ type?: unknown; code?: unknown } | undefined)[]) {
  return {
    signed: events.filter((event) => event?.type === "signed").length,
    refused: events
      .filter((event) => event?.type === "refused" && typeof event.code === "string")
      .map((event) => event?.code as string),
  };
}

/** The JSON objects among `text`'s lines; other lines are skipped. */
function jsonLines(text: string): Record<string, unknown>[] {
  return text.split("\n").flatMap((line) => {
    if (!line.trimStart().startsWith("{")) return [];
    try {
      const value = JSON.parse(line) as Record<string, unknown> | null;
      return value !== null && typeof value === "object" ? [value] : [];
    } catch {
      return [];
    }
  });
}

function listFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

/** The payTo of a seller's live 402 for `url`: its first option on this network. */
async function livePayTo(url: string): Promise<string> {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  await response.body?.cancel().catch(() => undefined);
  const header = response.headers.get("payment-required");
  if (response.status !== 402 || header === null) {
    throw new Error(`${url} answered HTTP ${String(response.status)} without PAYMENT-REQUIRED`);
  }
  const required = decodePaymentRequiredHeader(header) as {
    accepts?: { network?: string; payTo?: string }[];
  };
  const payTo = required.accepts?.find((option) => option.network === NETWORK)?.payTo;
  if (payTo === undefined) throw new Error(`${url} offers no ${NETWORK} option`);
  return payTo;
}

/**
 * A seller whose 402 offers one option the buyer's policy must refuse: `/network` asks for payment on
 * the other network, `/asset` in a token outside the policy, `/amount` for zero USDC. It counts
 * requests that carry a payment.
 */
async function startImpostor(payTo: string) {
  let paidRequests = 0;
  let url = "";
  const option = (path: string): PaymentRequirements => ({
    scheme: "exact",
    network: path === "/network" ? (PUBNET ? "stellar:testnet" : "stellar:pubnet") : NETWORK,
    asset:
      path === "/network"
        ? PUBNET
          ? USDC_TESTNET_ADDRESS
          : USDC_PUBNET_ADDRESS
        : path === "/amount"
          ? USDC_ADDRESS
          : OTHER_ASSET,
    amount: path === "/amount" ? "0" : "10000",
    payTo,
    maxTimeoutSeconds: 60,
    extra: { areFeesSponsored: true },
  });
  const server: Server = createServer((request, response) => {
    if (request.headers["payment-signature"] !== undefined) paidRequests++;
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    response
      .writeHead(402, {
        "content-type": "application/json",
        "payment-required": encodePaymentRequiredHeader({
          x402Version: 2,
          error: "Payment required",
          resource: { url: `${url}${path}` },
          accepts: [option(path)],
        }),
      })
      .end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  url = `http://127.0.0.1:${String(port)}`;
  return {
    url,
    port,
    paidRequests: () => paidRequests,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

main().catch((error: unknown) => {
  log(`FAILED: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});
