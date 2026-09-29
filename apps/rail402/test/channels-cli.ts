import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/channels.ts", import.meta.url));

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** stdout parsed as one JSON object per line. */
  readonly lines: Record<string, unknown>[];
}

/**
 * Runs the channels operator command from source, as `node dist/channels.js` runs it from the build,
 * with exactly the given environment.
 */
export function channels(args: readonly string[], env: Record<string, string>): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--conditions=@rail402/source", CLI, ...args],
      { env: { PATH: process.env["PATH"] ?? "", ...env }, timeout: 120_000 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        const lines = stdout
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        resolve({ code, stdout, stderr, lines });
      },
    );
  });
}
