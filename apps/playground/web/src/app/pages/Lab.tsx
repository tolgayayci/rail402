/**
 * The interactive lab: pick a scenario (and a way to break it), run it on testnet, and watch every
 * message as a swimlane row. Rows, the inspector and the outcome are projected from the run's events.
 */
import { useEffect, useMemo, useState, type ReactElement } from "react";
import type { ScenarioId } from "../../engine/events.ts";
import type { CodedError } from "../../engine/types.ts";
import {
  AGENT_PLANNER_LABEL,
  EXPERIMENT_IDS,
  SCENARIO_EXPERIMENTS,
  SCENARIO_IDS,
  type ExperimentId,
} from "../../../../src/shared/lab.ts";
import { capState } from "../../projection/cap.ts";
import { displayUrl } from "../../projection/format.ts";
import type { LaneTone } from "../../projection/lanes.ts";
import { nextScenario, projectOutcome } from "../../projection/outcome.ts";
import { scenarioTarget } from "../../projection/targets.ts";
import { CapInput } from "../../ui/CapInput.tsx";
import { downloadJson } from "../../ui/download.ts";
import { FlowLayout, useFlowProjection, useRowSelection } from "../../ui/flow.tsx";
import { Notice } from "../../ui/Notice.tsx";
import { OutcomeCard } from "../../ui/OutcomeCard.tsx";
import { scenarioTabs } from "../../ui/snippets.ts";
import { toCodedError, useEngine, useEngineState, useRunView } from "../engine.tsx";
import { canRun, runBlocker } from "../gate.ts";
import { WalletPrompt } from "../wallet.tsx";
import { navigate, useLocation } from "../router.tsx";
import { usePageRun, useRuns } from "../runs.tsx";

const SCENARIOS: Readonly<
  Record<ScenarioId, { readonly title: string; readonly hint: string; readonly tone: LaneTone }>
> = {
  pay: { title: "Pay for an API", hint: "fixed price per call", tone: "you" },
  upto: { title: "Pay per use", hint: "authorize a cap, pay usage", tone: "rail" },
  agent: { title: "Agent pays a tool", hint: "MCP: search, pay, call", tone: "bazaar" },
  sell: { title: "Sell and get listed", hint: "a route in the Bazaar", tone: "seller" },
};

const EXPERIMENTS: Readonly<Record<ExperimentId, string>> = {
  normal: "Normal run",
  "low-cap": "Cap below the price",
  replay: "Send it twice",
  overcharge: "Seller charges over the cap",
};

const NEXT_LABEL: Readonly<Record<ScenarioId, string>> = {
  pay: "Next: pay for an API",
  upto: "Next: pay per use",
  agent: "Next: an agent pays",
  sell: "Next: sell and get listed",
};

function isScenario(value: string | null): value is ScenarioId {
  return value !== null && (SCENARIO_IDS as readonly string[]).includes(value);
}

