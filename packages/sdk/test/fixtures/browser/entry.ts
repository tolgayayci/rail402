// What a browser page imports from Rail402. The bundle check builds this file for browsers.
export * as sdk from "@rail402.dev/sdk/browser";
export * as stellar from "@rail402.dev/stellar";
export * as uptoClient from "@rail402.dev/upto/client";
export * as safeFetch from "@rail402.dev/safe-fetch/shared";
// By path: @rail402.dev/mcp depends on this package, so it is not a dependency here.
export * as mcpTools from "../../../../mcp/src/tools-entry.ts";
