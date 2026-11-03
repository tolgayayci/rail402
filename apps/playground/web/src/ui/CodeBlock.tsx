/**
 * Code or commands on a dark panel: a title bar (the file or "Terminal", the language, a copy button),
 * then the lines, each with its number (a `$` prompt for shell commands) and coloured by kind. The
 * colouring only wraps spans around the text, and the numbers and prompts are drawn by CSS, so what is
 * selected or copied is the code itself.
 */
import { useState, type ReactElement, type ReactNode } from "react";
import { CopyButton } from "./CopyButton.tsx";
import { ChevronIcon } from "./icons.tsx";

export type CodeLanguage = "shell" | "ts" | "json" | "http";

type TokenKind = "string" | "comment" | "keyword" | "key" | "number" | "function" | "flag";

const STRING = String.raw`"(?:[^"\\\n]|\\.)*"`;

/** Per language, the kinds of token in order of precedence: the first that matches at a place wins. */
const RULES: Readonly<Record<CodeLanguage, readonly (readonly [TokenKind, string])[]>> = {
  // A comment starts at a `#` at the start of a line or after whitespace.
  shell: [
    ["string", STRING],
    ["comment", String.raw`(?:^|(?<=\s))#.*$`],
    ["flag", String.raw`(?<=\s)--?[A-Za-z][\w-]*`],
    ["function", String.raw`^(?:rail402|npm|pnpm|claude)\b`],
  ],
  ts: [
    ["string", STRING],
    ["comment", String.raw`\/\/.*$`],
    ["keyword", String.raw`\b(?:import|from|const|new|await|export|return)\b`],
    ["function", String.raw`\b[A-Za-z_]\w*(?=\()`],
  ],
  json: [
    ["comment", String.raw`\/\/.*$`],
    ["key", `${STRING}(?=\\s*:)`],
    ["string", STRING],
    ["keyword", String.raw`\b(?:true|false|null)\b`],
    ["number", String.raw`-?\b\d+(?:\.\d+)?\b`],
  ],
  http: [
    ["comment", String.raw`(?:^|(?<=\s))#.*$`],
    ["keyword", String.raw`^(?:GET|POST|HTTP\/1\.1)\b`],
    ["number", String.raw`\b[2-5]\d\d\b(?= [A-Z])`],
    ["key", String.raw`^[A-Za-z-]+(?=:)`],
    ["string", STRING],
  ],
};

const PATTERNS: Readonly<Record<CodeLanguage, RegExp>> = Object.fromEntries(
  Object.entries(RULES).map(([language, rules]) => [
    language,
    new RegExp(rules.map(([, source]) => `(${source})`).join("|"), "gm"),
  ]),
) as Record<CodeLanguage, RegExp>;

const LANGUAGE_LABEL: Readonly<Record<CodeLanguage, string>> = {
  shell: "Shell",
  ts: "TypeScript",
  json: "JSON",
  http: "HTTP",
};

/** The text cut into plain runs and coloured tokens. */
export function tokenize(code: string, language: CodeLanguage): readonly (string | [TokenKind, string])[] {
  const rules = RULES[language];
  const parts: (string | [TokenKind, string])[] = [];
  let last = 0;
  for (const match of code.matchAll(PATTERNS[language])) {
    const [text] = match;
    if (text === "") continue;
    if (match.index > last) parts.push(code.slice(last, match.index));
    const group = match.slice(1).findIndex((value: string | undefined) => value !== undefined);
    parts.push([rules[group]?.[0] ?? "keyword", text]);
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

/** The coloured code, one element per line, each marked with what its gutter shows. */
function lines(code: string, language: CodeLanguage): ReactNode[] {
  const rows: ReactNode[][] = [[]];
  tokenize(code, language).forEach((part, index) => {
    const [kind, text] = typeof part === "string" ? [undefined, part] : part;
    text.split("\n").forEach((piece, at) => {
      if (at > 0) rows.push([]);
      if (piece === "") return;
      rows[rows.length - 1]?.push(
        kind === undefined ? (
          piece
        ) : (
          <span key={`${String(index)}-${String(at)}`} className={`code-${kind}`}>
            {piece}
          </span>
        ),
      );
    });
  });
  const source = code.split("\n");
  return rows.map((row, index) => {
    // A shell command shows a prompt; a line that continues the one before it shows none.
    const gutter =
      language === "shell"
        ? (source[index] ?? "").trim() === "" || /\\$/.test(source[index - 1] ?? "")
          ? ""
          : "$"
        : String(index + 1);
    // The line is a grid of the gutter and one cell of code, so the code's runs stay on one row.
    return (
      <span key={index} className="code-line" data-gutter={gutter}>
        <span className="code-text">{row}</span>
      </span>
    );
  });
}

export function CodeBlock({
  code,
  language,
  label,
  title,
  className,
  foldImports = false,
}: {
  readonly code: string;
  readonly language: CodeLanguage;
  /** What is copied, as the copy button's accessible name: "Copy the install command". */
  readonly label: string;
  /** The title bar's name for the code: a file name, or "Terminal" (the default for shell). */
  readonly title?: string;
  readonly className?: string;
  /** Shows a TypeScript block's leading imports folded into one line that opens them. They are always copied. */
  readonly foldImports?: boolean;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const parts = foldImports ? splitImports(code) : undefined;
  const count = parts === undefined ? 0 : parts.imports.split("\n").length;
  const shown = parts === undefined || open ? code : parts.rest;
  return (
    <div className={`code-block${className === undefined ? "" : ` ${className}`}`} data-theme="dark">
      <div className="code-bar">
        <span className="code-title">
          {title ?? (language === "shell" ? "Terminal" : LANGUAGE_LABEL[language])}
        </span>
        <span className="code-language">{LANGUAGE_LABEL[language]}</span>
        <CopyButton text={code} label={label} className="code-copy" />
      </div>
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
          {open
            ? count === 1
              ? "Hide the import"
              : `Hide the ${String(count)} imports`
            : `${String(count)} import${count === 1 ? "" : "s"}, copied with the code`}
        </button>
      )}
      <pre tabIndex={0} data-language={language}>
        <code>{lines(shown, language)}</code>
      </pre>
    </div>
  );
}
