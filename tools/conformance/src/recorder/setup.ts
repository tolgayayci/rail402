/**
 * Vitest setup file: records every code a test file sees returned (published on the `rail402:code`
 * diagnostics channel) into its own file in the directory the global setup provides.
 */
import { randomUUID } from "node:crypto";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, inject } from "vitest";
import { CODE_CHANNEL, type CodeEvent } from "@rail402.dev/errors";

const seen = new Set<string>();
const record = (message: unknown) => {
  const code = (message as Partial<CodeEvent> | null)?.code;
  if (typeof code === "string") seen.add(code);
};
subscribe(CODE_CHANNEL, record);

afterAll(() => {
  unsubscribe(CODE_CHANNEL, record);
  if (seen.size === 0) return;
  writeFileSync(join(inject("codesCoverageDir"), `${randomUUID()}.json`), JSON.stringify([...seen].sort()));
});
