/**
 * The pubnet treasury funder, on the private network: a treasury holding XLM and an issued "USDC"
 * stands in for the operator treasury, so caps, the fee choke point, reuse, contract accounts and
 * sweep-back run against a real ledger.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, Operation, rpc, xdr } from "@stellar/stellar-sdk";
import {
  LOCAL_RPC_URL,
  LocalNetwork,
  callContract,
  deployContract,
  deployOzSmartAccount,
  deploySimpleAccount,
  mintTo,
  uptoWasm,
  type IssuedAsset,
} from "@rail402.dev/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ProfileError,
  ProfileNetwork,
  TESTNET_PROFILE,
  TreasuryFunder,
  type NetworkProfile,
} from "../src/network.ts";
import { RunLedger, planRun } from "../src/run-ledger.ts";

const setup = new LocalNetwork();
const dir = mkdtempSync(join(tmpdir(), "rail402-treasury-"));
let issued: IssuedAsset;
let treasury: Keypair;
let secretFile: string;

const profile = (caps: NonNullable<NetworkProfile["caps"]>): NetworkProfile => ({
  ...TESTNET_PROFILE,
  rpcUrls: [LOCAL_RPC_URL],
  caps,
  funding: { kind: "treasury", secretFile, accounts: "derived", sweepBack: true },
});
const roomy = {
  maxXlmStroops: 1_000_000_000n,
  maxUsdcBaseUnits: 100_000_000n,
  maxSettlements: 10,
  maxNewAccounts: 4,
};

beforeAll(async () => {
  issued = await setup.issueAsset("USDC");
  treasury = await setup.holder(issued, "50");
  secretFile = join(dir, "treasury.txt");
  writeFileSync(secretFile, treasury.secret());
  chmodSync(secretFile, 0o600);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const funder = (label: string, caps = roomy, ledger?: RunLedger) => {
  const resolved = profile(caps);
  return new TreasuryFunder(new ProfileNetwork(resolved), resolved, label, {
    asset: issued.asset,
    ...(ledger === undefined ? {} : { ledger }),
  });
};
const usdc = (address: string) => setup.tokenBalance(issued.sac, address);
const xlm = (address: string) => setup.nativeBalance(address);

describe("the pubnet treasury funder", () => {
  it("creates derived accounts once, reuses them, and tops up only what is missing", async () => {
    const label = `reuse-${Date.now()}`;
    const first = funder(label);
    const accounts = await first.accounts(2, "1");
    expect(first.meter.spent.newAccounts).toBe(2);
    expect(first.meter.spent.usdcBaseUnits).toBe(20_000_000n);
    for (const account of accounts) expect(await usdc(account.publicKey())).toBe(10_000_000n);

    const again = funder(label);
    const reused = await again.accounts(2, "1");
    expect(reused.map((account) => account.publicKey())).toEqual(
      accounts.map((account) => account.publicKey()),
    );
    expect(again.meter.spent.newAccounts).toBe(0);
    expect(again.meter.spent.usdcBaseUnits).toBe(0n);
    expect((await again.sweepBack()).status).toBe("done");
  });

  it("gives each role its own accounts and the fixture state it asks for", async () => {
    const label = `roles-${Date.now()}`;
    const [rich] = await funder(label).accounts(1, "2", true, { role: "fixture" });
    if (rich === undefined) throw new Error("no account");
    // A later run asks the same role for less, then for no trustline: the excess and the trustline go.
    const [poorer] = await funder(label).accounts(1, "0.5", true, { role: "fixture" });
    expect(poorer?.publicKey()).toBe(rich.publicKey());
    expect(await usdc(rich.publicKey())).toBe(5_000_000n);
    const last = funder(label);
    const [bare] = await last.accounts(1, "0", false, { role: "fixture" });
    expect(bare?.publicKey()).toBe(rich.publicKey());
    expect(await usdc(rich.publicKey())).toBe(0n);
    const [other] = await last.accounts(1, "2", true, { role: "another" });
    expect(other?.publicKey()).not.toBe(rich.publicKey());
    expect((await last.sweepBack()).status).toBe("done");
  });

  it("closes an account during the run: funds back, caps freed, the sweep expects it gone", async () => {
    const label = `close-${Date.now()}`;
    const run = funder(label);
    const before = await usdc(treasury.publicKey());
    const [account] = await run.accounts(1, "1");
    if (account === undefined) throw new Error("no account");
    const treasuryXlm = await xlm(treasury.publicKey());
    await run.close(account);
    await expect(
      new rpc.Server(setup.rpcUrl, { allowHttp: true }).getAccount(account.publicKey()),
    ).rejects.toThrow();
    expect(await usdc(treasury.publicKey())).toBe(before);
    expect(await xlm(treasury.publicKey())).toBeGreaterThan(treasuryXlm);
    expect(run.meter.spent.xlmStroops).toBeLessThan(10_000_000n);
    await expect(run.close(account)).rejects.toThrow("not an account of this run");
    const swept = await run.sweepBack();
    expect(swept.status).toBe("done");
    expect(swept.transactions.length).toBeGreaterThan(0);
  });

  it("refuses a funding step past a cap before submitting it", async () => {
    const tight = funder(`cap-${Date.now()}`, { ...roomy, maxUsdcBaseUnits: 5_000_000n });
    const before = await usdc(treasury.publicKey());
    const failure = await tight.accounts(1, "1").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProfileError);
    expect((failure as ProfileError).code).toBe("spend_cap_exceeded");
    expect(await usdc(treasury.publicKey())).toBe(before);
    expect(tight.meter.spent.usdcBaseUnits).toBe(0n);
    // The account it created before the refusal is merged back.
    expect((await tight.sweepBack()).status).toBe("done");
  });

  it("counts every fee the treasury pays, as charged, and refuses a step past the cap", async () => {
    const run = funder(`fees-${Date.now()}`);
    const before = await xlm(treasury.publicKey());
    await run.accounts(1, "1");
    expect((await run.sweepBack()).status).toBe("done");
    // What the meter counted is what left the treasury: fees as charged, reserves out, merges back.
    expect(before - (await xlm(treasury.publicKey()))).toBe(
      run.meter.spent.xlmStroops - run.meter.returned.xlmStroops,
    );
    expect(run.meter.returned.xlmStroops).toBeGreaterThan(0n);

    // A cap of exactly one starting balance: the creation's fee would pass it, so nothing is sent.
    const broke = funder(`fees-cap-${Date.now()}`, { ...roomy, maxXlmStroops: 20_000_000n });
    const failure = await broke.accounts(1, "1").catch((error: unknown) => error);
    expect((failure as ProfileError).code).toBe("spend_cap_exceeded");
    expect(broke.meter.spent.xlmStroops).toBeLessThanOrEqual(20_000_000n);
    expect((await broke.sweepBack()).status).toBe("done");
  });

  it("returns a smart account's USDC with its derived owner key and merges the run's accounts", async () => {
    const run = funder(`smart-${Date.now()}`);
    const usdcBefore = await usdc(treasury.publicKey());
    const xlmBefore = await xlm(treasury.publicKey());
    const [payer] = await run.accounts(1, "1");
    const smart = await run.smartAccount("payer");
    await run.transfer(smart.address, 30_000_000n);
    expect(await usdc(smart.address)).toBe(30_000_000n);
    // The owner key is derived from the treasury seed: the same role gives the same key on any run.
    expect(funder(run.label).contractOwner("payer").publicKey()).toBe(smart.owner.publicKey());

    const sweep = await run.sweepBack();
    expect(sweep.status).toBe("done");
    expect(sweep.stranded).toEqual({ usdcBaseUnits: 0n, xlmStroops: 0n, accounts: [] });
    expect(await usdc(smart.address)).toBe(0n);
    expect(await usdc(treasury.publicKey())).toBe(usdcBefore);
    await expect(setup.server.getAccount(payer?.publicKey() ?? "")).rejects.toThrow();
    expect(xlmBefore - (await xlm(treasury.publicKey()))).toBe(
      run.meter.spent.xlmStroops - run.meter.returned.xlmStroops,
    );
    // Sweeping again does nothing more.
    expect(await run.sweepBack()).toBe(sweep);
  });

  it("funds a smart account whose owner no other account can replace, and gets all of it back", async () => {
    const run = funder(`owner-bound-${Date.now()}`);
    const usdcBefore = await usdc(treasury.publicKey());
    const smart = await run.smartAccount("payer");
    await run.transfer(smart.address, 5_000_000n);
    // Anyone can call the account's functions while it is funded: none of them sets its owner.
    const stranger = Keypair.random();
    await setup.fund(stranger);
    for (const method of ["init", "set_owner"]) {
      await expect(
        callContract(setup, stranger, smart.address, method, [xdr.ScVal.scvBytes(stranger.rawPublicKey())]),
        method,
      ).rejects.toThrow();
    }
    const sweep = await run.sweepBack();
    expect(sweep.status).toBe("done");
    expect(await usdc(smart.address)).toBe(0n);
    expect(await usdc(treasury.publicKey())).toBe(usdcBefore);
  });

  it("refuses to fund a contract account whose owner on chain is not the key it tracks", async () => {
    const run = funder(`owner-mismatch-${Date.now()}`);
    const address = await deploySimpleAccount(run.net, treasury, run.contractOwner("real"));
    run.trackContract(address, { kind: "simple", owner: run.contractOwner("wrong") });
    const before = await usdc(treasury.publicKey());
    await expect(run.transfer(address, 1_000_000n)).rejects.toThrow(/pubnet_contract_owner_unverified/);
    expect(await usdc(address)).toBe(0n);
    expect(await usdc(treasury.publicKey())).toBe(before);
    expect(run.meter.spent.usdcBaseUnits).toBe(0n);
  });

  it("refuses to fund a contract account that does not run the code it was tracked as", async () => {
    const run = funder(`foreign-code-${Date.now()}`);
    // Any other contract, here the settlement contract, under either kind of account the run deploys.
    const address = await deployContract(setup, treasury, uptoWasm());
    for (const auth of [
      { kind: "simple", owner: run.contractOwner("simple") },
      { kind: "oz", owner: run.contractOwner("oz"), verifier: address },
    ] as const) {
      run.trackContract(address, auth);
      await expect(run.transfer(address, 1_000_000n), auth.kind).rejects.toThrow(
        /pubnet_contract_owner_unverified/,
      );
    }
    expect(await usdc(address)).toBe(0n);
    expect(run.meter.spent.usdcBaseUnits).toBe(0n);
  });

  it("funds an OpenZeppelin smart account it deployed and returns its USDC", async () => {
    const run = funder(`oz-${Date.now()}`);
    const owner = run.contractOwner("oz");
    const account = await deployOzSmartAccount(setup, treasury, owner);
    run.trackContract(account.address, { kind: "oz", owner, verifier: account.verifier });
    await run.transfer(account.address, 2_000_000n);
    expect(await usdc(account.address)).toBe(2_000_000n);
    expect((await run.sweepBack()).status).toBe("done");
    expect(await usdc(account.address)).toBe(0n);
  });

  it("reports what it could not return and fails the sweep", async () => {
    const run = funder(`stranded-${Date.now()}`);
    const owner = run.contractOwner("real");
    const wrong = run.contractOwner("wrong");
    const address = await deploySimpleAccount(run.net, treasury, owner);
    // Tracked with a key the account does not accept (the run never funds it so): USDC that reaches it
    // another way cannot be transferred back.
    run.trackContract(address, { kind: "simple", owner: wrong });
    await mintTo(setup, issued, address, 1_000_000n);
    const sweep = await run.sweepBack();
    expect(sweep.status).toBe("partial");
    expect(sweep.stranded.usdcBaseUnits).toBe(1_000_000n);
    expect(sweep.stranded.accounts).toEqual([address]);
    expect(sweep.problems).toHaveLength(1);
  });

  it("reports a run account merged away by whoever holds its key, instead of skipping it", async () => {
    const run = funder(`merged-${Date.now()}`);
    const [account] = await run.accounts(1, "1", true, { role: "payer", perRun: true });
    if (account === undefined) throw new Error("no account");
    // The key leaked: its holder returns the USDC to the issuer and merges the XLM into an account of theirs.
    const elsewhere = Keypair.random();
    await setup.fund(elsewhere);
    await setup.classic(account, [
      Operation.payment({ destination: issued.issuer.publicKey(), asset: issued.asset, amount: "1" }),
      Operation.changeTrust({ asset: issued.asset, limit: "0" }),
      Operation.accountMerge({ destination: elsewhere.publicKey() }),
    ]);
    const sweep = await run.sweepBack();
    expect(sweep.status).toBe("partial");
    expect(sweep.problems).toEqual([expect.stringContaining(account.publicKey())]);
    expect(sweep.problems[0]).toMatch(/merged outside the run/);
  });

  it("a recovery sweep, from the ledger alone, still reports a run account merged away", async () => {
    const runs = mkdtempSync(join(dir, "recover-runs-"));
    const material = {
      commit: "c0ffee",
      network: "stellar:testnet",
      treasury: treasury.publicKey(),
      runCaps: { maxNetXlmStroops: 1_000_000_000n, maxNetUsdcBaseUnits: 100_000_000n },
      settings: {},
    };
    const { runId } = planRun(material, runs);
    const ledger = RunLedger.claim(runId, material, "crash", runs);
    const run = funder(`recover-merged-${Date.now()}`, roomy, ledger);
    const [account] = await run.accounts(1, "1", true, { role: "payer", perRun: true });
    if (account === undefined) throw new Error("no account");
    // The run crashes before it can sweep, and the account is merged away by whoever holds its key.
    const elsewhere = Keypair.random();
    await setup.fund(elsewhere);
    await setup.classic(account, [
      Operation.payment({ destination: issued.issuer.publicKey(), asset: issued.asset, amount: "1" }),
      Operation.changeTrust({ asset: issued.asset, limit: "0" }),
      Operation.accountMerge({ destination: elsewhere.publicKey() }),
    ]);
    // A fresh process recovers from the registry (derivation paths) and the seen records alone.
    const recovery = funder(`recovery-${Date.now()}`);
    recovery.recover(ledger.registry(), ledger.seenAddresses());
    const sweep = await recovery.sweepBack();
    expect(sweep.status).toBe("partial");
    expect(sweep.problems).toEqual([expect.stringContaining(account.publicKey())]);
    expect(sweep.problems[0]).toMatch(/merged outside the run/);
  });

  it("a recovery does not report an account the run closed itself", async () => {
    const runs = mkdtempSync(join(dir, "recover-closed-"));
    const material = {
      commit: "c0ffee",
      network: "stellar:testnet",
      treasury: treasury.publicKey(),
      runCaps: { maxNetXlmStroops: 1_000_000_000n, maxNetUsdcBaseUnits: 100_000_000n },
      settings: {},
    };
    const { runId } = planRun(material, runs);
    const ledger = RunLedger.claim(runId, material, "crash", runs);
    const run = funder(`recover-closed-${Date.now()}`, roomy, ledger);
    const [account] = await run.accounts(1, "1", true, { role: "payer", perRun: true });
    if (account === undefined) throw new Error("no account");
    await run.close(account);
    expect(ledger.seenAddresses()).not.toContain(account.publicKey());
    const recovery = funder(`recovery-closed-${Date.now()}`);
    recovery.recover(ledger.registry(), ledger.seenAddresses());
    const sweep = await recovery.sweepBack();
    expect(sweep.problems).toEqual([]);
  });

  it("refuses to fund a contract account the run does not track, or whose owner it did not derive", async () => {
    const run = funder(`untracked-${Date.now()}`);
    const address = await deploySimpleAccount(run.net, treasury, Keypair.random());
    await expect(run.transfer(address, 1n)).rejects.toThrow(/pubnet_contract_untracked/);
    expect(() => {
      run.trackContract(address, { kind: "simple", owner: Keypair.random() });
    }).toThrow(/pubnet_owner_unknown/);
  });

  it("keeps the whole run's ledger in step: debits, fee releases, returns and the registry", async () => {
    const runs = mkdtempSync(join(dir, "runs-"));
    const material = {
      commit: "c0ffee",
      network: "stellar:testnet",
      treasury: treasury.publicKey(),
      runCaps: { maxNetXlmStroops: 100_000_000n, maxNetUsdcBaseUnits: 1n },
      settings: {},
    };
    const { runId } = planRun(material, runs);
    const ledger = RunLedger.claim(runId, material, "integration", runs);
    const run = funder(`ledger-${Date.now()}`, roomy, ledger);
    // The run's net USDC cap is one base unit: funding 1 USDC is refused until as much came back
    // (another harness's sweep, recorded here by hand); the cap is on what is lost, not what moves.
    await expect(run.accounts(1, "1")).rejects.toThrow(/spend_cap_exceeded/);
    ledger.credit({ usdcBaseUnits: 20_000_000n });
    await run.accounts(1, "1");
    const smart = await run.smartAccount();
    await run.transfer(smart.address, 2_000_000n);
    const sweep = await run.sweepBack();
    expect(sweep.status).toBe("done");
    const totals = ledger.totals();
    expect(BigInt(totals.spent.xlmStroops)).toBe(run.meter.spent.xlmStroops);
    expect(BigInt(totals.spent.usdcBaseUnits)).toBe(12_000_000n);
    expect(BigInt(totals.returned.usdcBaseUnits)).toBe(32_000_000n);
    // The refused attempt's account was registered (and created) before its USDC was refused.
    expect(ledger.registry().map((entry) => entry.kind)).toEqual(["account", "account", "contract"]);
    // The registry is enough to find the run's accounts again with the treasury seed alone.
    const recovery = funder("recovery");
    recovery.recover(ledger.registry());
    expect((await recovery.sweepBack()).status).toBe("done");
  });
});
