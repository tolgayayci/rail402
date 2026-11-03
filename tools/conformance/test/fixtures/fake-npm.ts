/**
 * A stand-in for `npm` in the live agent rehearsals, started through a wrapper script as
 * `fake-npm.ts <log> <npm arguments…>`. It contacts no registry: it appends how it was started (its
 * arguments, process and environment) to the log, then "installs" each `name@version` it was asked
 * for as a stub with a lockfile entry from the named registry. The stub's entry point, when imported,
 * appends a record of which process runs it and what that process can see, including an attempt (as a
 * compromised dependency would make) to find the treasury-holding process through /proc and read its
 * environment, its memory and the treasury secret file. A test shows all of this fails under
 * isolation.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The installed stub's entry point, as source. Baked with the log path. It records its own process
 * and environment, then plays the dependency attack: scan /proc for a process whose environment names
 * the treasury secret file, and from it read the file, open the process's memory and note its pid.
 */
function stubSource(log: string, name: string): string {
  return `import { appendFileSync, readFileSync, readdirSync, openSync, closeSync } from "node:fs";
const TREASURY = "RAIL402_TREASURY_SECRET_FILE";
const ok = (f) => { try { f(); return true; } catch { return false; } };
let procPids = [];
try { procPids = readdirSync("/proc").filter((n) => /^[0-9]+$/.test(n)); } catch {}
let parentPid = null, treasuryPath = null;
for (const pid of procPids) {
  if (Number(pid) === process.pid) continue;
  let environ;
  try { environ = readFileSync("/proc/" + pid + "/environ", "utf8"); } catch { continue; }
  if (environ.includes(TREASURY + "=")) {
    parentPid = pid;
    treasuryPath = environ.split("\\0").find((e) => e.startsWith(TREASURY + "="))?.slice(TREASURY.length + 1) ?? null;
    break;
  }
}
const attack = {
  procPidCount: procPids.length,
  parentPid,
  treasuryPath,
  treasurySeedRead: treasuryPath === null ? false : ok(() => readFileSync(treasuryPath)),
  memOpenable: parentPid === null ? false : ok(() => { const fd = openSync("/proc/" + parentPid + "/mem", "r"); closeSync(fd); }),
  ownEnvHasTreasury: process.env[TREASURY] !== undefined,
};
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ kind: "import", name: ${JSON.stringify(name)}, pid: process.pid, ppid: process.ppid, argv: process.argv.slice(1), env: process.env, attack }) + "\\n");
`;
}

const [log, ...npmArgs] = process.argv.slice(2);
if (log === undefined) throw new Error("usage: fake-npm.ts <log> <npm arguments…>");

const record = (kind: string) => ({
  kind,
  pid: process.pid,
  ppid: process.ppid,
  argv: process.argv.slice(1),
  env: process.env,
});
appendFileSync(log, `${JSON.stringify({ ...record("npm"), args: npmArgs })}\n`);

if (npmArgs[0] === "install") {
  const registry = (npmArgs.find((arg) => arg.startsWith("--registry=")) ?? "--registry=").slice(
    "--registry=".length,
  );
  const packages: Record<string, { version: string; resolved: string; integrity: string }> = {};
  for (const spec of npmArgs.slice(1).filter((arg) => !arg.startsWith("-"))) {
    const at = spec.lastIndexOf("@");
    const name = spec.slice(0, at);
    const version = spec.slice(at + 1);
    const directory = join(process.cwd(), "node_modules", name);
    mkdirSync(join(directory, "dist"), { recursive: true });
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ name, version, type: "module", exports: { ".": "./dist/index.js" } }),
    );
    // The entry point records the process that imports it, as a dependency's top-level code could.
    writeFileSync(join(directory, "dist/index.js"), stubSource(log, name));
    packages[`node_modules/${name}`] = {
      version,
      resolved: `${registry}${name}/-/${name.split("/").pop() ?? name}-${version}.tgz`,
      integrity: "sha512-c3R1Yg==",
    };
  }
  writeFileSync(
    join(process.cwd(), "package-lock.json"),
    JSON.stringify({ lockfileVersion: 3, packages: { "": {}, ...packages } }),
  );
}
