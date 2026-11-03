/**
 * Preloaded with `node --import`: records the URL of every module the process resolves and writes the
 * list as JSON to the file named by RAIL402_TRACE_OUT when the process exits.
 */
import { writeFileSync } from "node:fs";
import { registerHooks } from "node:module";

const out = process.env["RAIL402_TRACE_OUT"];
if (out === undefined) throw new Error("RAIL402_TRACE_OUT is not set");
const loaded = new Set<string>();
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    loaded.add(resolved.url);
    return resolved;
  },
});
process.on("exit", () => {
  writeFileSync(out, JSON.stringify([...loaded]));
});
