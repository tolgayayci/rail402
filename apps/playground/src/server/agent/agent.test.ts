import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { loadConfig, type PlaygroundConfig } from "../config.js";
import { buildMcpConfig } from "./mcp-config.js";
import { createAgentRunStore, type AgentRunner } from "./runs.js";
import type { AgentEvent, AgentRunResult } from "./orchestrator.js";

const SECRET = Keypair.random().secret();
const config = (): PlaygroundConfig =>
  loadConfig({ PLAYGROUND_DISPENSER_SECRET: SECRET } as NodeJS.ProcessEnv);

describe("buildMcpConfig", () => {
  it("emits the env var names @rail402/mcp-discovery actually reads", () => {
    const session = Keypair.random().secret();
    const { json } = buildMcpConfig(config(), session, 5_000_000n);
    const parsed = JSON.parse(json) as {
      mcpServers: { "rail402-stellar": { env: Record<string, string> } };
    };
    const env = parsed.mcpServers["rail402-stellar"].env;
    // The exact names the server reads — a wrong name is a silently broken config.
    expect(env["BAZAAR_URL"]).toBe(config().facilitatorUrl);
    expect(env["CLIENT_STELLAR_PRIVATE_KEY"]).toBe(session);
    expect(env["STELLAR_NETWORK"]).toBe("stellar:testnet");
    expect(env["MAX_AMOUNT_CEILING"]).toBe("0.5");
  });

  it("carries the custody warning and the not-yet-published note", () => {
    const { warning, note } = buildMcpConfig(config(), Keypair.random().secret());
    expect(warning.toLowerCase()).toContain("testnet");
    expect(note).toContain("not published");
  });
});

describe("agent run store", () => {
  const events = (phases: string[]): AgentEvent[] =>
    phases.map((phase, i) => ({ seq: i, phase, actor: "system", message: phase }));

  it("starts a background run and streams events incrementally by seq", async () => {
    let emit: ((e: AgentEvent) => void) | undefined;
    let resolve: ((r: AgentRunResult) => void) | undefined;
    const runner: AgentRunner = ({ onEvent }) => {
      emit = onEvent;
      return new Promise<AgentRunResult>(r => (resolve = r));
    };
    const store = createAgentRunStore(config(), () => 1000, runner);

    const { id } = store.start(5_000_000n);
    expect(store.poll(id, -1)!.status).toBe("running");

    for (const e of events(["creating", "policy", "paying"])) emit!(e);
    // Since -1 returns all; since 0 skips the first.
    expect(store.poll(id, -1)!.events.map(e => e.phase)).toEqual(["creating", "policy", "paying"]);
    expect(store.poll(id, 0)!.events.map(e => e.phase)).toEqual(["policy", "paying"]);
    expect(store.poll(id, 2)!.events).toEqual([]);

    resolve!({ ok: true, account: "CABC", events: [], transactions: { exact: "hash1" } });
    await new Promise(r => setTimeout(r, 0));
    const done = store.poll(id, -1)!;
    expect(done.status).toBe("done");
    expect(done.account).toBe("CABC");
    expect(done.transactions["exact"]).toBe("hash1");
  });

  it("marks a run failed when the orchestrator returns ok:false", async () => {
    const runner: AgentRunner = () =>
      Promise.resolve({ ok: false, account: undefined, events: [], transactions: {} });
    const store = createAgentRunStore(config(), () => 1000, runner);
    const { id } = store.start(5_000_000n);
    await new Promise(r => setTimeout(r, 0));
    expect(store.poll(id, -1)!.status).toBe("failed");
  });

  it("returns undefined for an unknown run id", () => {
    const store = createAgentRunStore(config(), () => 1000, () => Promise.resolve({ ok: true, account: undefined, events: [], transactions: {} }));
    expect(store.poll("nope", -1)).toBeUndefined();
  });
});
