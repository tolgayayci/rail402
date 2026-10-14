/**
 * Runs the upstream x402 e2e suite against Rail402 on the Stellar testnet: every stock TypeScript
 * client and server in the suite pays through Rail402.
 *
 *   node tools/conformance/src/upstream-e2e.ts --x402 ../x402 [--schemes exact[,upto]] \
 *     [--target local | --target hosted --facilitator https://…] [--allow-version-mismatch] \
 *     [--write [--allow-branch <branch>]]
 *
 * `--x402` is a checkout of x402-foundation/x402 at the tag of the @x402/stellar version Rail402
 * depends on (`--allow-version-mismatch` accepts another version and records it), prepared as its e2e
 * README describes: `pnpm install` in e2e/, the TypeScript packages built, and `./setup.sh` run so
 * components such as the Next.js server are built.
 *
 * - `--target local` (the default) starts Rail402 from this checkout as the suite's external
 *   facilitator (tools/conformance/upstream-e2e/) with a fresh Friendbot sponsor, and then checks
 *   Rail402's Bazaar with the suite's discovery validation.
 * - `--target hosted` joins an already running Rail402 through the forwarder
 *   (tools/conformance/upstream-e2e-hosted/). The hosted service keeps its own sponsor. Bazaar
 *   validation does not run: the suite's sellers listen on localhost, which a hosted catalog refuses
 *   to reach.
 *
 * `--schemes exact,upto` also runs the suite's Stellar `upto` scenarios. Released upstream versions have
 * no Stellar `upto` mechanism, so this needs a checkout of a branch that adds it; a run from a checkout
 * that is not at a release tag is recorded as pre-merge (`upstream.preMerge: true`, file
 * `upstream-e2e-upto-premerge-…`), and the facilitator proxy declares both schemes. Against a checkout
 * without it, the suite runs `exact` and the `upto` row is recorded as skipped, with the reason.
 * Provenance must be fetchable by readers: a released checkout cites the `@x402/stellar` release tag and
 * its `origin`; any other checkout cites the first remote-tracking branch that contains its commit and
 * that remote's GitHub repository (the public fork a pre-merge branch was pushed to). `--write` refuses
 * a commit no remote branch contains.
 *
 * The local run raises the catalog's per-payer and per-payTo new-listing quotas (the suite pays every
 * route with one buyer to one payTo) and records them; the service's defaults are unchanged.
 *
 * The suite runs unmodified. The buyer is a fresh Friendbot-funded testnet account, so the run needs
 * no secrets. The seller is fresh for a local run; against a hosted service it is one fixed testnet
 * account derived from the operator's sponsor seed (the file RAIL402_SPONSOR_SECRET_FILE names), so the
 * MCP tools the suite pays for (cataloged by the hosted Bazaar) stay the same three listings across
 * reruns instead of adding more each time; without that file it is fresh. With --write the result is
 * recorded as schemaVersion 2 evidence.
 */
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Asset, Keypair, Networks, Operation } from "@stellar/stellar-sdk";
import { LocalNetwork } from "@rail402.dev/testkit";
import {
  evidenceFileName,
  harnessProvenance,
  recheckProvenance,
  writeEvidence,
  type CheckId,
  type EvidenceCase,
} from "./evidence.ts";
import { buildEvidence, readTarget, settledTransaction, type Target } from "./harness.ts";
import {
  HOSTED_BAZAAR_NOT_APPLICABLE,
  catalogOutcomes,
  githubRepository,
  missingResources,
  releaseTagFor,
} from "./upstream-e2e-output.ts";
import {
  NETWORK,
  TESTNET_FRIENDBOT_URL,
  TESTNET_RPC_URL,
  USDC,
  USDC_TESTNET_ADDRESS,
  gitCommit,
  log,
  operatorAccount,
  versions,
} from "./testnet.ts";

const { values: args } = parseArgs({
  options: {
    x402: { type: "string" },
    schemes: { type: "string", default: "exact" },
    target: { type: "string", default: "local" },
    facilitator: { type: "string" },
    "allow-version-mismatch": { type: "boolean", default: false },
    write: { type: "boolean", default: false },
    "allow-branch": { type: "string" },
  },
});

