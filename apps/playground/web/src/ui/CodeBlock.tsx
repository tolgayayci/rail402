/**
 * A block of code or commands on a dark panel, lightly coloured (strings, comments, keywords) and with
 * a copy button. The colouring only wraps spans around the text: what is copied is the text itself.
 */
import { useState, type ReactElement, type ReactNode } from "react";
import { CopyButton } from "./CopyButton.tsx";
import { ChevronIcon } from "./icons.tsx";

export type CodeLanguage = "shell" | "ts" | "json";

type TokenKind = "string" | "comment" | "keyword";

const PATTERNS: Readonly<Record<CodeLanguage, RegExp>> = {
  // A comment starts at a `#` at the start of a line or after whitespace.
  shell: /("(?:[^"\\\n]|\\.)*")|((?:^|(?<=\s))#.*$)/gm,
  ts: /("(?:[^"\\\n]|\\.)*")|(\/\/.*$)|\b(import|from|const|new|await|export)\b/gm,
  json: /("(?:[^"\\\n]|\\.)*")/gm,
};

/** The text cut into plain runs and coloured tokens. */
export function tokenize(code: string, language: CodeLanguage): readonly (string | [TokenKind, string])[] {
  const parts: (string | [TokenKind, string])[] = [];
  let last = 0;
  for (const match of code.matchAll(PATTERNS[language])) {
    const [text] = match;
    if (text === "") continue;
    if (match.index > last) parts.push(code.slice(last, match.index));
    const kind: TokenKind =
      match[1] !== undefined ? "string" : match[2] !== undefined ? "comment" : "keyword";
    parts.push([kind, text]);
    last = match.index + text.length;
  }
  if (last < code.length) parts.push(code.slice(last));
  return parts;
}

/** The leading `import` lines of TypeScript code, and the rest after the blank line that follows them. */
function splitImports(code: string): { readonly imports: string; readonly rest: string } | undefined {
  const match = /^((?:import [^\n]*\n)+)\n+/.exec(code);
  if (match === null) return undefined;
  return { imports: (match[1] ?? "").trimEnd(), rest: code.slice(match[0].length) };
}

function colour(code: string, language: CodeLanguage): ReactNode[] {
  return tokenize(code, language).map((part, index) =>
    typeof part === "string" ? (
      part
    ) : (
      <span key={index} className={`code-${part[0]}`}>
        {part[1]}
      </span>
    ),
  );
}

export function CodeBlock({
  code,
  language,
  label,
  className,
  foldImports = false,
}: {
  readonly code: string;
  readonly language: CodeLanguage;
  /** What is copied, as the copy button's accessible name: "Copy the install command". */
  readonly label: string;
  readonly className?: string;
  /** Shows a TypeScript block's leading imports folded into one line that opens them. They are always copied. */
  readonly foldImports?: boolean;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const parts = foldImports ? splitImports(code) : undefined;
  const count = parts === undefined ? 0 : parts.imports.split("\n").length;
  return (
    <div className={`code-block${className === undefined ? "" : ` ${className}`}`}>
      {parts === undefined ? null : (
        <button
          type="button"
          className="code-fold"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
          }}
        >
          <ChevronIcon />
          {open ? `Hide the ${String(count)} imports` : `${String(count)} imports, copied with the code`}
        </button>
      )}
      <pre tabIndex={0}>
        <code>
          {parts === undefined
            ? colour(code, language)
            : open
              ? colour(`${parts.imports}\n\n${parts.rest}`, language)
              : colour(parts.rest, language)}
        </code>
      </pre>
      <CopyButton text={code} label={label} className="code-copy" />
    </div>
  );
}
