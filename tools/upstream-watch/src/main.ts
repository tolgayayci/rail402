/**
 * Compares the upstream x402 files, packages and URLs in tools/upstream-watch/watch.json with
 * upstream, and keeps the tracking issue up to date.
 *
 *   pnpm upstream:watch [--check]   print the drift (exit 1 when there is any)
 *   pnpm upstream:watch --json      print the comparison as JSON
 *   pnpm upstream:watch --report-issue --tracker <owner/name> [--watch-commit <sha>] [--dry-run]
 *                                   create, update or close the tracking issue; --dry-run prints
 *                                   the action and the issue body instead of writing
 *
 * Reads the GitHub API with GITHUB_TOKEN when it is set (unauthenticated reads are limited to 60
 * an hour); writing the issue needs it. Exit codes: 0 no drift (or the issue was reported), 1 drift,
 * 2 upstream could not be fully checked: nothing is written then, so a failed run never closes or
 * edits the issue.
 */
import { runCli } from "./cli.ts";

process.exitCode = await runCli(process.argv.slice(2), {
  env: process.env,
  out: (line) => {
    console.log(line);
  },
  err: (line) => {
    console.error(line);
  },
});