const SCHEMES = [...new Set(args.schemes.split(",").map((scheme) => scheme.trim()))];
if (!SCHEMES.includes("exact") || SCHEMES.some((scheme) => scheme !== "exact" && scheme !== "upto")) {
  // Nothing is funded for a scheme Rail402 cannot settle.
  throw new Error(`--schemes ${args.schemes}: expected exact or exact,upto`);
}
if (args.target !== "local" && args.target !== "hosted") throw new Error("--target must be local or hosted");
const HOSTED = args.target === "hosted";
if (HOSTED && args.facilitator === undefined) throw new Error("--target hosted needs --facilitator <url>");
if (!HOSTED && args.facilitator !== undefined) {
  throw new Error("--facilitator applies to --target hosted only");
}

// Evidence is recorded only from a clean commit on main, checked before any testnet funds are spent.
const provenance = args.write ? harnessProvenance({ allowBranch: args["allow-branch"] }) : undefined;

const PROXY = HOSTED ? "rail402-hosted" : "rail402";
const SUITE_ARGS = [
  "--testnet",
  "--families=stellar",
  `--facilitators=${PROXY}`,
  ...(HOSTED ? [] : ["--extensions=bazaar"]),
];

const root = fileURLToPath(new URL("../../../", import.meta.url));
/** The new-listing quotas of the local run: above what one buyer paying every suite route needs. */
const LISTING_QUOTA = 1000;
/**
 * The suite's seller against a hosted service: one testnet account derived from the operator's sponsor
 * seed (`operatorAccount`), so reruns pay the same payTo and update its listings in place, and nobody
 * else can take the account over. Without the seed file it is a fresh account.
 */
const HOSTED_SELLER = HOSTED ? operatorAccount("upstream e2e hosted seller") : undefined;
const net = new LocalNetwork(TESTNET_RPC_URL, TESTNET_FRIENDBOT_URL);

interface SuiteResult {
  readonly client: string;
  readonly server: string;
  readonly endpoint: string;
  readonly transport: string;
  readonly paymentFlow: string;
  readonly passed: boolean;
  readonly error?: string;
  readonly transaction?: string;
}

/** Suite components and modes that cannot involve a Stellar `exact` facilitator, with the reason. */
const NOT_APPLICABLE: readonly { id: string; title: string; reason: string }[] = [
  {
    id: "go-python-components",
    title: "Go and Python clients, servers and facilitators",
    reason: "the upstream Go and Python SDKs have no Stellar mechanism",
  },
  {
    id: "x402-v1-legacy",
    title: "x402 v1 (legacy) scenarios",
    reason: "Stellar exact is defined for x402 v2 only",
  },
  { id: "escrow", title: "escrow scheme scenarios", reason: "the suite has no Stellar escrow mechanism" },
  {
    id: "pubnet",
    title: "mainnet mode",
    reason: "the suite's Stellar client is built without an RPC URL, which the SDK requires on pubnet",
  },
];

