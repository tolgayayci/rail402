/**
 * "Try it with your wallet": a form made from the listing's declared fields, the per-call cap, and
 * one button that pays the listing and calls it through the engine. The run's progress shows as it
 * happens, then its result in words with the transaction, and a link to watch it in the Lab.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import type { ListingField, ListingView } from "../../engine/events.ts";
import type { CodedError } from "../../engine/types.ts";
import { capState } from "../../projection/cap.ts";
import {
  callParams,
  callUrl,
  initialValues,
  listingPrice,
  priceAboveCap,
  resultHeadline,
  schemeOf,
} from "../../projection/listings.ts";
import { projectProof, projectVerdict, shortHash } from "../../projection/proof.ts";
import { projectStage } from "../../projection/stage.ts";
import { DoneIcon, ExternalIcon, FailedIcon, Spinner } from "../../ui/icons.tsx";
import { ExternalLink } from "../../ui/links.tsx";
import { Notice } from "../../ui/Notice.tsx";
import { toCodedError, useEngine, useEngineState, useRunView } from "../engine.tsx";
import { canRun, runBlocker } from "../gate.ts";
import { Link } from "../router.tsx";
import { labPath } from "../routes.ts";
import { bazaarRunKey, usePageRun } from "../runs.tsx";
import { FinishSetup } from "../WalletDialog.tsx";

type FieldElement = HTMLInputElement | HTMLSelectElement;

/** A request to focus a listing's form; `n` tells requests apart. */
export interface FocusRequest {
  readonly id: string;
  readonly n: number;
}

