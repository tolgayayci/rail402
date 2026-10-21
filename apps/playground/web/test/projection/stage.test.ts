import { describe, expect, it } from "vitest";
import type { LabEvent } from "../../src/engine/events.ts";
import { projectProof, projectVerdict } from "../../src/projection/proof.ts";
import {
  addressLink,
  planKinds,
  projectStage,
  summarize,
  type StageContext,
} from "../../src/projection/stage.ts";
import { CONFIG } from "../fixtures/config.ts";
import { IDS, URLS } from "../fixtures/ids.ts";
import { CHECK_RUNS, scenarioRun } from "../fixtures/runs.ts";

const context = (mode: StageContext["mode"], extra: Partial<StageContext> = {}): StageContext => ({
  mode,
  plan: "normal",
  config: CONFIG,
  ...extra,
});

/** The events of a run up to (and without) the first one that matches. */
function until(events: readonly LabEvent[], stop: (event: LabEvent) => boolean): readonly LabEvent[] {
  const index = events.findIndex(stop);
  return index < 0 ? events : events.slice(0, index);
}

/** Any text a step or proof shows, to check that no raw JSON reaches the page. */
function texts(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(texts);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(texts);
  return [];
}

describe("the stage before a run", () => {
  it("shows each mode's plan as steps still to come", () => {
    const exact = projectStage([], context("exact", { target: `${URLS.demoSeller}/weather?city=Ankara` }));
    expect(exact.started).toBe(false);
    expect(exact.steps.map((step) => step.kind)).toEqual(planKinds("exact", "normal"));
    expect(exact.steps.every((step) => step.planned && step.state === "pending")).toBe(true);
    expect(exact.steps[0]?.chip).toBe("GET /weather?city=Ankara");
    expect(exact.lanes.map((lane) => lane.label)).toEqual(["You", "Weather API", "Rail402", "Stellar"]);

    const upto = projectStage(
      [],
      context("upto", { target: `${URLS.demoSeller}/history?city=Berlin&days=7` }),
    );
    expect(upto.steps.map((step) => step.title)).toEqual([
      "You ask for the data",
      "The API names its terms",
      "Your wallet signs once",
      "You retry with the signature",
      "The API sets the charge",
      "Rail402 settles it",
      "The transfer lands",
      "You get data + receipt",
    ]);

    const agent = projectStage([], context("agent"));
    expect(agent.lanes.map((lane) => lane.label)).toEqual([
      "AI agent",
      "Bazaar",
      "MCP tool",
      "Rail402",
      "Stellar",
    ]);
    expect(agent.steps).toHaveLength(10);
    expect(agent.steps.map((step) => step.chip)).toContain("retry + payment");
  });

  it("does not name Rail402 as the facilitator of a URL it cannot vouch for", () => {
    const stage = projectStage([], context("exact", { target: "https://api.example.org/paid" }));
    expect(stage.lanes.map((lane) => lane.label)).toEqual(["You", "API", "Facilitator", "Stellar"]);
    expect(stage.lanes[1]?.role).toBe("api.example.org");
    expect(stage.steps.map((step) => step.title)).toContain("Facilitator settles it");
    expect(stage.ours).toBe(false);
  });
});

