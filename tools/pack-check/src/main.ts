/**
 * Proves the publishable packages install and run from their tarballs alone, the way a developer
 * gets them from npm:
 *
 *   1. build the workspace;
 *   2. `pnpm pack` every public package under packages/ into tools/pack-check/.work/tarballs;
 *   3. check each tarball: manifest (lockstep version, no workspace specifiers, optional peers,
 *      licence), files (package.json, README.md, LICENSE, published directories only) and entry
 *      points (exports, bins with a node shebang);
 *   4. `npm install` every tarball into an empty project under the system temp directory, third-party
 *      dependencies from the registry, and check that each Rail402 package came from its tarball;
 *   5. smoke the install: import every entry point, `rail402 --version` and `--help`,
 *      `rail402-mcp --help`, an MCP `tools/list` over stdio with the installed server, and a
 *      TypeScript consumer compiled against the installed type declarations;
 *   6. run the licence policy over every installed package;
 *   7. write the evidence: names, versions, sha512 integrity, sizes, file lists, node and npm
 *      versions and the install summary.
 *
 *   pnpm pack:check [--skip-build] [--keep] [--write]
 *
 * Without --write the evidence goes to tools/pack-check/.work/pack-evidence.json; with --write, from
 * a clean working tree only, to tools/pack-check/evidence/pack-<version>.json. Nothing is published.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { judge } from "@rail402.dev/license-gate";
import {
  binsOf,
  entryPointProblems,
  fileProblems,
  importableSubpaths,
  licenseOf,
  lockName,
  lockProblems,
  manifestProblems,
  type PackageLock,
  type PackedManifest,
} from "./checks.ts";

const { values: args } = parseArgs({
  options: {
    "skip-build": { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
    write: { type: "boolean", default: false },
  },
});

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const WORK = join(ROOT, "tools/pack-check/.work");
const TARBALLS = join(WORK, "tarballs");
const EXTRACTED = join(WORK, "extracted");

const log = (message: string) => {
  process.stderr.write(`pack-check: ${message}\n`);
};

class CheckFailed extends Error {}
const failures: string[] = [];
const fail = (where: string, problems: readonly string[]) => {
  for (const problem of problems) failures.push(`${where}: ${problem}`);
};

function run(
  command: string,
  commandArgs: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function must(
  command: string,
  commandArgs: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const result = run(command, commandArgs, options);
  if (result.status !== 0) {
    throw new CheckFailed(
      `${command} ${commandArgs.join(" ")} exited ${String(result.status)}:\n${result.stderr.slice(-2000)}`,
    );
  }
  return result.stdout;
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names the shape it reads
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

/** Every file under `directory`, relative to it, sorted. */
function listFiles(directory: string, prefix = ""): string[] {
  return readdirSync(join(directory, prefix), { withFileTypes: true })
    .flatMap((entry) => {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      return entry.isDirectory() ? listFiles(directory, path) : [path];
    })
    .sort();
}

interface Publishable {
  readonly name: string;
  readonly version: string;
  readonly directory: string;
}