async function main() {
  if (args.x402 === undefined) throw new Error("--x402 <path to an x402 checkout> is required");
  const x402 = resolve(args.x402);
  const e2e = join(x402, "e2e");
  if (USDC.contractId(Networks.TESTNET) !== USDC_TESTNET_ADDRESS)
    throw new Error("USDC issuer/contract mismatch");

  const pinned = readVersion(join(root, "tools/conformance/node_modules/@x402/stellar/package.json"));
  const upstream = readVersion(join(x402, "typescript/packages/mechanisms/stellar/package.json"));
  if (upstream !== pinned && !args["allow-version-mismatch"]) {
    throw new Error(
      `the x402 checkout has @x402/stellar ${upstream}; Rail402 depends on ${pinned} (--allow-version-mismatch runs it anyway)`,
    );
  }

  let target: Target | undefined;
  if (HOSTED) {
    target = await readTarget(args.facilitator ?? "", "hosted");
    log(`hosted facilitator ${target.facilitatorUrl} (version ${target.healthVersion})`);
  }

  // Stellar upto runs only from a checkout whose Stellar mechanism has it: a branch that adds it
  // (pre-merge) or, once released, a release tag.
  const stellarUpto = existsSync(join(x402, "typescript/packages/mechanisms/stellar/src/upto"));
  const upto = SCHEMES.includes("upto") && stellarUpto;
  const releaseTag = releaseTagFor(tagsAt(x402), upstream);
  const preMerge = upto && releaseTag === undefined;
  const published = releaseTag === undefined ? publishedBranch(x402) : undefined;
  const repository =
    published?.repository ?? githubRepository(remoteUrl(x402, "origin") ?? "") ?? "x402-foundation/x402";
  if (releaseTag === undefined && published === undefined) {
    const problem =
      "the x402 checkout is at no release tag and no remote branch contains its commit, so readers could not fetch it";
    // Checked before any testnet funds are spent.
    if (provenance !== undefined) throw new Error(`${problem}: push the branch to a public fork first`);
    log(`note: ${problem}; this run cannot be recorded`);
  }
  if (SCHEMES.includes("upto") && !stellarUpto) {
    log("the x402 checkout has no Stellar upto mechanism: running exact, recording upto as skipped");
  }

  const proxy = join(e2e, "facilitators/external-proxies", PROXY);
  mkdirSync(proxy, { recursive: true });
  const source = join(root, "tools/conformance", HOSTED ? "upstream-e2e-hosted" : "upstream-e2e");
  const config = JSON.parse(readFileSync(join(source, "test.config.json"), "utf8")) as Record<
    string,
    unknown
  >;
  writeFileSync(
    join(proxy, "test.config.json"),
    `${JSON.stringify({ ...config, schemes: upto ? ["exact", "upto"] : ["exact"] }, null, 2)}\n`,
  );
  copyFileSync(join(source, "run.sh"), join(proxy, "run.sh"));
  chmodSync(join(proxy, "run.sh"), 0o755);

  // The suite requires a Stellar facilitator key even for a hosted facilitator, which never reads it.
  const sponsor = Keypair.random();
  const buyer = Keypair.random();
  const seller = HOSTED_SELLER?.keypair ?? Keypair.random();
  if (HOSTED_SELLER?.origin === "fresh") {
    log(
      "RAIL402_SPONSOR_SECRET_FILE is not set: the hosted seller is a fresh account, so its listings are new",
    );
  }
  log(`funding sponsor ${sponsor.publicKey()}, buyer ${buyer.publicKey()}, seller ${seller.publicKey()}`);
  // Funding an account that already exists (the hosted seller on a rerun) counts as funded, and a
  // repeated trustline only restates its limit.
  await net.fund(...(HOSTED ? [buyer, seller] : [sponsor, buyer, seller]));
  await net.classic(seller, [Operation.changeTrust({ asset: USDC })]);
  await net.classic(buyer, [
    Operation.changeTrust({ asset: USDC }),
    Operation.pathPaymentStrictReceive({
      sendAsset: Asset.native(),
      sendMax: "100",
      destination: buyer.publicKey(),
      destAsset: USDC,
      destAmount: "1",
      path: [],
    }),
  ]);
  log("buyer holds 1 USDC; seller has a USDC trustline");

  const work = mkdtempSync(join(tmpdir(), "rail402-e2e-"));
  const resultsFile = join(work, "results.json");
  const targetFile = join(work, "target.json");
  const catalogFile = join(work, "catalog-outcomes.txt");
  const command = ["pnpm", "test", ...SUITE_ARGS, `--output-json=${resultsFile}`];
  log(`running ${command.join(" ")} in ${e2e}`);
  const startedAt = new Date().toISOString();
  const { code, output } = await run(command, e2e, {
    RAIL402_ROOT: root,
    FACILITATOR_STELLAR_PRIVATE_KEY: sponsor.secret(),
    CLIENT_STELLAR_PRIVATE_KEY: buyer.secret(),
    SERVER_STELLAR_ADDRESS: seller.publicKey(),
    ...(HOSTED
      ? { RAIL402_FACILITATOR_URL: target?.facilitatorUrl ?? "" }
      : {
          RAIL402_TARGET_FILE: targetFile,
          RAIL402_CATALOG_FILE: catalogFile,
          BAZAAR_MAX_NEW_LISTINGS_PER_PAYER_PER_HOUR: String(LISTING_QUOTA),
          BAZAAR_MAX_NEW_LISTINGS_PER_OWNER_PER_HOUR: String(LISTING_QUOTA),
        }),
  });

  const report = JSON.parse(readFileSync(resultsFile, "utf8")) as {
    summary: { total: number; passed: number; failed: number; durationMinutes: number };
    results: SuiteResult[];
  };
  const discovery = /Discovery Validation: (PASSED|FAILED)/.exec(output)?.[1] ?? "NOT RUN";
  const discovered = /Discovered: (\d+\/\d+)/.exec(output)?.[1];
  const missing = missingResources(output);
  target ??= localTarget(targetFile);

  const cases: EvidenceCase[] = [];
  for (const result of report.results) cases.push(await suiteCase(result));
  cases.push(
    HOSTED
      ? {
          id: "bazaar-discovery-validation",
          title: "the suite's Bazaar discovery validation",
          checks: ["discovery"],
          status: "skipped",
          skipReason: HOSTED_BAZAAR_NOT_APPLICABLE,
          elapsedMs: 0,
        }
      : {
          id: "bazaar-discovery-validation",
          title: "the suite's Bazaar discovery validation",
          checks: ["discovery", "upstream-e2e"],
          status: discovery === "PASSED" ? "passed" : "failed",
          elapsedMs: 0,
          observations: {
            result: discovery,
            ...(discovered === undefined ? {} : { discovered }),
            ...(missing.length === 0 ? {} : { missing }),
            catalogOutcomes: existsSync(catalogFile)
              ? catalogOutcomes(readFileSync(catalogFile, "utf8"))
              : {},
          },
        },
  );
  if (SCHEMES.includes("upto") && !stellarUpto) {
    cases.push({
      id: "stellar-upto",
      title: "the suite's Stellar upto scenarios",
      checks: ["upstream-e2e", "scheme-upto"],
      scheme: "upto",
      status: "skipped",
      skipReason: "no Stellar upto route upstream yet: the x402 checkout has no Stellar upto mechanism",
      elapsedMs: 0,
    });
  }
  for (const entry of NOT_APPLICABLE) {
    cases.push({
      id: entry.id,
      title: entry.title,
      checks: ["upstream-e2e"],
      status: "skipped",
      skipReason: entry.reason,
      elapsedMs: 0,
    });
  }

  const evidence = buildEvidence(
    {
      kind: "upstream-e2e",
      // Without --write the document is printed only; its commit may then describe a dirty tree.
      provenance: provenance ?? { commit: gitCommit().replace(/-dirty$/, ""), dirty: false },
      network: NETWORK,
      target,
      upstream: {
        repository,
        ref: releaseTag ?? published?.branch ?? gitRef(x402),
        commit: git(x402, "rev-parse", "HEAD"),
        version: upstream,
        preMerge,
      },
      packages: versions(["@x402/core", "@x402/stellar", "@stellar/stellar-sdk"]),
      command:
        `node tools/conformance/src/upstream-e2e.ts --x402 <x402 checkout> --schemes ${SCHEMES.join(",")} ` +
        `--target ${args.target}${HOSTED ? ` --facilitator ${target.facilitatorUrl}` : ""}`,
      config: {
        suite: `pnpm test ${SUITE_ARGS.join(" ")}`,
        suiteExitCode: code,
        suiteTotal: report.summary.total,
        suitePassed: report.summary.passed,
        suiteFailed: report.summary.failed,
        suiteMinutes: report.summary.durationMinutes,
        schemes: SCHEMES.join(","),
        stellarUptoUpstream: stellarUpto,
        versionMismatch: upstream !== pinned,
        sellerAccount: HOSTED_SELLER?.origin ?? "fresh",
        ...(HOSTED
          ? {}
          : {
              bazaarMaxNewListingsPerPayerPerHour: LISTING_QUOTA,
              bazaarMaxNewListingsPerOwnerPerHour: LISTING_QUOTA,
            }),
      },
      accounts: {
        ...(HOSTED ? {} : { sponsor: sponsor.publicKey() }),
        buyer: buyer.publicKey(),
        seller: seller.publicKey(),
      },
      startedAt,
    },
    cases,
  );
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  if (provenance !== undefined) {
    recheckProvenance(provenance, { allowBranch: args["allow-branch"] });
    const variant = [
      ...(upto ? [preMerge ? "upto-premerge" : "upto"] : []),
      ...(HOSTED ? ["hosted"] : []),
    ].join("-");
    const file = evidenceFileName("upstream-e2e", NETWORK, variant === "" ? undefined : variant);
    log(`evidence written to ${writeEvidence(evidence, { allowBranch: args["allow-branch"], file })}`);
  }
  if (code !== 0 || report.summary.total === 0 || evidence.summary.failed > 0) process.exitCode = 1;
}

