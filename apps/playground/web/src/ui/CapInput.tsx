import { useId, type ReactElement } from "react";
import { capState, type CapState } from "../projection/cap.ts";

/**
 * The per-call spending cap. Required: an empty or malformed cap disables paying. Above the
 * operator's ceiling the field says the cap is clamped to it.
 */
export function CapInput({
  value,
  onChange,
  ceiling,
  decimals,
  symbol,
  presets = [],
  label = "Spending cap",
  hint = "Your buyer refuses to sign anything above this.",
  compact = false,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly ceiling: string;
  readonly decimals: number;
  readonly symbol: string;
  readonly presets?: readonly { readonly label: string; readonly value: string }[];
  readonly label?: string;
  readonly hint?: string;
  readonly compact?: boolean;
}): ReactElement {
  const id = useId();
  const state: CapState = capState(value, ceiling, decimals);
  const message = !state.valid
    ? state.message
    : state.clamped
      ? `Above the ${ceiling} ${symbol} ceiling: the cap used is ${state.effective} ${symbol}.`
      : hint;
  return (
    <div className="cap" data-compact={compact} data-invalid={!state.valid}>
      <label htmlFor={id} className="cap-label">
        {label}
      </label>
      <span className="cap-field">
        <input
          id={id}
          className="cap-input mono"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          required
          aria-invalid={!state.valid}
          aria-describedby={`${id}-hint`}
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
        <span className="cap-unit">{symbol}</span>
      </span>
      {presets.length > 0 ? (
        <span className="cap-presets">
          {presets.map((preset) => (
            <button
              key={preset.value}
              type="button"
              className="chip"
              aria-pressed={preset.value === value}
              onClick={() => {
                onChange(preset.value);
              }}
            >
              {preset.label}
            </button>
          ))}
        </span>
      ) : null}
      <span id={`${id}-hint`} className="cap-hint" role={state.valid ? undefined : "alert"}>
        {message}
      </span>
    </div>
  );
}
