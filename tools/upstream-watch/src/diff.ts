/** A unified line diff (Myers' algorithm) between two versions of an upstream file. */

type Edit = { readonly op: " " | "-" | "+"; readonly line: string };

/** Beyond this many changed lines the diff is not computed; the issue links to upstream instead. */
export const MAX_EDIT_DISTANCE = 2000;

function edits(a: readonly string[], b: readonly string[]): Edit[] | undefined {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    if (d > MAX_EDIT_DISTANCE) return undefined;
    // Only diagonals -d..d are read when walking back from step d.
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0))
          ? (v[offset + k + 1] ?? 0)
          : (v[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  // Walk the trace back from the end to recover the edit script.
  const script: Edit[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const row = trace[d] as Int32Array;
    const at = (diagonal: number) => row[diagonal + d] ?? 0;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      script.push({ op: " ", line: a[x - 1] as string });
      x--;
      y--;
    }
    if (d > 0) {
      if (down) script.push({ op: "+", line: b[y - 1] as string });
      else script.push({ op: "-", line: a[x - 1] as string });
    }
    x = prevX;
    y = prevY;
  }
  return script.reverse();
}

const lines = (text: string) => {
  const split = text.replace(/\r\n/g, "\n").split("\n");
  if (split.at(-1) === "") split.pop();
  return split;
};

/**
 * Unified diff hunks with `context` lines around each change; empty when the texts are equal and
 * undefined when more than MAX_EDIT_DISTANCE lines changed.
 */
export function unifiedDiff(before: string, after: string, context = 3): string | undefined {
  const a = lines(before);
  const b = lines(after);
  const script = edits(a, b);
  if (script === undefined) return undefined;
  const out: string[] = [];
  let index = 0;
  let oldLine = 1;
  let newLine = 1;
  const positions = script.map((edit) => {
    const at = { old: oldLine, new: newLine };
    if (edit.op !== "+") oldLine++;
    if (edit.op !== "-") newLine++;
    return at;
  });
  while (index < script.length) {
    if (script[index]?.op === " ") {
      index++;
      continue;
    }
    const start = Math.max(0, index - context);
    let end = index;
    // Extend the hunk while the next change is within 2 × context lines.
    for (;;) {
      while (end < script.length && script[end]?.op !== " ") end++;
      let next = end;
      while (next < script.length && script[next]?.op === " ") next++;
      if (next < script.length && next - end <= 2 * context) end = next;
      else break;
    }
    const stop = Math.min(script.length, end + context);
    const hunk = script.slice(start, stop);
    const from = positions[start] as { old: number; new: number };
    const oldCount = hunk.filter((edit) => edit.op !== "+").length;
    const newCount = hunk.filter((edit) => edit.op !== "-").length;
    out.push(`@@ -${from.old},${oldCount} +${from.new},${newCount} @@`);
    for (const edit of hunk) out.push(`${edit.op}${edit.line}`);
    index = stop;
  }
  return out.join("\n");
}