/** One suite scenario as an evidence case, with its settlement read back from the chain. */
async function suiteCase(result: SuiteResult): Promise<EvidenceCase> {
  const id = [result.client, result.server, result.endpoint, result.paymentFlow]
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // The suite names Stellar upto routes by their scheme (`/upto/stellar`); every other route is exact.
  const scheme = /upto/i.test(`${result.endpoint} ${id}`) ? "upto" : "exact";
  const checks: CheckId[] = [
    ...(scheme === "upto"
      ? (["upstream-e2e", "scheme-upto"] as const)
      : (["upstream-e2e", "scheme-exact", "payload-transaction"] as const)),
    // A paid tool call by the suite's stock MCP client and server.
    ...(result.transport === "mcp" ? (["mcp"] as const) : []),
  ];
  const observations: Record<string, unknown> = {
    client: result.client,
    server: result.server,
    endpoint: result.endpoint,
    transport: result.transport,
    paymentFlow: result.paymentFlow,
    ...(result.error === undefined ? {} : { error: result.error }),
  };
  let transactions: EvidenceCase["transactions"];
  const hash = result.transaction;
  if (hash !== undefined && /^[0-9a-f]{64}$/.test(hash)) {
    try {
      const settled = await settledTransaction(net, hash, {
        scheme,
        asset: USDC_TESTNET_ADDRESS,
        decimals: 7,
        amount: "0",
        payerType: "G",
      });
      const amount = settled.transfers.reduce((sum, transfer) => sum + BigInt(transfer.amount), 0n);
      transactions = [{ ...settled, amount: amount.toString() }];
    } catch (error) {
      observations["transactionReadError"] = error instanceof Error ? error.message : String(error);
    }
  } else if (hash !== undefined) {
    observations["transaction"] = hash;
  }
  return {
    id,
    title: `${result.client} pays ${result.server} ${result.endpoint} (${result.paymentFlow})`,
    checks,
    scheme,
    asset: "USDC",
    payer: "G",
    payTo: "G",
    status: result.passed ? "passed" : "failed",
    elapsedMs: 0,
    ...(transactions === undefined ? {} : { transactions }),
    observations,
  };
}

