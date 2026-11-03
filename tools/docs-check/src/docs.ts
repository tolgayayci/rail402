/**
 * Reading the published quickstarts: their code blocks, install steps and the output their scripts
 * print. Pure functions, no I/O, so the clean-environment run and its tests share them.
 */

export interface CodeBlock {
  readonly lang: string;
  /** The file name after the language, as in ```ts seller.ts; undefined for untitled blocks. */
  readonly title: string | undefined;
  readonly body: string;
}

/**
 * The fenced code blocks of a page, as Mintlify publishes it (```ts seller.ts theme={…}) or as the
 * MDX source has it (```ts seller.ts). Fences inside other fences are not nested in these pages.
 */
export function codeBlocks(markdown: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const lines = markdown.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const open = /^\s*```([A-Za-z0-9_+-]*)(?:[ \t]+([^\s{]+))?.*$/.exec(lines[index] ?? "");
    if (open === null) continue;
    const indent = /^\s*/.exec(lines[index] ?? "")?.[0].length ?? 0;
    const body: string[] = [];
    for (index++; index < lines.length && !/^\s*```\s*$/.test(lines[index] ?? ""); index++) {
      body.push((lines[index] ?? "").slice(indent));
    }
    const title = open[2];
    blocks.push({
      lang: open[1] ?? "",
      title: title === undefined || title.includes("=") ? undefined : title,
      body: `${body.join("\n")}\n`,
    });
  }
  return blocks;
}

/** The block titled `title`, or an error naming the page. */
export function titledBlock(blocks: readonly CodeBlock[], title: string, page: string): CodeBlock {
  const block = blocks.find((candidate) => candidate.title === title);
  if (block === undefined) throw new Error(`${page} has no code block titled ${title}`);
  return block;
}

/** An install step the harness runs: npm with its arguments. */
export type InstallStep = readonly ["npm", ...string[]];

/**
 * The npm steps of a page's install block: `npm init -y`, `npm pkg set …` and `npm install …`, in
 * order. `mkdir` and `cd` are what the harness does itself (each page gets its own empty directory);
 * any other command is refused, so the harness never runs something it did not expect.
 */
export function installSteps(blocks: readonly CodeBlock[], page: string): InstallStep[] {
  const block = blocks.find((candidate) => candidate.lang === "sh" && /\bnpm install\b/.test(candidate.body));
  if (block === undefined) throw new Error(`${page} has no install block`);
  const steps: InstallStep[] = [];
  for (const line of block.body.split("\n")) {
    const command = line.replace(/\s+#.*$/, "").trim();
    if (command === "") continue;
    for (const part of command.split("&&").map((item) => item.trim())) {
      const words = part.split(/\s+/);
      if (words[0] === "mkdir" || words[0] === "cd") continue;
      const [tool, sub] = words;
      if (tool !== "npm" || !["init", "pkg", "install"].includes(sub ?? "")) {
        throw new Error(`${page}: unexpected install command "${part.slice(0, 80)}"`);
      }
      if (words.some((word) => !/^[A-Za-z0-9@/._=:^~-]+$/.test(word))) {
        throw new Error(`${page}: install command with unexpected characters "${part.slice(0, 80)}"`);
      }
      steps.push(words as unknown as InstallStep);
    }
  }
  if (!steps.some((step) => step[1] === "install")) throw new Error(`${page}: no npm install step`);
  return steps;
}

/** The exact versions an `npm install` step pins, e.g. { "@x402/express": "2.27.0" }. */
export function pinnedVersions(steps: readonly InstallStep[]): Record<string, string> {
  const pinned: Record<string, string> = {};
  for (const step of steps) {
    if (step[1] !== "install") continue;
    for (const spec of step.slice(2)) {
      const match = /^(@?[^@\s]+)@(.+)$/.exec(spec);
      if (match?.[1] !== undefined && match[2] !== undefined) pinned[match[1]] = match[2];
    }
  }
  return pinned;
}

/** Replaces Mintlify variables (`{{facilitatorUrl}}`) for pages read from the MDX source. */
export function substitute(text: string, variables: Readonly<Record<string, string>>): string {
  return text.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (whole, name: string) => variables[name] ?? whole);
}

/** What create-account.ts prints. The secret stays in memory: it is never logged or recorded. */
export function parseAccount(stdout: string): { readonly publicKey: string; readonly secret: string } {
  const publicKey = /^public key:\s*(G[A-Z2-7]{55})\s*$/m.exec(stdout)?.[1];
  const secret = /^secret:\s*(S[A-Z2-7]{55})\s*$/m.exec(stdout)?.[1];
  if (publicKey === undefined || secret === undefined) {
    throw new Error("create-account.ts did not print a public key and a secret");
  }
  return { publicKey, secret };
}

/** The settlement buyer.ts prints from the PAYMENT-RESPONSE header. */
export function parseSettlement(stdout: string): {
  readonly status: number;
  readonly transaction: string;
  readonly success: boolean;
} {
  const status = Number(/^(\d{3})\s/m.exec(stdout)?.[1] ?? NaN);
  const transaction = /transaction:\s*'([0-9a-f]{64})'/.exec(stdout)?.[1];
  const success = /success:\s*true/.test(stdout);
  if (!Number.isInteger(status) || transaction === undefined) {
    throw new Error("buyer.ts did not print a status and a settlement transaction");
  }
  return { status, transaction, success };
}

/**
 * The step the seller quickstart asks for behind a TLS-terminating proxy: `app.set("trust proxy", 1)`
 * right after the app is created, so the resource URL is the https URL the buyer used.
 */
export function behindTlsProxy(sellerSource: string): string {
  const created = "const app = express();";
  if (!sellerSource.includes(created)) throw new Error(`seller.ts does not contain "${created}"`);
  return sellerSource.replace(created, `${created}\napp.set("trust proxy", 1);`);
}

/** Removes every Stellar secret seed from a text, for logs and the record. */
export function redactSeeds(text: string): string {
  return text.replace(/S[A-Z2-7]{55}/g, "[redacted]");
}