export function TryIt({
  listing,
  focusForm,
  footerEnd,
  onPaid,
}: {
  readonly listing: ListingView;
  /** Called once a payment of this listing is proven on chain. */
  readonly onPaid?: () => void;
  /** Set when the visitor asks to try a listing: its form's first field takes focus. */
  readonly focusForm: FocusRequest | null;
  /** The panel footer's other end, beside the Lab link. */
  readonly footerEnd: ReactNode;
}): ReactElement {
  const engine = useEngine();
  const state = useEngineState();
  const { config } = engine;
  const id = useId();
  const fields = useMemo(() => listing.input?.fields ?? [], [listing]);
  const [values, setValues] = useState(() => initialValues(fields));
  const [cap, setCap] = useState(config.caps.perCallDefault);
  const [startError, setStartError] = useState<CodedError | null>(null);
  const [handle, setHandle] = usePageRun(bazaarRunKey(listing.id));
  const view = useRunView(handle);
  const firstField = useRef<FieldElement | null>(null);

  // "Try" on a row brings this listing's form forward, once per request.
  const focused = useRef<number | null>(null);
  useEffect(() => {
    if (focusForm?.id !== listing.id || focused.current === focusForm.n) return;
    focused.current = focusForm.n;
    firstField.current?.focus({ preventScroll: true });
  }, [focusForm, listing.id]);

  const scheme = schemeOf(listing) ?? "exact";
  const price = listingPrice(listing, config.asset.symbol);
  const capCheck = capState(cap, config.caps.perCallCeiling, config.asset.decimals);
  const params = callParams(fields, values);
  const url = params.ok ? callUrl(listing, params.params) : undefined;
  const running = handle !== null && view.summary === null;
  const blocker = runBlocker(state);
  const payable = listing.callable !== false;
  const ready = payable && capCheck.valid && params.ok && canRun(state) && !running;

  const stage = useMemo(
    () =>
      projectStage(view.events, {
        mode: scheme,
        plan: "normal",
        config,
        ...(url === undefined ? { target: listing.resource } : { target: url }),
      }),
    [view.events, scheme, config, url, listing.resource],
  );
  const done = stage.steps.filter((step) => !step.planned);
  const now = done.at(-1);
  const proof = useMemo(
    () => (view.summary === null ? undefined : projectProof(view.events, { config, ours: stage.ours })),
    [view.summary, view.events, config, stage.ours],
  );
  const verdict = useMemo(
    () =>
      view.summary !== null && proof === undefined
        ? projectVerdict(view.events, { config, ours: stage.ours })
        : undefined,
    [view.summary, proof, view.events, config, stage.ours],
  );

  // A proven payment changes the listing's count of paid calls.
  const paidRun = proof === undefined ? null : view.runId;
  useEffect(() => {
    if (paidRun !== null) onPaid?.();
  }, [paidRun, onPaid]);

  // The result appears below the form: bring it into view in the panel.
  const outcome = useRef<HTMLDivElement>(null);
  const finished = view.summary !== null;
  useEffect(() => {
    if (!finished) return;
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    outcome.current?.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "nearest" });
  }, [finished]);

  const pay = (): void => {
    if (!params.ok || !ready) return;
    setStartError(null);
    try {
      setHandle(
        engine.pay({ listingId: listing.id, type: listing.type, params: params.params, cap: capCheck.value }),
      );
    } catch (error) {
      setStartError(toCodedError(error));
    }
  };

  const amount = price === null ? null : `${price.upto ? "up to " : ""}${price.amount} ${price.symbol}`;
  const label = running ? "Paying…" : amount === null ? "Pay and call" : `Pay ${amount} and call`;
  const overCap = capCheck.valid && priceAboveCap(price, capCheck.effective, config.asset.decimals);
  const mode = scheme;
  const watchLink =
    handle !== null ? labPath(mode, { watch: listing.id, ...(url === undefined ? {} : { url }) }) : undefined;
  const runLink =
    handle === null && listing.type === "http" && (listing.method ?? "GET") === "GET" && url !== undefined
      ? labPath(mode, { url })
      : undefined;

  return (
    <>
      <div className="try-it">
        <span className="eyebrow try-eyebrow">Try it with your wallet</span>
        {!payable ? (
          <Notice
            tone="info"
            error={
              listing.notPayable ?? {
                code: "listing_not_payable",
                reason: "This Playground's wallet cannot pay this listing.",
              }
            }
          />
        ) : (
          <form
            className="try-form"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              pay();
            }}
          >
            {fields.length === 0 ? <p className="try-none">This call takes no parameters.</p> : null}
            <div className="try-fields">
              {fields.map((field, index) => (
                <FieldInput
                  key={field.name}
                  id={`${id}-${field.name}`}
                  field={field}
                  value={values[field.name] ?? ""}
                  invalid={!params.ok && params.field === field.name && (values[field.name] ?? "") !== ""}
                  disabled={running}
                  inputRef={
                    index === 0
                      ? (element) => {
                          firstField.current = element;
                        }
                      : undefined
                  }
                  onChange={(value) => {
                    setValues((current) => ({ ...current, [field.name]: value }));
                  }}
                />
              ))}
              <span className="try-field try-cap">
                <label htmlFor={`${id}-cap`}>Cap</label>
                <span className="run-cap-field">
                  <input
                    id={`${id}-cap`}
                    className="mono"
                    inputMode="decimal"
                    autoComplete="off"
                    spellCheck={false}
                    value={cap}
                    disabled={running}
                    aria-invalid={!capCheck.valid}
                    onChange={(event) => {
                      setCap(event.target.value);
                    }}
                  />
                  <span className="run-cap-unit mono">{config.asset.symbol}</span>
                </span>
              </span>
            </div>
            <button type="submit" className="try-pay" disabled={!ready} aria-busy={running}>
              {running ? <Spinner /> : null}
              {label}
            </button>
            {!capCheck.valid ? (
              <p className="try-hint" data-invalid="true">
                {capCheck.message}
              </p>
            ) : !params.ok && (values[params.field] ?? "") !== "" ? (
              <p className="try-hint" data-invalid="true">
                {params.message}
              </p>
            ) : overCap ? (
              <p className="try-hint">
                The price is above your cap: your wallet will refuse it before signing anything.
              </p>
            ) : capCheck.clamped ? (
              <p className="try-hint">
                Above the {config.caps.perCallCeiling} {config.asset.symbol} ceiling: the cap used is{" "}
                {capCheck.effective} {config.asset.symbol}.
              </p>
            ) : (
              <p className="try-hint">
                Your wallet signs at most your cap. The facilitator pays the network fee, so you need no XLM.
              </p>
            )}
          </form>
        )}
        {payable && blocker !== null && blocker.code !== "playground_run_in_progress" && !running ? (
          <Notice tone="info" error={blocker}>
            {blocker.code === "playground_wallet_not_set_up" ? <FinishSetup /> : null}
          </Notice>
        ) : null}
        {startError !== null ? <Notice error={startError} /> : null}

        {running ? (
          <div className="try-progress" data-mode={mode}>
            <div className="stage-progress" aria-hidden="true">
              {stage.steps.map((step) => (
                <span
                  key={step.id}
                  className="stage-progress-segment"
                  data-look={step.planned ? "pending" : step === now ? "current" : "done"}
                />
              ))}
            </div>
            <p className="try-step" aria-live="polite">
              {now === undefined
                ? "Starting…"
                : `Step ${String(done.length)} of ${String(stage.steps.length)} · ${now.title}`}
            </p>
          </div>
        ) : null}

        <div ref={outcome} className="try-outcome">
          {proof !== undefined ? (
            <ResultCard
              pairs={proof.result}
              paid={`${proof.paid} ${proof.symbol}`}
              untaken={proof.scheme === "upto" ? proof.untaken : null}
              tx={proof.tx}
              fee={proof.feeSponsored ? `fee by ${proof.facilitator}` : null}
            />
          ) : verdict !== undefined ? (
            <div className="try-result" data-good={verdict.good} role="status">
              <p className="try-result-title">
                {verdict.good ? <DoneIcon /> : <FailedIcon />}
                <b>{verdict.title}</b>
              </p>
              {verdict.code !== null ? (
                <p className="try-result-code">
                  <code>{verdict.code}</code>
                  {verdict.reason === null ? null : <span>{verdict.reason}</span>}
                </p>
              ) : null}
              <p className="try-result-meta">
                {verdict.signed === 0 ? "Nothing was signed." : null}
                {verdict.balance === "unchanged" ? " Your balance did not change." : null}
              </p>
              {verdict.transactions.map((tx) => (
                <ExternalLink key={tx.hash} className="try-tx mono" href={tx.url}>
                  {tx.label} {shortHash(tx.hash)} <ExternalIcon />
                </ExternalLink>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      <div className="listing-panel-foot">
        {watchLink !== undefined || runLink !== undefined ? (
          <Link className="try-lab" to={watchLink ?? runLink ?? "/"}>
            {watchLink !== undefined ? "Watch this payment in the Lab →" : "Run it step by step in the Lab →"}
          </Link>
        ) : (
          <span />
        )}
        {footerEnd}
      </div>
    </>
  );
}

function FieldInput({
  id,
  field,
  value,
  invalid,
  disabled,
  inputRef,
  onChange,
}: {
  readonly id: string;
  readonly field: ListingField;
  readonly value: string;
  readonly invalid: boolean;
  readonly disabled: boolean;
  readonly inputRef: ((element: FieldElement | null) => void) | undefined;
  readonly onChange: (value: string) => void;
}): ReactElement {
  const options = field.kind === "boolean" ? ["true", "false"] : field.options;
  return (
    <div className="try-field">
      <label htmlFor={id}>
        <span className="mono">{field.name}</span>
        {field.description === null ? null : <span className="try-field-desc"> · {field.description}</span>}
        {field.required ? null : <span className="try-field-optional"> · optional</span>}
      </label>
      {options !== null ? (
        <select
          id={id}
          ref={inputRef}
          value={value}
          disabled={disabled}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        >
          {field.required ? null : <option value="">—</option>}
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          ref={inputRef}
          value={value}
          disabled={disabled}
          required={field.required}
          aria-invalid={invalid}
          inputMode={field.kind === "integer" ? "numeric" : field.kind === "number" ? "decimal" : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder={field.example ?? ""}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      )}
    </div>
  );
}

/** A small picture of the weather words, when they name rain, cloud or sun. */
function ConditionsIcon({ conditions }: { readonly conditions: string }): ReactElement | null {
  const words = conditions.toLowerCase();
  if (words.includes("rain") || words.includes("shower")) {
    return (
      <svg width="34" height="34" viewBox="0 0 40 40" aria-hidden="true" className="try-icon">
        <path className="try-icon-cloud" d="M12 24 a7 7 0 0 1 2-13.6 A9 9 0 0 1 31 14 a6 6 0 0 1-1 11 Z" />
        <path className="try-icon-rain" d="M15 29 l-2 5 M21 29 l-2 5 M27 29 l-2 5" />
      </svg>
    );
  }
  if (words.includes("cloud") || words.includes("overcast") || words.includes("fog")) {
    return (
      <svg width="34" height="34" viewBox="0 0 40 40" aria-hidden="true" className="try-icon">
        <path className="try-icon-cloud" d="M11 29 a7 7 0 0 1 2-13.6 A9 9 0 0 1 30 19 a6 6 0 0 1-1 10 Z" />
      </svg>
    );
  }
  if (words.includes("sun") || words.includes("clear")) {
    return (
      <svg width="34" height="34" viewBox="0 0 40 40" aria-hidden="true" className="try-icon">
        <circle className="try-icon-sun" cx="20" cy="20" r="8" />
        <path
          className="try-icon-rays"
          d="M20 4 V9 M20 31 V36 M4 20 H9 M31 20 H36 M8.7 8.7 L12.2 12.2 M27.8 27.8 L31.3 31.3 M8.7 31.3 L12.2 27.8 M27.8 12.2 L31.3 8.7"
        />
      </svg>
    );
  }
  return null;
}

/** What the call returned, in words, with what it cost and its transaction. */
function ResultCard({
  pairs,
  paid,
  untaken,
  tx,
  fee,
}: {
  readonly pairs: readonly { readonly label: string; readonly value: string }[];
  readonly paid: string;
  readonly untaken: string | null;
  readonly tx: { readonly hash: string; readonly url: string };
  readonly fee: string | null;
}): ReactElement {
  const headline = resultHeadline(pairs);
  const rest = headline === null ? pairs : pairs.filter((pair) => !headline.used.includes(pair.label));
  return (
    <div className="try-result try-result-ok" role="status">
      {headline !== null ? (
        <div className="try-headline">
          {headline.conditions === null ? null : <ConditionsIcon conditions={headline.conditions} />}
          <span>
            <b className="try-headline-value">{headline.value}</b>{" "}
            <span className="try-headline-caption">{headline.caption}</span>
          </span>
        </div>
      ) : null}
      {rest.length > 0 ? (
        <dl className="try-pairs">
          {rest.map((pair) => (
            <div key={pair.label}>
              <dt>{pair.label}</dt>
              <dd>{pair.value}</dd>
            </div>
          ))}
        </dl>
      ) : headline === null ? (
        <p className="try-none">The call returned no readable body.</p>
      ) : null}
      <p className="try-paid">
        <DoneIcon size={14} /> Paid {paid}
        {untaken === null ? "" : `, ${untaken} of the cap never taken`}
        {fee === null ? "" : ` · ${fee}`} ·{" "}
        <ExternalLink className="try-tx mono" href={tx.url}>
          {shortHash(tx.hash)} <ExternalIcon />
        </ExternalLink>
      </p>
    </div>
  );
}