/** The local Rail402 the suite started, as its run.sh recorded it. */
function localTarget(file: string): Target {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Target;
  } catch {
    throw new Error("the local facilitator did not record its /health and /supported (RAIL402_TARGET_FILE)");
  }
}

/** Runs a command, echoing its output to stderr and returning it (the suite logs to both streams). */
function run(command: string[], cwd: string, env: Record<string, string>) {
  return new Promise<{ code: number; output: string }>((done, fail) => {
    const [file = "", ...rest] = command;
    const child = spawn(file, rest, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      process.stderr.write(chunk);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", fail);
    child.on("close", (code) => {
      done({ code: code ?? 1, output });
    });
  });
}

function readVersion(path: string): string {
  return (JSON.parse(readFileSync(path, "utf8")) as { version: string }).version;
}

function git(cwd: string, ...rest: string[]): string {
  return execFileSync("git", rest, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/** The tags pointing at the checkout's commit. */
function tagsAt(cwd: string): string[] {
  try {
    return git(cwd, "tag", "--points-at", "HEAD")
      .split("\n")
      .filter((tag) => tag !== "");
  } catch {
    return [];
  }
}

function remoteUrl(cwd: string, remote: string): string | undefined {
  try {
    return git(cwd, "remote", "get-url", remote);
  } catch {
    return undefined;
  }
}

/**
 * The first remote-tracking branch that contains the checkout's commit and whose remote is on GitHub:
 * the branch (without the remote's name) and the remote's `owner/name`.
 */
function publishedBranch(cwd: string): { branch: string; repository: string } | undefined {
  let branches: string[];
  try {
    branches = git(cwd, "branch", "-r", "--contains", "HEAD", "--format=%(refname:short)")
      .split("\n")
      .filter((branch) => branch !== "" && !branch.endsWith("/HEAD"));
  } catch {
    return undefined;
  }
  for (const entry of branches) {
    const slash = entry.indexOf("/");
    if (slash === -1) continue;
    const repository = githubRepository(remoteUrl(cwd, entry.slice(0, slash)) ?? "");
    if (repository !== undefined) return { branch: entry.slice(slash + 1), repository };
  }
  return undefined;
}

/** The tag or branch the checkout is on, else its commit. */
function gitRef(cwd: string): string {
  for (const query of [
    ["describe", "--tags", "--exact-match"],
    ["rev-parse", "--abbrev-ref", "HEAD"],
  ]) {
    try {
      const ref = git(cwd, ...query);
      if (ref !== "" && ref !== "HEAD") return ref;
    } catch {
      // Try the next form.
    }
  }
  return git(cwd, "rev-parse", "HEAD");
}

await main();
