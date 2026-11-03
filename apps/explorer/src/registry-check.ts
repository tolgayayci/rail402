/**
 * Checks the published registries against the chain and against the hosted service:
 *
 * - every upto contract's instance must run the WASM the registry lists (run it before adding or
 *   changing an upto entry);
 * - with --hosted-<network>, every signer and upto settlement authority that the hosted service's
 *   `/supported` advertises for that network must have an open entry (validToLedger null) of the
 *   `rail402` facilitator in the network's current epoch (run it at launch and after every sponsor,
 *   channel or authority rotation, before the new accounts settle anything).
 *
 *   pnpm --filter @rail402.dev/explorer registry-check --pubnet-rpc https://<pubnet RPC>
 *   pnpm --filter @rail402.dev/explorer registry-check --hosted-testnet https://testnet.rail402.dev
 *
 * Options: --testnet-rpc (default https://soroban-testnet.stellar.org), --pubnet-rpc (pubnet entries
 * are skipped without it), --hosted-testnet <url>, --hosted-pubnet <url>, --skip-wasm. Exits 1 when any
 * entry differs, an advertised account is missing, or something cannot be read.
 */
import { parseArgs } from "node:util";
import { contractWasmHash } from "@rail402.dev/ledger-source";
import type { IndexNetwork, RegistrySnapshot } from "@rail402.dev/x402-index";
import { REGISTRIES } from "@rail402.dev/x402-index/registry";

export interface WasmCheck {
  readonly network: IndexNetwork;
  readonly contract: string;
  readonly expected: string;
  readonly actual: string | null;
  readonly ok: boolean;
  readonly error?: string;
}

/** Reads each upto contract's instance and compares its WASM hash with the registry. */
export async function checkUptoContracts(
  registry: RegistrySnapshot,
  rpcUrl: string,
  read: typeof contractWasmHash = contractWasmHash,
): Promise<WasmCheck[]> {
  const results: WasmCheck[] = [];
  for (const entry of registry.document.uptoContracts) {
    try {
      const found = await read(rpcUrl, entry.contract);
      results.push({
        network: registry.network,
        contract: entry.contract,
        expected: entry.wasmSha256,
        actual: found.wasmSha256,
        ok: found.wasmSha256 === entry.wasmSha256,
      });
    } catch (error) {
      results.push({
        network: registry.network,
        contract: entry.contract,
        expected: entry.wasmSha256,
        actual: null,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

/** The parts of a `/supported` answer that name the accounts a facilitator settles with. */
export interface SupportedAnswer {
  readonly kinds?: readonly {
    readonly network?: string;
    readonly extra?: { readonly facilitatorAddress?: unknown };
  }[];
  readonly signers?: Readonly<Record<string, readonly unknown[]>>;
}

export interface HostedCheck {
  readonly network: IndexNetwork;
  /** Every account `/supported` advertises for the network. */
  readonly advertised: readonly string[];
  /** Advertised accounts with no open entry of the facilitator in the current epoch. */
  readonly missing: readonly string[];
}

/**
 * The accounts a facilitator's `/supported` advertises for `registry`'s network (its signers under the
 * network or `stellar:*`, and each upto kind's `facilitatorAddress`), and those of them the registry
 * does not list as open accounts of `facilitatorId` in the network's current epoch.
 */
export function checkHostedAccounts(
  registry: RegistrySnapshot,
  supported: SupportedAnswer,
  facilitatorId = "rail402",
): HostedCheck {
  const network = registry.network;
  const advertised = new Set<string>();
  for (const [key, signers] of Object.entries(supported.signers ?? {})) {
    if (key !== network && key !== "stellar:*") continue;
    for (const signer of signers) if (typeof signer === "string") advertised.add(signer);
  }
  for (const kind of supported.kinds ?? []) {
    const authority = kind.extra?.facilitatorAddress;
    if (kind.network === network && typeof authority === "string") advertised.add(authority);
  }
  const epoch = registry.document.epochs.at(-1)?.id;
  const open = new Set(
    (registry.facilitator(facilitatorId)?.accounts ?? [])
      .filter((account) => account.epoch === epoch && account.validToLedger === null)
      .map((account) => account.address),
  );
  const listed = [...advertised].sort();
  return { network, advertised: listed, missing: listed.filter((address) => !open.has(address)) };
}

async function fetchSupported(url: string): Promise<SupportedAnswer> {
  const response = await fetch(new URL("supported", url.endsWith("/") ? url : `${url}/`), {
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${url}/supported answered ${String(response.status)}`);
  return (await response.json()) as SupportedAnswer;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    // A package manager may pass the `--` separator through.
    args: process.argv.slice(2).filter((arg) => arg !== "--"),
    options: {
      "testnet-rpc": { type: "string", default: "https://soroban-testnet.stellar.org" },
      "pubnet-rpc": { type: "string" },
      "hosted-testnet": { type: "string" },
      "hosted-pubnet": { type: "string" },
      "skip-wasm": { type: "boolean", default: false },
    },
  });
  let failed = 0;
  for (const [registry, url] of [
    [REGISTRIES["stellar:testnet"], values["hosted-testnet"]],
    [REGISTRIES["stellar:pubnet"], values["hosted-pubnet"]],
  ] as const) {
    if (url === undefined) continue;
    const result = checkHostedAccounts(registry, await fetchSupported(url));
    for (const address of result.advertised) {
      const ok = !result.missing.includes(address);
      if (!ok) failed++;
      process.stdout.write(
        `${ok ? "ok  " : "FAIL"} ${result.network} hosted ${address}${ok ? "" : " has no open rail402 entry"}\n`,
      );
    }
    if (result.advertised.length === 0) {
      failed++;
      process.stdout.write(`FAIL ${result.network} ${url}/supported advertises no account\n`);
    }
  }
  if (values["skip-wasm"]) return failed === 0 ? 0 : 1;
  const runs: [RegistrySnapshot, string][] = [[REGISTRIES["stellar:testnet"], values["testnet-rpc"]]];
  if (values["pubnet-rpc"] !== undefined) runs.push([REGISTRIES["stellar:pubnet"], values["pubnet-rpc"]]);
  for (const [registry, rpc] of runs) {
    for (const result of await checkUptoContracts(registry, rpc)) {
      if (!result.ok) failed++;
      process.stdout.write(
        `${result.ok ? "ok  " : "FAIL"} ${result.network} ${result.contract} ${result.actual ?? result.error ?? ""}\n`,
      );
    }
  }
  if (values["pubnet-rpc"] === undefined) process.stdout.write("pubnet entries skipped (no --pubnet-rpc)\n");
  return failed === 0 ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1] ?? ""}`) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`registry-check: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
