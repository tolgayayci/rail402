import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Account, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { USDC_PUBNET_ADDRESS, USDC_TESTNET_ADDRESS } from "@x402/stellar";
import { afterAll, describe, expect, it } from "vitest";
import {
  ProfileError,
  ProfileNetwork,
  SpendMeter,
  TESTNET_PROFILE,
  feeCeilingStroops,
  parseNetworkId,
  refusePubnet,
  resolveProfile,
  runMaterial,
  startRun,
  withRun,
  type Funder,
  type ResolveOptions,
  type SweepResult,
} from "../src/network.ts";
import { RunLedger, ledgerPath, runIdFor } from "../src/run-ledger.ts";
import { TESTNET_RPC_URL } from "../src/testnet.ts";

const dir = mkdtempSync(join(tmpdir(), "rail402-network-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const secret = join(dir, "treasury.txt");
writeFileSync(secret, `${Keypair.random().secret()}\n`);
chmodSync(secret, 0o600);

const env = {
  RAIL402_PUBNET_RPC_URLS: "https://rpc-a.example, https://rpc-b.example",
  RAIL402_TREASURY_SECRET_FILE: secret,
  RAIL402_PUBNET_MAX_SPEND_XLM: "5",
  RAIL402_PUBNET_MAX_SPEND_USDC: "2.5",
  RAIL402_PUBNET_MAX_SETTLEMENTS: "100",
  RAIL402_PUBNET_MAX_NEW_ACCOUNTS: "6",
  RAIL402_PUBNET_RUN_MAX_XLM: "20",
  RAIL402_PUBNET_RUN_MAX_USDC_LOSS: "0.5",
  PUBNET_MAX_TX_FEE_STROOPS: "300000",
};
/** No published pubnet record unless a test writes one. */
const noRecord = join(dir, "no-record.json");
const pubnet = (overrides: Record<string, string | undefined> = {}, options: ResolveOptions = {}) =>
  resolveProfile("pubnet", { env: { ...env, ...overrides }, uptoRecord: noRecord, ...options });
const CONTRACT = "CBTVKCHLSGQ3WSV3NKSU6FZR4FZMC6ENMDMXUS5XQ66HYVUUHYE3TU7U";
const HASH = "cc2d2fefe77d1a470abe88be8563679a9d40f49c127683947784c0cb2d0ca797";

const refusal = (run: () => unknown) => {
  try {
    run();
    return "";
  } catch (error) {
    return error instanceof ProfileError ? error.code : String(error);
  }
};

describe("network profiles", () => {
  it("keeps testnet as it was: Friendbot, the testnet pool, testnet USDC and no caps", () => {
    expect(resolveProfile("testnet", { env: {} })).toBe(TESTNET_PROFILE);
    expect(TESTNET_PROFILE).toMatchObject({
      caip2: "stellar:testnet",
      passphrase: Networks.TESTNET,
      rpcUrls: [TESTNET_RPC_URL],
      usdc: { contract: USDC_TESTNET_ADDRESS, decimals: 7 },
      funding: { kind: "friendbot", usdcSource: "testnet-pool" },
      caps: undefined,
    });
    expect(TESTNET_PROFILE.upto?.contract).toBe("CBTVKCHLSGQ3WSV3NKSU6FZR4FZMC6ENMDMXUS5XQ66HYVUUHYE3TU7U");
    expect(parseNetworkId(undefined)).toBe("testnet");
    expect(refusal(() => parseNetworkId("mainnet"))).toBe("network_unknown");
  });

  it("resolves pubnet from the treasury file, the RPC list, the caps and the fee ceilings", () => {
    const profile = pubnet();
    expect(profile).toMatchObject({
      caip2: "stellar:pubnet",
      passphrase: Networks.PUBLIC,
      rpcUrls: ["https://rpc-a.example", "https://rpc-b.example"],
      usdc: { contract: USDC_PUBNET_ADDRESS },
      funding: { kind: "treasury", secretFile: secret, accounts: "derived", sweepBack: true },
      caps: {
        maxXlmStroops: 50_000_000n,
        maxUsdcBaseUnits: 25_000_000n,
        maxSettlements: 100,
        maxNewAccounts: 6,
      },
      runCaps: { maxNetXlmStroops: 200_000_000n, maxNetUsdcBaseUnits: 5_000_000n },
      feeCeilings: { exact: 300_000n, upto: undefined },
    });
    expect(feeCeilingStroops(profile, "exact")).toBe(300_000n);
    expect(refusal(() => feeCeilingStroops(profile, "upto"))).toBe("pubnet_caps_missing");
    expect(feeCeilingStroops(pubnet({ PUBNET_UPTO_MAX_TX_FEE_STROOPS: "500000" }), "upto")).toBe(500_000n);
    expect(profile.explorer.tx("ab")).toBe("https://stellar.expert/explorer/public/tx/ab");
  });

  it("refuses pubnet without each required input", () => {
    const without = (name: keyof typeof env) => ({ ...env, [name]: undefined });
    expect(refusal(() => pubnet({ RAIL402_PUBNET_RPC_URLS: undefined }))).toBe("pubnet_rpc_missing");
    expect(refusal(() => pubnet({ RAIL402_PUBNET_RPC_URLS: "http://plain.example" }))).toBe(
      "pubnet_rpc_missing",
    );
    expect(refusal(() => pubnet({ RAIL402_TREASURY_SECRET_FILE: undefined }))).toBe(
      "pubnet_treasury_missing",
    );
    for (const cap of [
      "RAIL402_PUBNET_MAX_SPEND_XLM",
      "RAIL402_PUBNET_MAX_SPEND_USDC",
      "RAIL402_PUBNET_MAX_SETTLEMENTS",
      "RAIL402_PUBNET_MAX_NEW_ACCOUNTS",
      "RAIL402_PUBNET_RUN_MAX_XLM",
      "RAIL402_PUBNET_RUN_MAX_USDC_LOSS",
      "PUBNET_MAX_TX_FEE_STROOPS",
    ] as const) {
      expect(
        refusal(() => resolveProfile("pubnet", { env: without(cap), uptoRecord: noRecord })),
        cap,
      ).toBe("pubnet_caps_missing");
    }
    expect(refusal(() => pubnet({ RAIL402_PUBNET_MAX_SPEND_XLM: "0" }))).toBe("pubnet_caps_missing");
    expect(refusal(() => pubnet({ RAIL402_PUBNET_MAX_SPEND_USDC: "1.123456789" }))).toBe(
      "pubnet_caps_missing",
    );
    // An upto run needs the upto fee ceiling as well as a contract.
    expect(refusal(() => pubnet({}, { needsUpto: true }))).toBe("pubnet_caps_missing");
    expect(refusal(() => pubnet({ PUBNET_UPTO_MAX_TX_FEE_STROOPS: "500000" }, { needsUpto: true }))).toBe(
      "pubnet_upto_missing",
    );
    expect(
      pubnet(
        {
          PUBNET_UPTO_MAX_TX_FEE_STROOPS: "500000",
          RAIL402_PUBNET_UPTO_CONTRACT: CONTRACT,
          RAIL402_PUBNET_UPTO_WASM_HASH: HASH,
        },
        { needsUpto: true },
      ).upto,
    ).toEqual({ contract: CONTRACT, wasmHash: HASH });
  });

  it("refuses a malformed or zero fee ceiling instead of ignoring it", () => {
    for (const value of ["1e6", "300_000", "0", "-5", "3.5", "  ", "300000 stroops"]) {
      expect(
        refusal(() => pubnet({ PUBNET_MAX_TX_FEE_STROOPS: value })),
        value,
      ).toBe("pubnet_caps_missing");
      expect(
        refusal(() => pubnet({ PUBNET_UPTO_MAX_TX_FEE_STROOPS: value }, { needsUpto: true })),
        value,
      ).toBe("pubnet_caps_missing");
    }
    expect(refusal(() => pubnet({ PUBNET_UPTO_MAX_TX_FEE_STROOPS: "1e6" }))).toBe("pubnet_caps_missing");
  });

  it("takes the upto contract and WASM hash together, checked against the published pubnet record", () => {
    expect(refusal(() => pubnet({ RAIL402_PUBNET_UPTO_CONTRACT: CONTRACT }))).toBe("pubnet_upto_missing");
    expect(refusal(() => pubnet({ RAIL402_PUBNET_UPTO_WASM_HASH: HASH }))).toBe("pubnet_upto_missing");
    expect(
      refusal(() => pubnet({ RAIL402_PUBNET_UPTO_CONTRACT: CONTRACT, RAIL402_PUBNET_UPTO_WASM_HASH: "00" })),
    ).toBe("pubnet_upto_missing");
    const record = join(dir, "pubnet.json");
    writeFileSync(
      record,
      JSON.stringify({ contract: "upto", caip2: "stellar:pubnet", contract_id: CONTRACT, wasm_sha256: HASH }),
    );
    // The record alone names the contract.
    expect(pubnet({}, { uptoRecord: record }).upto).toEqual({ contract: CONTRACT, wasmHash: HASH });
    expect(
      pubnet(
        { RAIL402_PUBNET_UPTO_CONTRACT: CONTRACT, RAIL402_PUBNET_UPTO_WASM_HASH: HASH },
        { uptoRecord: record },
      ).upto,
    ).toEqual({ contract: CONTRACT, wasmHash: HASH });
    // A setting that differs from the record is refused.
    expect(
      refusal(() =>
        pubnet(
          { RAIL402_PUBNET_UPTO_CONTRACT: CONTRACT, RAIL402_PUBNET_UPTO_WASM_HASH: "1".repeat(64) },
          { uptoRecord: record },
        ),
      ),
    ).toBe("pubnet_upto_mismatch");
    const testnetRecord = join(dir, "testnet-record.json");
    writeFileSync(
      testnetRecord,
      JSON.stringify({ caip2: "stellar:testnet", contract_id: CONTRACT, wasm_sha256: HASH }),
    );
    expect(refusal(() => pubnet({}, { uptoRecord: testnetRecord }))).toBe("pubnet_upto_mismatch");
  });

  it("refuses pubnet in a testnet-only harness before reading any pubnet setting", () => {
    expect(
      refusal(() => {
        refusePubnet("pubnet", "the benchmark");
      }),
    ).toBe("pubnet_not_supported");
    expect(() => {
      refusePubnet("testnet", "the benchmark");
    }).not.toThrow();
  });

  it("refuses a treasury file others can read, or that is a link", () => {
    const loose = join(dir, "loose.txt");
    writeFileSync(loose, "S...");
    chmodSync(loose, 0o644);
    expect(refusal(() => pubnet({ RAIL402_TREASURY_SECRET_FILE: loose }))).toBe("pubnet_treasury_unsafe");
    const link = join(dir, "link.txt");
    symlinkSync(secret, link);
    expect(refusal(() => pubnet({ RAIL402_TREASURY_SECRET_FILE: link }))).toBe("pubnet_treasury_unsafe");
  });

  it("binds the run id to the commit, the treasury, every cap and a fresh nonce", () => {
    const profile = pubnet();
    const material = runMaterial(profile, "GTREASURY", "c0ffee");
    const id = runIdFor(material, "n1");
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(runIdFor(material, "n1")).toBe(id);
    expect(runIdFor(material, "n2")).not.toBe(id);
    expect(runIdFor(runMaterial(profile, "GOTHER", "c0ffee"), "n1")).not.toBe(id);
    expect(runIdFor(runMaterial(profile, "GTREASURY", "c0ffef"), "n1")).not.toBe(id);
    for (const changed of [
      { RAIL402_PUBNET_MAX_SPEND_XLM: "6" },
      { RAIL402_PUBNET_RUN_MAX_XLM: "21" },
      { RAIL402_PUBNET_RUN_MAX_USDC_LOSS: "0.6" },
      { PUBNET_MAX_TX_FEE_STROOPS: "300001" },
    ]) {
      expect(runIdFor(runMaterial(pubnet(changed), "GTREASURY", "c0ffee"), "n1")).not.toBe(id);
    }
  });

  it("plans a run on the first attempt and spends nothing; a confirmed run claims it once", async () => {
    const runs = mkdtempSync(join(dir, "runs-"));
    const profile = pubnet();
    const net = new ProfileNetwork(profile);
    const planned = await startRun("canonical", profile, net, { env: {}, runsDir: runs }).catch(
      (error: unknown) => error,
    );
    expect(planned).toBeInstanceOf(ProfileError);
    expect((planned as ProfileError).code).toBe("pubnet_run_unconfirmed");
    const id = /RAIL402_PUBNET_RUN_CONFIRM=([0-9a-f]{16})/.exec((planned as Error).message)?.[1] ?? "";
    expect(RunLedger.inspect(ledgerPath(id, runs)).read().state).toBe("planned");
    // Nothing is submitted on pubnet before a run started.
    await expect(net.server.sendTransaction(dummyTransaction())).rejects.toThrow(/spend_unmetered/);

    const funder = await startRun("canonical", profile, net, {
      env: { RAIL402_PUBNET_RUN_CONFIRM: id },
      runsDir: runs,
    });
    expect(RunLedger.inspect(ledgerPath(id, runs)).read().state).toBe("open");
    // Another process of the same run joins it through the ledger file.
    const joined = await startRun("live-matrix", profile, new ProfileNetwork(profile), {
      env: { RAIL402_PUBNET_RUN_CONFIRM: id, RAIL402_PUBNET_LEDGER: ledgerPath(id, runs) },
      runsDir: runs,
    });
    joined.finish();
    expect(RunLedger.inspect(ledgerPath(id, runs)).read().state).toBe("open");
    funder.finish();
    expect(RunLedger.inspect(ledgerPath(id, runs)).read().state).toBe("closed");
    // The same confirmation never starts a second run.
    const again = await startRun("canonical", profile, net, {
      env: { RAIL402_PUBNET_RUN_CONFIRM: id },
      runsDir: runs,
    }).catch((error: unknown) => error);
    expect((again as ProfileError).code).toBe("pubnet_run_reused");
    const late = await startRun("canonical", profile, net, {
      env: { RAIL402_PUBNET_RUN_CONFIRM: id, RAIL402_PUBNET_LEDGER: ledgerPath(id, runs) },
      runsDir: runs,
    }).catch((error: unknown) => error);
    expect((late as ProfileError).code).toBe("pubnet_run_closed");
    // A run id for other settings is refused.
    const other = await startRun("canonical", pubnet({ RAIL402_PUBNET_MAX_SETTLEMENTS: "99" }), net, {
      env: { RAIL402_PUBNET_RUN_CONFIRM: id },
      runsDir: runs,
    }).catch((error: unknown) => error);
    expect((other as ProfileError).code).toBe("pubnet_run_mismatch");
  });

  it("debits every fee the treasury pays before sending, and refuses a fee source outside the run", async () => {
    const profile = pubnet();
    const net = new ProfileNetwork(profile);
    const treasury = Keypair.fromSecret(readFileSync(secret, "utf8").trim());
    const meter = new SpendMeter({
      maxXlmStroops: 1_000n,
      maxUsdcBaseUnits: 1n,
      maxSettlements: 1,
      maxNewAccounts: 1,
    });
    net.attach({ meter, treasury: treasury.publicKey(), isRunAccount: () => false });
    // Over the cap: refused before anything is sent.
    await expect(net.server.sendTransaction(dummyTransaction(treasury, "5000"))).rejects.toThrow(
      /spend_cap_exceeded/,
    );
    expect(meter.spent.xlmStroops).toBe(0n);
    // Not the treasury and not a run account: refused.
    await expect(net.server.sendTransaction(dummyTransaction(Keypair.random(), "100"))).rejects.toThrow(
      /spend_unmetered/,
    );
  });

  it("never asks Friendbot on pubnet", async () => {
    const net = new ProfileNetwork(pubnet());
    expect(net.passphrase).toBe(Networks.PUBLIC);
    expect(net.rpcUrl).toBe("https://rpc-a.example");
    await expect(net.fund(Keypair.random())).rejects.toThrow(/friendbot_refused/);
  });
});

describe("SpendMeter", () => {
  const caps = { maxXlmStroops: 100n, maxUsdcBaseUnits: 50n, maxSettlements: 2, maxNewAccounts: 1 };

  it("refuses a step that would pass a cap before anything is spent, and debits nothing for it", () => {
    const meter = new SpendMeter(caps);
    meter.debit({ newAccounts: 1, xlmStroops: 60n }, "an account");
    expect(
      refusal(() => {
        meter.debit({ newAccounts: 1 }, "a second account");
      }),
    ).toBe("spend_cap_exceeded");
    expect(
      refusal(() => {
        meter.debit({ usdcBaseUnits: 51n }, "too much USDC");
      }),
    ).toBe("spend_cap_exceeded");
    meter.settlement(20n);
    expect(
      refusal(() => {
        meter.settlement(30n);
      }),
    ).toBe("spend_cap_exceeded");
    expect(meter.spent).toEqual({ xlmStroops: 80n, usdcBaseUnits: 0n, settlements: 1, newAccounts: 1 });
  });

  it("counts reserves and settlements at the fee ceiling, and only counts without caps", () => {
    const meter = new SpendMeter(undefined);
    meter.settlement(300_000n);
    meter.debit({ newAccounts: 3, xlmStroops: 60_000_000n }, "accounts");
    expect(meter.spent).toEqual({
      xlmStroops: 60_300_000n,
      usdcBaseUnits: 0n,
      settlements: 1,
      newAccounts: 3,
    });
  });
});

describe("withRun", () => {
  const fakeFunder = (log: string[]): Funder =>
    ({
      sweepBack: () => {
        log.push("sweep");
        return Promise.resolve({
          status: "done",
          transactions: [],
          problems: [],
          stranded: { usdcBaseUnits: 0n, xlmStroops: 0n, accounts: [] },
        } satisfies SweepResult);
      },
      finish: () => log.push("finish"),
    }) as unknown as Funder;

  it("sweeps once after the body, and after a body that throws before rethrowing", async () => {
    const log: string[] = [];
    await withRun(fakeFunder(log), () => {
      log.push("body");
      return Promise.resolve();
    });
    expect(log).toEqual(["body", "sweep", "finish"]);
    log.length = 0;
    await expect(
      withRun(fakeFunder(log), () => {
        log.push("body");
        return Promise.reject(new Error("RPC down"));
      }),
    ).rejects.toThrow("RPC down");
    expect(log).toEqual(["body", "sweep", "finish"]);
    expect(process.listenerCount("SIGTERM")).toBe(0);
  });

  it.each([
    ["SIGTERM", 143],
    ["SIGINT", 130],
  ] as const)(
    "sweeps on %s before the process exits with %i",
    async (signal, code) => {
      const script = `
      import { withRun } from ${JSON.stringify(new URL("../src/network.ts", import.meta.url).href)};
      const funder = {
        sweepBack: async () => { await new Promise((r) => setTimeout(r, 50)); console.log("swept"); return { status: "done", transactions: [], problems: [], stranded: { usdcBaseUnits: 0n, xlmStroops: 0n, accounts: [] } }; },
        finish: () => console.log("finished"),
      };
      await withRun(funder, async () => { console.log("ready"); await new Promise((r) => setTimeout(r, 60_000)); });
    `;
      const child = spawn(
        process.execPath,
        ["--conditions=@rail402/source", "--input-type=module", "-e", script],
        {
          cwd: new URL("..", import.meta.url),
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString();
        if (out.includes("ready") && !child.killed) child.kill(signal);
      });
      const exit = await new Promise<number | null>((resolve) => child.on("close", resolve));
      expect(out).toContain("swept");
      expect(out).toContain("finished");
      expect(exit).toBe(code);
    },
    30_000,
  );
});

/** A signed classic transaction of `source` with `fee` stroops, never sent anywhere real. */
function dummyTransaction(source = Keypair.random(), fee = "100") {
  const transaction = new TransactionBuilder(new Account(source.publicKey(), "1"), {
    fee,
    networkPassphrase: Networks.PUBLIC,
  })
    .addOperation(Operation.bumpSequence({ bumpTo: "2" }))
    .setTimeout(60)
    .build();
  transaction.sign(source);
  return transaction;
}

describe("the pubnet harnesses", () => {
  const source = (name: string) => readFileSync(new URL(`../src/${name}.ts`, import.meta.url), "utf8");
  const PAYING = [
    "canonical",
    "live-matrix",
    "concurrency",
    "rejection-audit",
    "upstream-e2e",
    "live-bazaar",
  ];

  it("start every funded run with the facilitators to guard and end it through withRun", () => {
    for (const harness of PAYING) {
      const text = source(harness);
      expect(text, harness).toMatch(/startRun\([^;]*facilitators:/s);
      expect(text, harness).toContain("withRun(");
      expect(text, harness).not.toMatch(/\.sweepBack\(\)/);
      // Settlements are counted at the wire, not from a hand-made bound.
      expect(text, harness).not.toMatch(/meter\.(debit|settlement)\(/);
    }
  });

  it("run the agent on pubnet through the run's ledger, counting each payment its seller settled", () => {
    const text = source("live-agent");
    expect(text).toMatch(/startRun\("live-agent", PROFILE, net, \{ facilitators: \[hosted\.bazaar\] \}\)/);
    expect(text).toContain("withRun(funder,");
    expect(text).not.toMatch(/\.sweepBack\(\)/);
    // The seller's facilitator settles, so the run counts each payment the agent made against the caps,
    // at the scheme's fee ceiling, in the process that holds the run's meter.
    expect(text).toMatch(/funder\.meter\.settlement\(feeCeilingStroops\(PROFILE, scheme\)/);
    // The payer is a treasury account the run can sweep, derived for this run only: its seed reaches
    // the installed packages, so it must never control the payer of a later run.
    expect(text).toMatch(
      /funder\.accounts\(1, PUBNET_PAYER_USDC, true, \{\s*role: "payer",\s*perRun: true,?\s*\}\)/,
    );
    expect(text).not.toMatch(/role: "payer"(?![\s,]*perRun)/);
  });

  it("pay in pubnet USDC only, and only public https deployments", () => {
    for (const harness of ["live-bazaar", "live-agent"]) {
      expect(source(harness), harness).toContain('"pubnet_target_missing"');
    }
    expect(source("live-bazaar")).toMatch(/PUBNET && requirements\.asset !== USDC_ADDRESS/);
  });

  it("pass the configured upto contract to every upto client on pubnet", () => {
    expect(source("canonical").match(/\.\.\.UPTO_CONTRACTS/g)).toHaveLength(2);
    expect(source("canonical")).toContain("contracts: PROFILE.upto.contract");
    expect(source("live-matrix").match(/contracts: PROFILE\.upto\.contract/g)?.length).toBeGreaterThanOrEqual(
      2,
    );
    expect(source("concurrency")).toContain("contract: PROFILE.upto.contract");
    expect(source("rejection-audit")).toContain("contract: profile.upto.contract");
  });

  it("deploy smart accounts only through the funder, which keeps their owner keys", () => {
    for (const harness of [...PAYING, "rejection-audit-run", "rejection-audit-upto"]) {
      expect(source(harness), harness).not.toMatch(/deploySimpleAccount\(/);
    }
  });
});
