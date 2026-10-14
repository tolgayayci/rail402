import { describe, expect, it } from "vitest";
import { Rail402Error } from "@rail402.dev/errors";
import type { Buyer, KeyValueStore, PaymentEvent } from "@rail402.dev/sdk/browser";
import { secretLikeNames } from "../../../src/shared/public-config.ts";
import type { BuyerWiring } from "../../src/engine/buyer.ts";
import { PlaygroundEngine, budgetView, callInputFor, type EngineChain } from "../../src/engine/engine.ts";
import type { LabEvent } from "../../src/engine/events.ts";
import type { EngineState, RunSummary } from "../../src/engine/types.ts";
import type { LockRequester } from "../../src/wallet/tab-lock.ts";
import { memoryKeystore } from "../../src/wallet/keystore.ts";
import { WalletVault } from "../../src/wallet/vault.ts";
import { budgetSnapshot, fakeBuyer, hit, paidResult, policyFor, txView } from "./fakes.ts";
import { PAY_TO, exactPreimage, testConfig } from "./helpers.ts";

const config = testConfig();
const policy = await policyFor(config);

function memoryStorage(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

function lockManager(): LockRequester {
  const held = new Set<string>();
  return {
    request: async (name, options, callback) => {
      if (held.has(name)) {
        if (options.ifAvailable === true) return callback(null);
        return new Promise(() => undefined);
      }
      held.add(name);
      try {
        await callback({ name });
      } finally {
        held.delete(name);
      }
      return undefined;
    },
  };
}

const chain: EngineChain = {
  balances: () => Promise.resolve({ xlm: "9990", asset: "1", readAt: 0 }),
  assetBalance: () => Promise.resolve("1"),
  tx: (hash) => Promise.resolve(txView(hash)),
  refreshLedger: () => Promise.resolve(1_000),
  latestLedger: () => 1_000,
  supported: () => Promise.resolve({ signers: new Set<string>() }),
  advertised: () => null,
};

interface Harness {
  readonly engine: PlaygroundEngine;
  readonly storage: ReturnType<typeof memoryStorage>;
  readonly wirings: BuyerWiring[];
  readonly downloads: { fileName: string; blob: Blob }[];
}

/** An engine whose buyer pays by emitting SDK events and signing through the tapped key once. */
function harness(
  options: {
    locks?: LockRequester;
    vault?: WalletVault;
    payDelay?: Promise<void>;
    /** How many buyer builds fail first, as when the chain cannot be read for a moment. */
    buildFailures?: number;
    /** Events of older payments the SDK reports inside a paid call (it reconciles before paying). */
    stray?: readonly PaymentEvent[];
  } = {},
): Harness {
  let failures = options.buildFailures ?? 0;
  const storage = memoryStorage();
  const wirings: BuyerWiring[] = [];
  const downloads: { fileName: string; blob: Blob }[] = [];
  let ids = 0;
  const engine = new PlaygroundEngine({
    config,
    storage,
    vault: options.vault ?? WalletVault.over(memoryKeystore()),
    locks: options.locks ?? lockManager(),
    chain,
    timers: { setInterval: () => 0, clearInterval: () => undefined },
    focus: new EventTarget(),
    randomId: () => `run-${String(++ids)}`,
    download: (fileName, blob) => downloads.push({ fileName, blob }),
    sleep: () => Promise.resolve(),
    buildBuyer: (wiring) => {
      if (failures > 0) {
        failures--;
        return Promise.reject(
          new Rail402Error(
            "payment_policy_invalid",
            { status: 400, retryable: false, reason: "Invalid spending policy." },
            { reason: "Invalid spending policy: the asset could not be read on chain as a SEP-41 token." },
          ),
        );
      }
      wirings.push(wiring);
      const emit = (event: PaymentEvent) => {
        wiring.onEvent(event);
      };
      return Promise.resolve({
        ...fakeBuyer(policy, {
          pay: async (target, payOptions) => {
            const callId = `call-${payOptions.idempotencyKey ?? ""}`;
            for (const event of options.stray ?? []) emit(event);
            emit({ type: "probe", callId, resource: target.url });
            await options.payDelay;
            emit({
              type: "reserved",
              callId,
              reservation: "r1",
              asset: policy.assets[0]?.contract ?? "",
              amount: "10000",
            });
            await wiring.signer.signAuthEntry(
              exactPreimage({
                payer: wiring.signer.address,
                payTo: PAY_TO,
                amount: 10_000n,
                nonce: 1n,
                expiration: 1_012,
              }),
            );
            emit({ type: "signed", callId, reservation: "r1", nonce: "1", expirationLedger: 1_012 });
            emit({
              type: "settled",
              callId,
              reservation: "r1",
              transaction: "e".repeat(64),
              amount: "10000",
            });
            return { ...paidResult(), callId };
          },
          budget: () => Promise.resolve(budgetSnapshot()),
          reconcile: () =>
            Promise.resolve({ checked: 0, settled: 0, released: 0, unprovable: 0, pending: 0 } as never),
        }),
        close: () => Promise.resolve(),
      } as unknown as Buyer);
    },
  });
  return { engine, storage, wirings, downloads };
}

async function finished(handle: { done: Promise<RunSummary> }): Promise<RunSummary> {
  return handle.done;
}

function eventsOf(handle: { subscribe(listener: (event: LabEvent) => void): () => void }): LabEvent[] {
  const events: LabEvent[] = [];
  handle.subscribe((event) => events.push(event));
  return events;
}

/** Lets pending state updates land. */
const tick = () => new Promise((done) => setTimeout(done, 0));

describe("engine", () => {
  it("starts without a wallet, then creates one and reads its setup", async () => {
    const { engine, wirings } = harness();
    await engine.ready;
    expect(engine.state().wallet).toEqual({ status: "none", storage: "memory" });
    const created = engine.wallet.create();
    const events = eventsOf(created);
    expect(await finished(created)).toMatchObject({ status: "ok" });
    expect(events.map((event) => event.kind)).toEqual(["wallet", "run"]);
    await tick();
    const state: EngineState = engine.state();
    expect(state.wallet).toMatchObject({
      status: "ready",
      setup: { account: true, trustline: true, funded: true },
    });
    expect(state.balances).toMatchObject({ xlm: "9990", asset: "1" });
    expect(state.budget).toMatchObject({ remaining: "0.999" });
    expect(wirings[0]?.policy).toEqual({ sessionTotal: "1" });
  });

  it("keeps a stored wallet loading while the chain cannot be read, then arms it", async () => {
    const keystore = memoryKeystore();
    const first = harness({ vault: WalletVault.over(keystore) });
    await first.engine.ready;
    await first.engine.wallet.create().done;
    first.engine.dispose();

    const states: EngineState[] = [];
    const second = harness({ vault: WalletVault.over(keystore), buildFailures: 2 });
    second.engine.subscribe((state) => states.push(state));
    await second.engine.ready;
    await expect.poll(() => second.engine.state().wallet.status).toBe("ready");
    // Never reported missing: the key is stored, only the chain read failed.
    expect(states.map((state) => state.wallet.status)).not.toContain("none");
    expect(states.map((state) => state.lastError?.code)).toContain("payment_policy_invalid");
    expect(second.engine.state().lastError).toBeNull();
    second.engine.dispose();
  });

  it("runs a payment: start, the SDK's events, the signer's view, the chain, the end", async () => {
    const { engine } = harness();
    await engine.ready;
    await engine.wallet.create().done;
    const run = engine.run({ scenario: "pay", experiment: "normal", cap: "0.01" });
    const events = eventsOf(run);
    expect(await run.done).toEqual({ runId: run.runId, status: "ok", reason: "Paid and delivered." });
    const shape = events.map((event) =>
      event.kind === "sdk"
        ? `sdk:${event.event.type}`
        : "phase" in event
          ? `${event.kind}:${event.phase}`
          : event.kind,
    );
    expect(shape).toEqual([
      "run:start",
      "sdk:probe",
      "sdk:reserved",
      "auth",
      "sdk:signed",
      "sdk:settled",
      "delivery",
      "chain:tx",
      "chain:balance",
      "run:end",
    ]);
    expect(events[0]).toMatchObject({ scenario: "pay", variant: "normal", cap: "0.01" });
    expect(events[1]).toMatchObject({ event: { callId: `call-pg_${run.runId}` } });
    expect(events.every((event) => event.runId === run.runId)).toBe(true);
  });

  it("runs one thing at a time", async () => {
    let release: () => void = () => undefined;
    const payDelay = new Promise<void>((done) => {
      release = done;
    });
    const { engine } = harness({ payDelay });
    await engine.ready;
    await engine.wallet.create().done;
    const first = engine.run({ scenario: "pay", experiment: "normal", cap: "0.01" });
    const second = engine.check("network");
    expect(await second.done).toMatchObject({ status: "refused", code: "playground_run_in_progress" });
    expect(engine.state().activeRun).toBe(first.runId);
    release();
    expect((await first.done).status).toBe("ok");
    expect(engine.state().activeRun).toBeNull();
  });

  it("reports later events of a payment on the run that made it", async () => {
    const { engine, wirings } = harness();
    await engine.ready;
    await engine.wallet.create().done;
    const run = engine.run({ scenario: "pay", experiment: "normal", cap: "0.01" });
    await run.done;
    wirings[0]?.onEvent({
      type: "released",
      callId: `call-pg_${run.runId}`,
      reservation: "r1",
      reason: "expired_unused",
      amount: "10000",
    });
    const report = engine.exportRun(run.runId);
    expect(report?.events.at(-1)).toMatchObject({
      kind: "sdk",
      event: { type: "released", reason: "expired_unused" },
    });
  });

  it("keeps events of payments it never saw (an older reservation reconciled) off the run", async () => {
    const stray: PaymentEvent[] = [
      {
        type: "settled",
        callId: "older-call",
        reservation: "old",
        transaction: "a".repeat(64),
        amount: "60000",
      },
      {
        type: "released",
        callId: "older-call",
        reservation: "old",
        reason: "settled_below_cap",
        amount: "40000",
      },
    ];
    const { engine } = harness({ stray });
    await engine.ready;
    await engine.wallet.create().done;
    const run = engine.run({ scenario: "pay", experiment: "normal", cap: "0.01" });
    const events = eventsOf(run);
    await run.done;
    expect(
      events.some(
        (event) => event.kind === "sdk" && "callId" in event.event && event.event.callId === "older-call",
      ),
    ).toBe(false);
    expect(events.filter((event) => event.kind === "sdk" && event.event.type === "settled")).toHaveLength(1);
  });

  it("reads the transaction of a payment a reconciliation proves after its run", async () => {
    const { engine, wirings } = harness();
    await engine.ready;
    await engine.wallet.create().done;
    const run = engine.run({ scenario: "pay", experiment: "normal", cap: "0.01" });
    await run.done;
    wirings[0]?.onEvent({
      type: "settled",
      callId: `call-pg_${run.runId}`,
      reservation: "r1",
      transaction: "f".repeat(64),
      amount: "10000",
    });
    await tick();
    const last = engine.exportRun(run.runId)?.events.at(-1);
    expect(last).toMatchObject({ kind: "chain", phase: "tx", view: { hash: "f".repeat(64) } });
  });

  it("refuses an invalid cap before anything is signed", async () => {
    const { engine } = harness();
    await engine.ready;
    await engine.wallet.create().done;
    const run = engine.run({ scenario: "pay", experiment: "normal", cap: "lots" });
    const events = eventsOf(run);
    expect(await run.done).toMatchObject({ status: "refused", code: "payment_cap_invalid" });
    expect(events.some((event) => event.kind === "auth" || event.kind === "sdk")).toBe(false);
    expect(events.find((event) => event.kind === "refusal")).toMatchObject({ layer: "policy" });
  });

  it("uses the low cap preset for the cap-below-price experiment", async () => {
    const { engine } = harness();
    await engine.ready;
    await engine.wallet.create().done;
    const run = engine.run({ scenario: "pay", experiment: "low-cap", cap: "0.05" });
    expect(eventsOf(run)[0]).toMatchObject({ cap: config.caps.perCallLowPreset });
    await run.done;
  });

  it("refuses a paying run without a wallet", async () => {
    const { engine } = harness();
    await engine.ready;
    expect(await engine.run({ scenario: "pay", experiment: "normal", cap: "0.01" }).done).toMatchObject({
      status: "refused",
      code: "playground_wallet_missing",
    });
  });

  it("keeps a second tab read-only", async () => {
    const locks = lockManager();
    const first = harness({ locks });
    await first.engine.ready;
    const second = harness({ locks });
    await second.engine.ready;
    expect(second.engine.state().wallet).toEqual({ status: "locked" });
    expect(await second.engine.wallet.create().done).toMatchObject({
      status: "error",
      code: "playground_wallet_locked",
    });
  });

  it("exports the key only as a file, and forgets the wallet with its budget", async () => {
    const { engine, storage, downloads } = harness();
    await engine.ready;
    await engine.wallet.create().done;
    const address =
      engine.state().wallet.status === "ready" ? (engine.state().wallet as { address: string }).address : "";
    storage.setItem(`rail402.playground.ledger.v1.${address}:v1`, "{}");
    storage.setItem(`rail402.playground.session-total.v1.${address}`, "0.5");
    const exported = await engine.wallet.exportFile();
    expect(downloads[0]?.fileName).toBe(exported.fileName);
    const seed = (await downloads[0]?.blob.text())?.trim() ?? "";
    expect(seed).toMatch(/^S[A-Z2-7]{55}$/);
    expect(JSON.stringify(exported)).not.toContain(seed);
    expect(JSON.stringify(engine.state())).not.toContain(seed);

    const forgotten = engine.wallet.forget();
    const events = eventsOf(forgotten);
    expect((await forgotten.done).status).toBe("ok");
    expect(events[0]).toMatchObject({ kind: "wallet", step: "forgotten" });
    expect(engine.state().wallet).toEqual({ status: "none", storage: "memory" });
    expect([...storage.data.keys()]).toEqual([]);
    await expect(engine.wallet.exportFile()).rejects.toMatchObject({ code: "playground_wallet_missing" });
  });

  it("only ever lowers the session total", async () => {
    const { engine, wirings, storage } = harness();
    await engine.ready;
    await engine.wallet.create().done;
    await expect(engine.lowerSessionTotal("2")).rejects.toMatchObject({ code: "payment_cap_invalid" });
    await expect(engine.lowerSessionTotal("0")).rejects.toMatchObject({ code: "payment_cap_invalid" });
    await engine.lowerSessionTotal("0.25");
    expect(wirings.at(-1)?.policy).toEqual({ sessionTotal: "0.25" });
    expect([...storage.data.values()]).toContain("0.25");
    await expect(engine.lowerSessionTotal("0.5")).rejects.toMatchObject({ code: "payment_cap_invalid" });
  });

  it("stops waiting when a run is aborted", async () => {
    const { engine } = harness({ payDelay: new Promise(() => undefined) });
    await engine.ready;
    await engine.wallet.create().done;
    const run = engine.run({ scenario: "pay", experiment: "normal", cap: "0.01" });
    run.abort();
    expect(await run.done).toMatchObject({ status: "error", code: "playground_run_aborted" });
  });

  it("exports a run report built from the events, with nothing secret-shaped in it", async () => {
    const { engine } = harness();
    await engine.ready;
    await engine.wallet.create().done;
    const run = engine.run({ scenario: "pay", experiment: "normal", cap: "0.01" });
    await run.done;
    const report = engine.exportRun(run.runId);
    expect(report).toMatchObject({
      format: "rail402-playground-run",
      version: 1,
      runId: run.runId,
      network: "stellar:testnet",
      playgroundVersion: config.version,
      summary: { status: "ok" },
    });
    expect(secretLikeNames(JSON.parse(JSON.stringify(report)))).toEqual([]);
    expect(engine.exportRun("missing")).toBeUndefined();
  });

  it("describes the rail402-mcp tools without a wallet", () => {
    const { engine } = harness();
    expect(engine.toolDefinitions().map((tool) => tool.name)).toEqual([
      "search_stellar_resources",
      "pay_and_call",
      "get_budget",
    ]);
  });
});

describe("engine helpers", () => {
  it("splits listing parameters into path and query values, or passes tool arguments", () => {
    const http = hit({
      type: "http",
      toolName: null,
      input: { schema: null, example: null, pathParams: ["city"] },
    });
    expect(callInputFor(http, { city: "Ankara", days: 7, nested: { a: 1 } })).toEqual({
      pathParams: { city: "Ankara" },
      query: { days: 7 },
    });
    expect(callInputFor(hit(), { city: "Izmir" })).toEqual({ arguments: { city: "Izmir" } });
  });

  it("shows the policy asset's budget", () => {
    expect(budgetView(budgetSnapshot())).toMatchObject({
      perCallCap: "0.1",
      sessionCap: "1",
      remaining: "0.999",
    });
  });
});