export function LabPage(): ReactElement {
  const engine = useEngine();
  const state = useEngineState();
  const { config } = engine;
  const { search } = useLocation();

  const requested = search.get("scenario");
  const scenario: ScenarioId = isScenario(requested) ? requested : "pay";
  const offered = SCENARIO_EXPERIMENTS[scenario];
  const requestedExperiment = search.get("experiment");
  const experiment: ExperimentId = offered.find((item) => item === requestedExperiment) ?? "normal";

  const [cap, setCap] = useState(
    experiment === "low-cap" ? config.caps.perCallLowPreset : config.caps.perCallDefault,
  );
  // Each scenario and experiment keeps its last run while the visitor is elsewhere.
  const [handle, setHandle] = usePageRun(`lab:${scenario}:${experiment}`);
  const [startError, setStartError] = useState<CodedError | null>(null);
  const { setLabPath } = useRuns();
  const labPath = requested === null ? "/" : `/?${search.toString()}`;
  useEffect(() => {
    setLabPath(labPath);
  }, [setLabPath, labPath]);
  const view = useRunView(handle);

  const target = scenarioTarget(scenario, experiment, config);
  const projection = useFlowProjection(view.events, scenario, target.lanes, config.asset);
  const { selected, select } = useRowSelection(projection.rows, view.runId);
  const sellerLabel = projection.lanes.find((lane) => lane.tone === "seller")?.label ?? "Seller";
  const outcome = useMemo(
    () => projectOutcome(view.events, { asset: config.asset, sellerLabel, facilitatorLabel: "Rail402" }),
    [view.events, config.asset, sellerLabel],
  );

  const capCheck = capState(cap, config.caps.perCallCeiling, config.asset.decimals);
  const snippetCap = capCheck.valid ? capCheck.effective : cap;
  const tabs = useMemo(
    () => scenarioTabs(scenario, { cap: snippetCap, config }),
    [scenario, snippetCap, config],
  );

  const running = handle !== null && view.summary === null;
  const enabled = (id: ScenarioId): boolean => config.lab.scenarios.includes(id);
  const experimentEnabled = (id: ExperimentId): boolean => config.lab.experiments.includes(id);
  const runnable =
    canRun(state) && capCheck.valid && !running && enabled(scenario) && experimentEnabled(experiment);
  const blocker = running ? null : runBlocker(state);
  const turnedOff = [
    ...SCENARIO_IDS.filter((id) => !enabled(id)).map((id) => SCENARIOS[id].title),
    ...EXPERIMENT_IDS.filter((id) => id !== "normal" && !experimentEnabled(id)).map((id) => EXPERIMENTS[id]),
  ];

  const choose = (next: ScenarioId, nextExperiment: ExperimentId = "normal"): void => {
    if (running) return;
    setStartError(null);
    setCap(nextExperiment === "low-cap" ? config.caps.perCallLowPreset : config.caps.perCallDefault);
    const query = new URLSearchParams({ scenario: next });
    if (nextExperiment !== "normal") query.set("experiment", nextExperiment);
    navigate(`/?${query.toString()}`, { replace: true });
  };

  const run = (): void => {
    if (!runnable) return;
    setStartError(null);
    try {
      setHandle(engine.run({ scenario, experiment, cap: capCheck.value }));
    } catch (error) {
      setStartError(toCodedError(error));
    }
  };

  const statusText = running
    ? `Message ${String(projection.rows.length)}…`
    : view.summary !== null
      ? `${String(projection.rows.length)} messages · click one to inspect`
      : blocker?.code === "playground_wallet_missing"
        ? "Set up a test wallet first"
        : blocker?.code === "playground_wallet_locked"
          ? "The wallet is open in another tab"
          : !enabled(scenario) || !experimentEnabled(experiment)
            ? "Turned off on this Playground"
            : "Ready";

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Interactive lab</div>
          <h1>Watch an x402 payment happen, one message at a time</h1>
        </div>
        <ul className="legend" aria-label="Who is who">
          <li data-tone="you">You / your agent</li>
          <li data-tone="seller">Seller</li>
          <li data-tone="rail">Rail402</li>
          <li data-tone="stellar">Stellar</li>
          <li data-tone="bazaar">Bazaar</li>
        </ul>
      </div>

      <div role="tablist" aria-label="Scenario" className="scenario-tabs">
        {SCENARIO_IDS.map((id, index) => (
          <button
            key={id}
            type="button"
            role="tab"
            className="scenario-tab"
            data-tone={SCENARIOS[id].tone}
            aria-selected={id === scenario}
            disabled={(running && id !== scenario) || !enabled(id)}
            title={enabled(id) ? undefined : "The operator has turned this scenario off."}
            onClick={() => {
              choose(id);
            }}
          >
            <span className="scenario-number">{index + 1}</span>
            <span className="scenario-text">
              <span className="scenario-title">{SCENARIOS[id].title}</span>
              <span className="scenario-hint">{SCENARIOS[id].hint}</span>
            </span>
          </button>
        ))}
      </div>

      {offered.length > 1 ? (
        <div className="experiments" role="group" aria-label="Try breaking it">
          <span className="experiments-label">Try breaking it:</span>
          {offered.map((id) => (
            <button
              key={id}
              type="button"
              className="experiment"
              data-kind={id === "normal" ? "normal" : "break"}
              aria-pressed={id === experiment}
              disabled={(running && id !== experiment) || !experimentEnabled(id)}
              title={experimentEnabled(id) ? undefined : "Turned off on this Playground."}
              onClick={() => {
                choose(scenario, id);
              }}
            >
              {EXPERIMENTS[id]}
            </button>
          ))}
        </div>
      ) : null}

      {turnedOff.length > 0 ? (
        <Notice
          tone="info"
          error={{
            code: "playground_feature_disabled",
            reason: `Turned off on this Playground: ${turnedOff.join(", ")}.`,
          }}
        />
      ) : null}
      {/* Why Run is disabled, shown before the flow, where the visitor looks first. */}
      <WalletPrompt state={state} running={running} />

      {scenario === "agent" ? <p className="muted agent-label">{AGENT_PLANNER_LABEL}</p> : null}

      <FlowLayout
        scenario={scenario}
        projection={projection}
        selected={selected}
        onSelect={select}
        codeTabs={tabs}
        docsUrl={config.urls.docs}
        idle={
          handle === null ? (
            blocker?.code === "playground_wallet_missing" ? (
              <p>
                Set up a test wallet first: it lives only in this browser and holds testnet funds. Then press{" "}
                <strong>Run on testnet</strong>; each message appears as it happens.
              </p>
            ) : (
              <p>
                Press <strong>Run on testnet</strong> to send this on the Stellar testnet. Each message
                appears as it happens; click any message to inspect it.
              </p>
            )
          ) : null
        }
        head={
          <>
            <div className="flow-target">
              <span className="method-badge" data-tone={target.method === "MCP" ? "bazaar" : "you"}>
                {target.method}
              </span>
              <span className="flow-url mono" title={target.target}>
                {target.isUrl ? displayUrl(target.target) : target.target}
                {experiment === "replay" ? " · sent twice" : ""}
              </span>
            </div>
            <div className="flow-controls">
              <CapInput
                compact
                value={cap}
                onChange={setCap}
                ceiling={config.caps.perCallCeiling}
                decimals={config.asset.decimals}
                symbol={config.asset.symbol}
                label="Cap"
                hint="per call"
              />
              <span className="flow-status" aria-live="polite">
                {statusText}
              </span>
              <button type="button" className="button-primary" onClick={run} disabled={!runnable}>
                {running ? "Running…" : view.summary !== null ? "Run again" : "Run on testnet"}
              </button>
            </div>
          </>
        }
      />

      {startError !== null ? <Notice error={startError} /> : null}

      {outcome !== undefined ? (
        <>
          <OutcomeCard
            outcome={outcome}
            docsUrl={config.urls.docs}
            next={{
              label: NEXT_LABEL[nextScenario(scenario)],
              go: () => {
                choose(nextScenario(scenario));
              },
            }}
          />
          <RunReportButton runId={view.runId} />
        </>
      ) : null}
    </>
  );
}

/** Saves the run's report: built from its events only, so it holds nothing the page did not show. */
export function RunReportButton({ runId }: { readonly runId: string | null }): ReactElement | null {
  const engine = useEngine();
  if (runId === null) return null;
  return (
    <div className="run-actions">
      <button
        type="button"
        className="button-secondary"
        onClick={() => {
          const report = engine.exportRun(runId);
          if (report !== undefined) downloadJson(`rail402-playground-${report.runId}.json`, report);
        }}
      >
        Download the run report
      </button>
      <span className="muted">
        Built from this run's events only: no keys, signatures or payment headers.
      </span>
    </div>
  );
}
