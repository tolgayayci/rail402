/**
 * The Lab: pick how to pay, then watch a real payment on the Stellar testnet, one message at a time.
 * The stage plays the run's own events: a swimlane of messages between the parties, an inspector that
 * says what each step did, and at the end the proof on chain (or the code a refusal ended with).
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { CodedError, RunHandle } from "../../engine/types.ts";
import { AGENT_PLANNER_LABEL } from "../../../../src/shared/lab.ts";
import { capState } from "../../projection/cap.ts";
import { projectProof, projectVerdict } from "../../projection/proof.ts";
import { projectStage, type StagePlan, type StageStep } from "../../projection/stage.ts";
import {
  AGENT_TARGET_TEXT,
  LAB_MODES,
  agentDefaultCap,
  agentPrompt,
  defaultTarget,
  defaultTargetText,
  isLabMode,
  labRequest,
  normalizeTarget,
  type LabMode,
} from "../../projection/targets.ts";
import { displayUrl } from "../../projection/format.ts";
import { downloadJson } from "../../ui/download.ts";
import { Notice } from "../../ui/Notice.tsx";
import { Swimlane, type StepLook } from "../../ui/Swimlane.tsx";
import { toCodedError, useEngine, useEngineState, useRunView } from "../engine.tsx";
import { canRun, runBlocker } from "../gate.ts";
import { StepDetail, StepList, WaitLine } from "../lab/Inspector.tsx";
import { usePlayback } from "../lab/playback.ts";
import { ProofPanel, VerdictPanel } from "../lab/Proof.tsx";
import {
  refusalFor,
  refusalTarget,
  refusalsAfterSigning,
  refusalsBeforeSigning,
  type RefusalEntry,
} from "../lab/refusals.ts";
import { RunBar } from "../lab/RunBar.tsx";
import { waitingFor } from "../lab/waiting.ts";
import { navigate, useLocation } from "../router.tsx";
import { bazaarRunKey, useRuns } from "../runs.tsx";
import { FinishSetup } from "../WalletDialog.tsx";

const MODE_TILES: Readonly<Record<LabMode, { readonly name: string; readonly title: string }>> = {
  exact: { name: "Exact", title: "Pay a fixed price" },
  upto: { name: "Upto", title: "Pay for what you use" },
  agent: { name: "Agent · MCP", title: "Let an agent pay" },
};

const IDLE: Readonly<Record<LabMode, { readonly title: string; readonly text: string }>> = {
  exact: {
    title: "Pay a fixed price for one call",
    text: "Run calls the URL above for real. Your wallet signs one payment within your cap, Rail402 settles it on the Stellar testnet and pays the network fee. Paste any other x402 URL to pay it instead.",
  },
  upto: {
    title: "Pay only for what the call uses",
    text: "Your wallet signs once for at most your cap. The API does the work, charges what it used, and the rest of the cap is never taken. Rail402 settles it on the Stellar testnet.",
  },
  agent: {
    title: "An agent finds a tool and pays it",
    text: AGENT_PLANNER_LABEL,
  },
};

/** The run button's words while the Lab plays a payment made in the Bazaar. */
const WATCH_TEXT = { idle: "Watch", busy: "Playing", again: "Watch again" } as const;

function laneKey(refusal: RefusalEntry | undefined, mode: LabMode): string {
  return refusal === undefined ? `lab:${mode}` : `lab:try:${refusal.key}`;
}