/** The public workspace packages under packages/. */
function publishable(): Publishable[] {
  return readdirSync(join(ROOT, "packages"))
    .map((entry) => join(ROOT, "packages", entry))
    .filter((directory) => existsSync(join(directory, "package.json")))
    .map((directory) => ({
      directory,
      manifest: readJson<{ name: string; version: string; private?: boolean }>(
        join(directory, "package.json"),
      ),
    }))
    .filter(({ manifest }) => manifest.private !== true)
    .map(({ directory, manifest }) => ({ name: manifest.name, version: manifest.version, directory }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

interface PackedPackage {
  readonly name: string;
  readonly version: string;
  readonly tarball: string;
  readonly integrity: string;
  readonly size: number;
  readonly unpackedSize: number;
  readonly files: readonly string[];
  readonly bins: Record<string, string>;
  readonly subpaths: readonly string[];
  readonly optionalPeers: readonly string[];
}

function pack(target: Publishable, version: string): PackedPackage {
  const before = new Set(readdirSync(TARBALLS));
  must("pnpm", ["pack", "--pack-destination", TARBALLS], { cwd: target.directory });
  const created = readdirSync(TARBALLS).filter((file) => !before.has(file));
  if (created.length !== 1 || created[0] === undefined)
    throw new CheckFailed(`${target.name}: pnpm pack made ${String(created.length)} files`);
  const tarball = join(TARBALLS, created[0]);
  const bytes = readFileSync(tarball);
  const directory = join(EXTRACTED, target.name.replace("/", "__"));
  mkdirSync(directory, { recursive: true });
  must("tar", ["-xzf", tarball, "-C", directory]);
  const root = join(directory, "package");
  const files = listFiles(root);
  const manifest = readJson<PackedManifest>(join(root, "package.json"));
  const read = (file: string) =>
    existsSync(join(root, file)) ? readFileSync(join(root, file), "utf8") : undefined;
  fail(target.name, manifestProblems(manifest, { name: target.name, version }));
  fail(target.name, fileProblems(files, manifest));
  fail(target.name, entryPointProblems(manifest, files, read));
  if (read("LICENSE") !== readFileSync(join(ROOT, "LICENSE"), "utf8"))
    fail(target.name, ["LICENSE is not the repository's Apache-2.0 licence"]);
  if ((read("README.md") ?? "").trim().length < 200) fail(target.name, ["README.md is empty or a stub"]);
  const meta = (manifest.peerDependenciesMeta ?? {}) as Record<string, { optional?: boolean }>;
  return {
    name: target.name,
    version,
    tarball: relative(ROOT, tarball),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    size: bytes.length,
    unpackedSize: files.reduce((total, file) => total + statSync(join(root, file)).size, 0),
    files,
    bins: binsOf(manifest),
    subpaths: importableSubpaths(manifest),
    optionalPeers: Object.keys(meta).filter((name) => meta[name]?.optional === true),
  };
}

/** Imports every entry point from the consumer project; an optional peer that is absent is reported. */
function importEntryPoints(project: string, packed: readonly PackedPackage[]) {
  const results: { specifier: string; status: "loaded" | "needs-optional-peer"; peer?: string }[] = [];
  for (const entry of packed) {
    for (const subpath of entry.subpaths) {
      const specifier = subpath === "." ? entry.name : `${entry.name}/${subpath.replace(/^\.\//, "")}`;
      const loaded = run(
        process.execPath,
        ["--input-type=module", "-e", `await import(${JSON.stringify(specifier)});`],
        {
          cwd: project,
        },
      );
      if (loaded.status === 0) {
        results.push({ specifier, status: "loaded" });
        continue;
      }
      const peer = entry.optionalPeers.find((name) =>
        loaded.stderr.includes(`Cannot find package '${name}'`),
      );
      if (peer !== undefined) {
        results.push({ specifier, status: "needs-optional-peer", peer });
        continue;
      }
      fail(specifier, [`import failed: ${loaded.stderr.trim().split("\n").slice(-3).join(" | ")}`]);
    }
  }
  return results;
}

/** A consumer written against the published types; compiled with the repository's TypeScript. */
const CONSUMER = `import { KeyHolder, createBuyer, explorerUrl, type Buyer, type CallResult } from "@rail402.dev/sdk";
import { exact, httpRoute, param, upto } from "@rail402.dev/sdk/seller";
import { createSafeFetch } from "@rail402.dev/safe-fetch";
import { TESTNET } from "@rail402.dev/stellar";
import { UptoStellarScheme } from "@rail402.dev/upto/client";

export async function buy(secret: string): Promise<CallResult> {
  const buyer: Buyer = await createBuyer({ network: TESTNET, signer: KeyHolder.fromSecret(secret) });
  try {
    return await buyer.pay(
      { kind: "http", url: "https://demo.rail402.dev/weather", query: { city: "Ankara" } },
      { maxAmount: { amount: "0.01", asset: "USDC" } },
    );
  } finally {
    await buyer.close();
  }
}

export const route = httpRoute({
  method: "GET",
  path: "/weather",
  description: "Current weather for a city",
  payment: [
    exact({ network: TESTNET, payTo: "GAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSW2IVM4S5DP42RBW3K6BTODB4A", price: "$0.001" }),
    upto({ network: TESTNET, payTo: "GAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSW2IVM4S5DP42RBW3K6BTODB4A", maxPrice: "$0.01" }),
  ],
  query: { city: param.string({ description: "City name", required: true, example: "Ankara" }) },
});
export const link: string = explorerUrl(TESTNET, "0".repeat(64));
export const fetcher = createSafeFetch();
export const scheme: string = UptoStellarScheme.name;
`;

function compileConsumer(project: string) {
  writeFileSync(join(project, "consumer.ts"), CONSUMER);
  writeFileSync(
    join(project, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "es2024",
          module: "nodenext",
          moduleResolution: "nodenext",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: ["node"],
        },
        files: ["consumer.ts"],
      },
      null,
      2,
    )}\n`,
  );
  const tsc = join(ROOT, "node_modules/typescript/bin/tsc");
  const compiled = run(process.execPath, [tsc, "-p", "tsconfig.json"], { cwd: project });
  if (compiled.status !== 0) fail("consumer.ts", [`tsc failed:\n${compiled.stdout}${compiled.stderr}`]);
  return {
    typescript: readJson<{ version: string }>(join(ROOT, "node_modules/typescript/package.json")).version,
    ok: compiled.status === 0,
  };
}

/** The MCP handshake a host makes with the installed `rail402-mcp`: initialize, then tools/list. */
async function listMcpTools(project: string, home: string): Promise<string[]> {
  const transport = new StdioClientTransport({
    command: join(project, "node_modules/.bin/rail402-mcp"),
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: home,
      RAIL402_NETWORK: "stellar:testnet",
      RAIL402_LOG_LEVEL: "error",
    },
    stderr: "pipe",
  });
  const client = new Client(
    { name: "rail402-pack-check", version: "1" },
    { versionNegotiation: { mode: "auto" } },
  );
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    return tools.map((tool) => tool.name).sort();
  } finally {
    await client.close();
  }
}

/** The licence policy over every installed package, as production dependencies. */
function licenceCheck(project: string, lock: PackageLock) {
  let checked = 0;
  const licences = new Map<string, number>();
  for (const path of Object.keys(lock.packages ?? {})) {
    if (path === "" || !path.includes("node_modules/")) continue;
    const manifestPath = join(project, path, "package.json");
    if (!existsSync(manifestPath)) continue; // an optional dependency for another platform
    const manifest = readJson<{ name?: string; version?: string; license?: unknown; licenses?: unknown }>(
      manifestPath,
    );
    const license = licenseOf(manifest);
    const verdict = judge(
      { name: manifest.name ?? lockName(path), version: manifest.version ?? "", license },
      "production",
    );
    if (!verdict.ok)
      fail(`licence ${lockName(path)}@${manifest.version ?? ""}`, [`${license}: ${verdict.problem}`]);
    licences.set(license, (licences.get(license) ?? 0) + 1);
    checked++;
  }
  return {
    packages: checked,
    licences: Object.fromEntries([...licences].sort(([a], [b]) => a.localeCompare(b))),
  };
}

function gitState() {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  const changes = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.slice(3).startsWith("tools/pack-check/evidence/"));
  return { commit, dirty: changes.length > 0 };
}

async function main() {
  const started = new Date().toISOString();
  const git = gitState();
  if (args.write && git.dirty)
    throw new CheckFailed("--write records evidence from a clean working tree only; commit first");
  const targets = publishable();
  const versions = new Set(targets.map((target) => target.version));
  const [version] = versions;
  if (versions.size !== 1 || version === undefined)
    throw new CheckFailed(`packages are not in lockstep: ${[...versions].join(", ")}`);
  log(`${String(targets.length)} publishable packages at ${version}`);

  if (!args["skip-build"]) {
    log("building the workspace");
    must("pnpm", ["-r", "run", "build"]);
  }
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(TARBALLS, { recursive: true });
  mkdirSync(EXTRACTED, { recursive: true });
  const packed = targets.map((target) => {
    log(`packing ${target.name}`);
    return pack(target, version);
  });

  const project = mkdtempSync(join(tmpdir(), "rail402-pack-check-"));
  const home = join(project, ".home");
  mkdirSync(home);
  let install: Record<string, unknown>;
  let smoke: Record<string, unknown>;
  let licences: ReturnType<typeof licenceCheck> | undefined;
  try {
    writeFileSync(
      join(project, "package.json"),
      `${JSON.stringify({ name: "rail402-consumer", private: true, type: "module" }, null, 2)}\n`,
    );
    const typesNode = readJson<{ version: string }>(
      join(ROOT, "node_modules/@types/node/package.json"),
    ).version;
    log(`installing the tarballs into ${project}`);
    const npmEnv = {
      ...process.env,
      npm_config_update_notifier: "false",
      npm_config_fund: "false",
      npm_config_audit: "false",
    };
    must(
      "npm",
      [
        "install",
        "--no-audit",
        "--no-fund",
        ...packed.map((entry) => join(ROOT, entry.tarball)),
        `@types/node@${typesNode}`,
      ],
      {
        cwd: project,
        env: npmEnv,
      },
    );
    const lock = readJson<PackageLock>(join(project, "package-lock.json"));
    fail("install", lockProblems(lock, { names: packed.map((entry) => entry.name), version }));
    install = {
      lockfileVersion: lock.lockfileVersion,
      packages: Object.keys(lock.packages ?? {}).filter((path) => path !== "").length,
      rail402: Object.fromEntries(
        Object.entries(lock.packages ?? {})
          .filter(([path]) => lockName(path).startsWith("@rail402.dev/"))
          .map(([path, entry]) => [
            lockName(path),
            // The tarball's name only: the absolute path says nothing about the install.
            { version: entry.version, resolved: `file:${(entry.resolved ?? "").split("/").pop() ?? ""}` },
          ]),
      ),
    };

    log("importing every entry point");
    const imports = importEntryPoints(project, packed);
    const bin = (name: string, binArgs: string[]) =>
      run(join(project, "node_modules/.bin", name), binArgs, {
        cwd: project,
        env: { PATH: process.env["PATH"] ?? "", HOME: home },
      });
    const cliVersion = bin("rail402", ["--version"]);
    if (cliVersion.status !== 0 || !cliVersion.stdout.includes(version))
      fail("rail402 --version", [
        `printed "${cliVersion.stdout.trim()}" (exit ${String(cliVersion.status)})`,
      ]);
    const cliHelp = bin("rail402", ["--help"]);
    if (cliHelp.status !== 0 || !cliHelp.stdout.includes("purchase"))
      fail("rail402 --help", [`exit ${String(cliHelp.status)}`]);
    const mcpHelp = bin("rail402-mcp", ["--help"]);
    if (mcpHelp.status !== 0 || !mcpHelp.stdout.includes("RAIL402_"))
      fail("rail402-mcp --help", [`exit ${String(mcpHelp.status)}`]);
    const mcpVersion = bin("rail402-mcp", ["--version"]);
    log("listing the installed MCP server's tools over stdio");
    const tools = await listMcpTools(project, home).catch((error: unknown) => {
      fail("rail402-mcp tools/list", [error instanceof Error ? error.message : String(error)]);
      return [] as string[];
    });
    for (const expected of ["get_budget", "pay_and_call", "search_stellar_resources"]) {
      if (!tools.includes(expected)) fail("rail402-mcp tools/list", [`${expected} is missing`]);
    }
    log("compiling a TypeScript consumer against the installed declarations");
    const consumer = compileConsumer(project);
    log("checking every installed package's licence");
    licences = licenceCheck(project, lock);
    smoke = {
      imports,
      rail402Version: cliVersion.stdout.trim(),
      rail402McpVersion: mcpVersion.stdout.trim(),
      mcpTools: tools,
      consumer,
    };
  } finally {
    if (args.keep) log(`kept the consumer project at ${project}`);
    else rmSync(project, { recursive: true, force: true });
  }

  const evidence = {
    kind: "pack-check",
    version,
    startedAt: started,
    finishedAt: new Date().toISOString(),
    commit: git.commit,
    dirty: git.dirty,
    node: process.version,
    npm: must("npm", ["--version"]).trim(),
    pnpm: must("pnpm", ["--version"]).trim(),
    command: "pnpm pack:check",
    published: false,
    packages: packed.map(({ name, version: packedVersion, integrity, size, unpackedSize, files, bins }) => ({
      name,
      version: packedVersion,
      integrity,
      size,
      unpackedSize,
      fileCount: files.length,
      files,
      ...(Object.keys(bins).length === 0 ? {} : { bins }),
    })),
    install,
    smoke,
    licences,
    problems: failures,
  };
  const target = args.write
    ? join(ROOT, "tools/pack-check/evidence", `pack-${version}.json`)
    : join(WORK, "pack-evidence.json");
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, `${JSON.stringify(evidence, null, 2)}\n`);
  log(`evidence written to ${relative(ROOT, target)}`);
  if (failures.length > 0) {
    for (const failure of failures) log(`FAIL ${failure}`);
    process.exitCode = 1;
    return;
  }
  log(`ok: ${String(packed.length)} packages packed, installed from their tarballs and smoke-tested`);
}

main().catch((error: unknown) => {
  log(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
