import type { ReactElement, ReactNode } from "react";
import type { CodedError } from "../engine/types.ts";

/** A coded error or note: every error surface shows the stable code and its reason. */
export function Notice({
  error,
  tone = "error",
  children,
}: {
  readonly error: Pick<CodedError, "code" | "reason">;
  readonly tone?: "error" | "info";
  readonly children?: ReactNode;
}): ReactElement {
  return (
    <div className="notice" data-kind={tone} role={tone === "error" ? "alert" : "status"}>
      <code className="notice-code">{error.code}</code>
      <span className="notice-reason">{error.reason}</span>
      {children}
    </div>
  );
}