export function LabPage(): ReactElement {
  const engine = useEngine();
  const state = useEngineState();
  const { config } = engine;
  const { search } = useLocation();
  const runs = useRuns();

  const requested = search.get("mode");
  const mode: LabMode = isLabMode(requested) ? requested : "exact";
  const refusal = refusalFor(search.get("try"), config);
  // A link may name a URL to pay (`?url=`, also from the old Pay page): it fills the field, never runs.
  const linked = search.get("url");
  const [urls, setUrls] = useState<Readonly<Record<"exact" | "upto", string>>>(() => ({
    exact: linked !== null && mode === "exact" ? linked : defaultTargetText("exact", config),
    upto: linked !== null && mode === "upto" ? linked : defaultTargetText("upto", config),
  }));
  // Each mode keeps its own cap: the agent starts with an agent's per-call limit.
  const [caps, setCaps] = useState<Readonly<Record<LabMode, string>>>(() => ({
    exact: config.caps.perCallDefault,
    upto: config.caps.perCallDefault,
    agent: agentDefaultCap(config),
  }));
  const cap = caps[mode];
  const [startError, setStartError] = useState<CodedError | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // Runs started on this page play step by step; one found running or done is shown as it stands.
  const startedHere = useRef(new Set<string>());

  // A payment made in the Bazaar (`?watch=<listing>`) plays here, step by step, while this page lives.
  const watchId = refusal === undefined && mode !== "agent" ? search.get("watch") : null;
  const watched = watchId === null ? null : runs.handle(bazaarRunKey(watchId));
  const watching = watched !== null;
  const [replays, setReplays] = useState(0);

  const key = laneKey(refusal, mode);
  const handle = watched ?? runs.handle(key);
  const view = useRunView(handle);

  const path = `/${search.toString() === "" ? "" : `?${search.toString()}`}`;
  const { setLabPath, holdBalance } = runs;
  useEffect(() => {
    setLabPath(path);
  }, [setLabPath, path]);
  // The header keeps the balance from before a run started here until its steps have played.
  useEffect(
    () => () => {
      holdBalance(null);
    },
    [holdBalance],
  );

  // A new run (or another mode's) starts with the inspector following it.
  const [seenRun, setSeenRun] = useState(view.runId);
  if (seenRun !== view.runId) {
    setSeenRun(view.runId);
    setSelected(null);
  }

  const text = mode === "agent" ? "" : urls[mode];
  const target =
    refusal !== undefined
      ? refusalTarget(refusal, config).url
      : mode === "agent"
        ? undefined
        : watching
          ? (linked ?? undefined)
          : normalizeTarget(text);
  const plan: StagePlan = refusal === undefined ? "normal" : refusal.refusal.id;
  const stageMode: LabMode =
    refusal === undefined ? mode : refusal.refusal.id === "overcharge" ? "upto" : "exact";
  const stage = useMemo(
    () =>
      projectStage(view.events, {
        mode: stageMode,
        plan,
        config,
        ...(target === undefined ? {} : { target }),
      }),
    [view.events, stageMode, plan, config, target],
  );
  // A run refused before it started has an outcome and no steps: it is over, and says why.
  const unstarted = view.summary !== null && !stage.started ? view.summary : null;
  const playback = usePlayback(
    stage.steps,
    view.runId === null ? null : `${view.runId}:${String(replays)}`,
    stage.ended || unstarted !== null,
    { instant: view.runId !== null && !watching && !startedHere.current.has(view.runId) },
  );
  const proof = useMemo(
    () => (playback.finished ? projectProof(view.events, { config, ours: stage.ours }) : undefined),
    [playback.finished, view.events, config, stage.ours],
  );
  const verdict = useMemo(
    () =>
      playback.finished && proof === undefined
        ? projectVerdict(view.events, { config, ours: stage.ours })
        : undefined,
    [playback.finished, proof, view.events, config, stage.ours],
  );

  useEffect(() => {
    if (playback.finished) holdBalance(null);
  }, [playback.finished, holdBalance]);

  // Busy until the run has ended and every step has played.
  const running = handle !== null && !playback.finished;
  const capCheck = capState(cap, config.caps.perCallCeiling, config.asset.decimals);
  const agentOff = !config.lab.scenarios.includes("agent");
  const blocker = runBlocker(state);
  const runnable = watching
    ? playback.finished
    : canRun(state) &&
      !running &&
      (refusal !== undefined || capCheck.valid) &&
      (refusal !== undefined || mode === "agent" || target !== undefined) &&
      !(mode === "agent" && refusal === undefined && agentOff);

  const lookOf = (step: StageStep): StepLook => {
    if (step.planned || !playback.shown.has(step.id)) return "pending";
    if (step.id === playback.current) return "current";
    return step.state === "error" ? "error" : "done";
  };

  const start = (entry: RefusalEntry | undefined): void => {
    setStartError(null);
    setSelected(null);
    try {
      let next: RunHandle;
      if (entry !== undefined) {
        const { refusal: which } = entry;
        next =
          which.kind === "check"
            ? engine.check(which.id)
            : engine.run({
                scenario: which.id === "replay" ? "pay" : "upto",
                experiment: which.id,
                cap: config.caps.perCallDefault,
              });
      } else if (mode === "agent") {
        if (!capCheck.valid) return;
        next = engine.run({ scenario: "agent", experiment: "normal", cap: capCheck.value });
      } else {
        if (!capCheck.valid || target === undefined) return;
        const request = labRequest(mode, target, capCheck.value, config);
        next = request.kind === "scenario" ? engine.run(request.request) : engine.pay(request.request);
      }
      startedHere.current.add(next.runId);
      holdBalance(state.balances?.asset ?? null);
      runs.setHandle(laneKey(entry, mode), next);
    } catch (error) {
      setStartError(toCodedError(error));
    }
  };

  const go = (query: Readonly<Record<string, string>>): void => {
    const params = new URLSearchParams(query);
    const next = params.toString();
    navigate(next === "" ? "/" : `/?${next}`, { replace: true });
  };
  const chooseMode = (next: LabMode): void => {
    setStartError(null);
    setReplays(0);
    go(next === "exact" ? {} : { mode: next });
  };
  const chooseRefusal = (entry: RefusalEntry): void => {
    setReplays(0);
    go({ ...(mode === "exact" ? {} : { mode }), try: entry.key });
    if (canRun(state)) start(entry);
  };

  const steps = stage.steps;
  const selectedStep = selected === null ? undefined : steps.find((step) => step.id === selected);
  const currentStep =
    playback.current === null ? undefined : steps.find((step) => step.id === playback.current);
  const index = (step: StageStep): number => steps.indexOf(step);
  // What the current step waits for, when the next one is not there yet.
  const waiting =
    currentStep === undefined
      ? null
      : waitingFor(steps, currentStep.id, stage.lanes, { ended: stage.ended, agent: stage.mode === "agent" });
  const docsUrl = config.urls.docs;
  const shownDone = steps.filter(
    (step) => playback.shown.has(step.id) && step.id !== playback.current,
  ).length;

  const announce = playback.finished
    ? proof !== undefined
      ? `Paid ${proof.paid} ${proof.symbol}. The proof is ready.`
      : verdict !== undefined
        ? `${verdict.title}${verdict.code === null ? "" : `: ${verdict.code}`}`
        : ""
    : currentStep === undefined
      ? ""
      : `Step ${String(index(currentStep) + 1)} of ${String(steps.length)}: ${currentStep.title}`;

  const backButton = (label: string) => (
    <button
      type="button"
      className="stage-text-button"
      onClick={() => {
        setSelected(null);
      }}
    >
      {label}
    </button>
  );
  const seeSteps = (
    <button
      type="button"
      className="stage-text-button"
      onClick={() => {
        setSelected(steps[0]?.id ?? null);
      }}
    >
      See each step
    </button>
  );
  // The run's report is built from its events only: no key, signature or payment header.
  const saveReport =
    view.runId === null ? null : (
      <button
        type="button"
        className="stage-text-button"
        title="A JSON file built from this run's events only: no key, signature or payment header"
        onClick={() => {
          const report = view.runId === null ? undefined : engine.exportRun(view.runId);
          if (report !== undefined) downloadJson(`rail402-playground-${report.runId}.json`, report);
        }}
      >
        Save the run report
      </button>
    );

  const idle =
    refusal === undefined
      ? IDLE[mode]
      : { title: refusal.title, text: `${refusal.how} It must be refused with ${refusal.expects}.` };
  // What a watched payment called: its first request's method, or MCP for a tool call.
  const watchedCall = watching
    ? view.events.flatMap((event) => (event.kind === "http" && event.phase === "request" ? [event] : []))[0]
    : undefined;
  const watchedMethod =
    watchedCall !== undefined
      ? watchedCall.rpc === undefined
        ? watchedCall.method
        : "MCP"
      : linked === null
        ? "MCP"
        : "GET";
  const barTarget =
    refusal !== undefined
      ? { kind: "fixed" as const, text: refusalTarget(refusal, config).text }
      : watching
        ? {
            kind: "fixed" as const,
            text: `Paid in the Bazaar · ${linked === null ? "MCP tool" : displayUrl(linked)}`,
          }
        : mode === "agent"
          ? { kind: "fixed" as const, text: AGENT_TARGET_TEXT }
          : { kind: "url" as const, text };

  // A coded problem that stops the run, or a plain hint about what was typed.
  const notice: {
    readonly tone: "error" | "info";
    readonly error: Pick<CodedError, "code" | "reason">;
  } | null =
    startError !== null
      ? { tone: "error", error: startError }
      : unstarted?.code !== undefined
        ? {
            tone: "error",
            error: { code: unstarted.code, reason: unstarted.reason ?? "The run did not start." },
          }
        : refusal === undefined && mode === "agent" && agentOff
          ? {
              tone: "info",
              error: {
                code: "playground_feature_disabled",
                reason: "The agent is turned off on this Playground.",
              },
            }
          : !running && blocker !== null && blocker.code !== "playground_run_in_progress"
            ? { tone: "info", error: blocker }
            : null;
  const hint: { readonly invalid: boolean; readonly text: string } | null =
    refusal !== undefined || watching
      ? null
      : !capCheck.valid
        ? { invalid: true, text: capCheck.message }
        : mode !== "agent" && target === undefined
          ? { invalid: true, text: `Enter an http(s) URL, such as ${defaultTargetText(mode, config)}.` }
          : capCheck.clamped
            ? {
                invalid: false,
                text: `Above the ${config.caps.perCallCeiling} ${config.asset.symbol} ceiling: the cap used is ${capCheck.effective} ${config.asset.symbol}.`,
              }
            : linked !== null && mode !== "agent" && text === linked
              ? {
                  invalid: false,
                  text: "This URL came from the link you opened. Check where it points before you pay it.",
                }
              : null;

  return (
    <div className="lab">
      <div className="lab-top">
        <div className="lab-title">
          <span className="eyebrow">Stellar testnet · x402</span>
          <h1>Watch a payment, step by step</h1>
        </div>
        <div className="mode-tiles" role="group" aria-label="Payment mode">
          {LAB_MODES.map((id) => (
            <button
              key={id}
              type="button"
              className="mode-tile"
              data-mode={id}
              aria-pressed={id === mode && refusal === undefined}
              onClick={() => {
                chooseMode(id);
              }}
            >
              <span className="mode-tile-name">
                <span className="mode-swatch" aria-hidden="true" />
                {MODE_TILES[id].name}
              </span>
              <span className="mode-tile-title">{MODE_TILES[id].title}</span>
            </button>
          ))}
        </div>
      </div>

      <section className="stage on-dark" data-mode={stage.mode} aria-label="Run">
        <RunBar
          method={refusal !== undefined ? "TRY" : mode === "agent" ? "MCP" : watching ? watchedMethod : "GET"}
          target={barTarget}
          onUrl={(value) => {
            if (mode !== "agent") setUrls((current) => ({ ...current, [mode]: value }));
          }}
          urlPlaceholder={mode === "agent" ? "" : displayPlaceholder(defaultTarget(mode, config))}
          onLeaveRefusal={
            refusal === undefined && !watching
              ? undefined
              : () => {
                  setReplays(0);
                  go(mode === "exact" ? {} : { mode });
                }
          }
          leaveLabel={`Back to ${MODE_TILES[mode].title.toLowerCase()}`}
          cap={refusal === undefined && !watching ? cap : null}
          onCap={(value) => {
            setCaps((current) => ({ ...current, [mode]: value }));
          }}
          symbol={config.asset.symbol}
          before={refusalsBeforeSigning(config)}
          after={refusalsAfterSigning(config)}
          onRefusal={chooseRefusal}
          menuDisabled={running || !canRun(state)}
          running={running}
          finished={playback.finished}
          runnable={runnable}
          runText={watching ? WATCH_TEXT : undefined}
          onRun={() => {
            if (watching) {
              setSelected(null);
              setReplays((current) => current + 1);
            } else start(refusal);
          }}
        />
        {hint !== null ? (
          <p className="stage-hint" data-invalid={hint.invalid} role={hint.invalid ? "alert" : undefined}>
            {hint.text}
          </p>
        ) : null}
        {notice !== null ? (
          <div className="stage-note">
            <Notice tone={notice.tone} error={notice.error}>
              {notice.error.code === "playground_wallet_not_set_up" ? <FinishSetup /> : null}
            </Notice>
          </div>
        ) : null}
        <div
          className="stage-progress"
          role="progressbar"
          aria-label="Run progress"
          aria-valuemin={0}
          aria-valuemax={steps.length}
          aria-valuenow={playback.finished ? steps.length : shownDone}
        >
          {steps.map((step) => (
            <span
              key={step.id}
              className="stage-progress-segment"
              data-look={playback.finished ? (step.state === "error" ? "error" : "done") : lookOf(step)}
            />
          ))}
        </div>

        <div className="stage-body">
          <Swimlane
            lanes={stage.lanes}
            steps={steps}
            lookOf={lookOf}
            selected={selected}
            onSelect={(id) => {
              setSelected((current) => (current === id ? null : id));
            }}
          />
          <aside className="inspector" aria-label="Step inspector">
            <p className="visually-hidden" aria-live="polite">
              {announce}
            </p>
            {stage.mode === "agent" && !(playback.finished && selectedStep === undefined) ? (
              <div className="prompt-card">
                <span className="eyebrow">Prompt</span>
                <p>{agentPrompt(capCheck.valid ? capCheck.effective : cap, config.asset.symbol)}</p>
              </div>
            ) : null}
            {selectedStep !== undefined ? (
              <StepDetail
                step={selectedStep}
                index={index(selectedStep)}
                total={steps.length}
                now={selectedStep.id === playback.current}
                docsUrl={docsUrl}
                back={backButton(
                  playback.finished
                    ? proof !== undefined
                      ? "Back to proof"
                      : "Back to result"
                    : running
                      ? "Back to now"
                      : "Close",
                )}
              />
            ) : playback.finished && proof !== undefined ? (
              <ProofPanel
                proof={proof}
                docsUrl={docsUrl}
                actions={
                  <>
                    {seeSteps}
                    {saveReport}
                  </>
                }
              />
            ) : playback.finished && verdict !== undefined ? (
              <VerdictPanel
                verdict={verdict}
                docsUrl={docsUrl}
                symbol={config.asset.symbol}
                actions={saveReport}
              />
            ) : currentStep !== undefined ? (
              <StepDetail
                step={currentStep}
                index={index(currentStep)}
                total={steps.length}
                now
                docsUrl={docsUrl}
                waiting={waiting}
              />
            ) : (
              <div className="step-detail">
                <span className="eyebrow step-count">
                  {running ? "Starting" : "Ready"} · {String(steps.length)} steps
                </span>
                <h2 className="step-title">{idle.title}</h2>
                <p className="step-explain">{idle.text}</p>
                {running && view.runId !== null ? (
                  <WaitLine text="Getting ready: reading your balance on Stellar" waitKey={view.runId} />
                ) : null}
              </div>
            )}
            {playback.finished && selectedStep === undefined && proof !== undefined ? null : (
              <StepList
                steps={steps}
                lookOf={lookOf}
                selected={selected}
                onSelect={(id) => {
                  setSelected((current) => (current === id ? null : id));
                }}
              />
            )}
          </aside>
        </div>
      </section>
    </div>
  );
}

function displayPlaceholder(url: string): string {
  return url.replace(/^https?:\/\//, "");
}