describe("an upto payment", () => {
  const events = scenarioRun("upto", "normal");

  it("plays every message with its words and facts from the events", () => {
    const stage = projectStage(events, context("upto"));
    expect(stage.ended).toBe(true);
    expect(stage.steps.map((step) => `${step.kind} ${step.state} | ${step.chip}`)).toEqual([
      "request done | GET /history?city=Berlin&days=7",
      "quote done | 402 · up to 0.01 USDC",
      "sign done | Sign up to 0.01",
      "paid done | retry + signature",
      "work done | Charge 0.0021",
      "settle done | /settle 0.0021",
      "submit done | transfer 0.0021",
      "deliver done | 200 OK + receipt",
    ]);
    const work = stage.steps.find((step) => step.kind === "work");
    expect(work?.explain).toBe(
      "The API did the work and asks for 0.0021 USDC. You signed for at most 0.01 USDC; more would fail on chain.",
    );
    expect(work?.facts).toEqual([
      { label: "Charge", value: "0.0021 USDC", mono: true },
      { label: "Signed for", value: "0.01 USDC", mono: true },
      { label: "Never taken", value: "0.0079 USDC", mono: true },
    ]);
    const submit = stage.steps.find((step) => step.kind === "submit");
    expect(submit?.facts.find((fact) => fact.label === "Transaction")?.href).toMatch(
      /^https:\/\/stellar\.expert\/explorer\/testnet\/tx\/[0-9a-f]{64}$/,
    );
    // At most four facts a step, and the delivered body as readable pairs.
    expect(stage.steps.every((step) => step.facts.length <= 4)).toBe(true);
    const deliver = stage.steps.find((step) => step.kind === "deliver");
    expect(deliver?.result).toEqual([
      { label: "city", value: "Berlin" },
      { label: "days", value: "7 items" },
      { label: "charged", value: "units 7 · amount 0.0021 USDC" },
    ]);
    expect(texts(stage.steps).some((text) => /[{}]/.test(text) && !text.includes("{ "))).toBe(false);
  });

  it("holds the steps still to come in their place while the run goes", () => {
    // The settlement is reported before the chain read of its transaction arrives.
    const partial = until(events, (event) => event.kind === "chain" && event.phase === "tx");
    const stage = projectStage(partial, context("upto"));
    const kinds = stage.steps.map((step) => `${step.kind}${step.planned ? " (to come)" : ""}`);
    expect(kinds.slice(-3)).toEqual(["settle", "submit (to come)", "deliver"]);
  });

  it("ends with the proof: the amount, the cap never taken, the fee and the parties", () => {
    const proof = projectProof(events, { config: CONFIG, ours: true });
    expect(proof).toMatchObject({
      scheme: "upto",
      paid: "0.0021",
      symbol: "USDC",
      cap: "0.01",
      untaken: "0.0079",
      feeSponsored: true,
      facilitator: "Rail402",
    });
    expect(proof?.tx.url).toMatch(/^https:\/\/stellar\.expert\/explorer\/testnet\/tx\//);
    expect(proof?.parties.map((party) => `${party.role}: ${party.did}`)).toEqual([
      "You: signed once, up to 0.01",
      "Seller: received 0.0021 USDC",
      "Rail402: paid the network fee (144498 stroops)",
      "Settlement contract: checked 0.0021 ≤ 0.01",
    ]);
    expect(proof?.parties.every((party) => party.href?.startsWith("https://stellar.expert/") === true)).toBe(
      true,
    );
    expect(projectVerdict(events, { config: CONFIG, ours: true })).toBeUndefined();
  });
});

describe("an exact payment", () => {
  it("signs the price and proves it on chain", () => {
    const events = scenarioRun("pay", "normal");
    const stage = projectStage(events, context("exact"));
    expect(stage.steps.map((step) => step.chip)).toEqual([
      "GET /weather?city=Ankara",
      "402 · 0.001 USDC",
      "Sign 0.001",
      "retry + signature",
      "/verify → /settle",
      "transfer 0.001",
      "200 OK + receipt",
    ]);
    const proof = projectProof(events, { config: CONFIG, ours: true });
    expect(proof).toMatchObject({ scheme: "exact", paid: "0.001", cap: "0.01", untaken: null });
    expect(proof?.parties.at(-1)).toMatchObject({ role: "USDC contract", address: IDS.usdc });
  });
});

describe("the agent", () => {
  it("splits the paid tool call into its messages", () => {
    const events = scenarioRun("agent", "normal");
    const stage = projectStage(events, context("agent"));
    expect(stage.lanes[2]?.label).toBe("air_quality");
    expect(stage.steps.map((step) => `${step.kind} ${JSON.stringify(step.lane)} | ${step.chip}`)).toEqual([
      'search {"from":0,"to":1} | search: air quality',
      'results {"from":1,"to":0} | 1 tool · 0.001 USDC',
      'budget {"self":0} | Within budget',
      'call {"from":0,"to":2} | tools/call',
      'quote {"from":2,"to":0} | 402 · 0.001 USDC',
      'sign {"self":0} | Sign 0.001',
      'paid {"from":0,"to":2} | retry + payment',
      'settle {"from":2,"to":3} | /settle',
      'submit {"from":3,"to":4} | transfer 0.001',
      'deliver {"from":2,"to":0} | result + receipt',
    ]);
    expect(stage.steps.find((step) => step.kind === "call")?.facts).toContainEqual({
      label: "Arguments",
      value: "city Istanbul",
      mono: true,
    });
    const proof = projectProof(events, { config: CONFIG, ours: true });
    expect(proof?.paid).toBe("0.001");
    expect(proof?.parties[0]?.role).toBe("Your agent");
    expect(proof?.result.map((pair) => pair.label)).toEqual(["city", "pollutant", "aqi", "category"]);
  });
});

describe("refusals", () => {
  it("ends a check refused before signing, with its code and nothing moved", () => {
    const events = CHECK_RUNS["per-call-cap"];
    const stage = projectStage(events, context("exact"));
    expect(stage.plan).toBe("per-call-cap");
    expect(stage.steps.map((step) => `${step.kind} ${step.state}`)).toEqual([
      "request done",
      "quote done",
      "refused error",
    ]);
    expect(stage.steps[2]?.chip).toBe("Refused before signing");
    expect(projectProof(events, { config: CONFIG, ours: true })).toBeUndefined();
    expect(projectVerdict(events, { config: CONFIG, ours: true })).toMatchObject({
      tone: "refused",
      title: "Refused before signing",
      code: "payment_per_call_cap_exceeded",
      by: "your spending policy",
      check: { id: "per-call-cap", expected: "payment_per_call_cap_exceeded", passed: true },
      signed: 0,
      transactions: [],
      balance: "unchanged",
    });
  });

  it("names the relay's refusal of a private address", () => {
    const stage = projectStage(CHECK_RUNS["private-address"], context("exact"));
    const refused = stage.steps.find((step) =>
      step.facts.some((fact) => fact.value === "egress_destination_not_allowed"),
    );
    expect(refused?.title).toBe("The relay refuses the address");
    expect(refused?.explain).toMatch(/^The relay refused to call 169\.254\.169\.254\/ before connecting/);
    expect(
      projectVerdict(CHECK_RUNS["private-address"], { config: CONFIG, ours: false })?.check?.passed,
    ).toBe(true);
  });

  it("shows a replayed payment paid once and the copy refused", () => {
    const events = scenarioRun("pay", "replay");
    const stage = projectStage(events, context("exact"));
    expect(stage.steps.slice(-3).map((step) => step.title)).toEqual([
      "You send the same payment again",
      "The copy is refused",
      "You are charged once",
    ]);
    expect(projectVerdict(events, { config: CONFIG, ours: true })).toMatchObject({
      tone: "info",
      title: "Paid once, the copy was refused",
      signed: 1,
    });
  });

  it("shows an overcharge refused at settlement", () => {
    const events = scenarioRun("upto", "overcharge");
    const stage = projectStage(events, context("upto"));
    expect(stage.lanes[1]?.label).toBe("Greedy API");
    const refused = stage.steps.find((step) => step.kind === "overcharge-refused");
    expect(refused?.facts[0]).toEqual({
      label: "Code",
      value: "invalid_upto_stellar_payload_settlement_exceeds_amount",
      mono: true,
    });
    expect(projectVerdict(events, { config: CONFIG, ours: true })).toMatchObject({
      tone: "refused",
      title: "The overcharge was refused",
      transactions: [],
      balance: "unchanged",
    });
  });
});

describe("helpers", () => {
  it("summarizes a body as readable pairs", () => {
    expect(summarize('{"city":"Ankara","temperature":21,"tags":["a","b"],"wind":{"speed":3}}')).toEqual([
      { label: "city", value: "Ankara" },
      { label: "temperature", value: "21" },
      { label: "tags", value: "2 items" },
      { label: "wind", value: "speed 3" },
    ]);
    expect(summarize("plain text")).toEqual([{ label: "Body", value: "plain text" }]);
    expect(summarize("[1,2,3]")).toEqual([{ label: "Body", value: "3 items" }]);
  });

  it("links accounts and contracts in the explorer, and nothing else", () => {
    const template = CONFIG.explorerTemplate;
    expect(addressLink(template, IDS.buyer)).toBe(
      `https://stellar.expert/explorer/testnet/account/${IDS.buyer}`,
    );
    expect(addressLink(template, IDS.usdc)).toBe(
      `https://stellar.expert/explorer/testnet/contract/${IDS.usdc}`,
    );
    expect(addressLink(template, "not-an-address")).toBeUndefined();
    expect(addressLink("https://example.org/{hash}", IDS.buyer)).toBeUndefined();
  });
});
