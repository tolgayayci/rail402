import { randomUUID } from "node:crypto";
import type { PlaygroundConfig } from "../config.js";
import { runAgentScene, type AgentEvent, type AgentRunResult } from "./orchestrator.js";

/** The orchestrator, injectable so the store can be tested without a live ledger. */
export type AgentRunner = (args: {
  config: PlaygroundConfig;
  budgetStroops: bigint;
  onEvent: (event: AgentEvent) => void;
}) => Promise<AgentRunResult>;

/**
 * Agent runs are long (a smart account is created and several real settlements happen — ~60-90s),
 * so a run is a background job the browser starts once and then follows by polling for new events.
 * In-memory and capped: a demo, not an archive.
 */

type RunStatus = "running" | "done" | "failed";

interface AgentRun {
  readonly id: string;
  status: RunStatus;
  events: AgentEvent[];
  account: string | undefined;
  transactions: Record<string, string>;
  startedAt: number;
}

const MAX_RUNS = 100;

export function createAgentRunStore(
  config: PlaygroundConfig,
  now: () => number = Date.now,
  runner: AgentRunner = runAgentScene,
) {
  const runs = new Map<string, AgentRun>();

  function evict(): void {
    while (runs.size >= MAX_RUNS) {
      const oldest = runs.keys().next().value;
      if (oldest === undefined) break;
      runs.delete(oldest);
    }
  }

  /** Start a run in the background; returns its id immediately. */
  function start(budgetStroops: bigint): { id: string } {
    evict();
    const id = randomUUID();
    const run: AgentRun = {
      id,
      status: "running",
      events: [],
      account: undefined,
      transactions: {},
      startedAt: now(),
    };
    runs.set(id, run);

    // Fire-and-forget: the orchestrator appends events as it goes, the browser polls them.
    void runner({
      config,
      budgetStroops,
      onEvent: event => run.events.push(event),
    })
      .then((result: AgentRunResult) => {
        run.status = result.ok ? "done" : "failed";
        run.account = result.account;
        run.transactions = result.transactions;
      })
      .catch(() => {
        run.status = "failed";
      });

    return { id };
  }

  /** Snapshot events since `sinceSeq` (exclusive), for incremental polling. */
  function poll(id: string, sinceSeq: number): {
    status: RunStatus;
    account: string | undefined;
    transactions: Record<string, string>;
    events: AgentEvent[];
  } | undefined {
    const run = runs.get(id);
    if (!run) return undefined;
    return {
      status: run.status,
      account: run.account,
      transactions: run.transactions,
      events: run.events.filter(e => e.seq > sinceSeq),
    };
  }

  return { start, poll };
}
