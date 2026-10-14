/**
 * The codes Rail402's client packages raise on the caller's side: the SDK, the seller helpers, the
 * rail402-mcp server, the rail402 command line and the Playground. They are never returned by the service, so they
 * are kept out of its registry (`@rail402.dev/service/codes`) and documented in their own sections of
 * the error-code reference, with the `paid` value each carries by default and the CLI exit status.
 */
import { mergeCodes, type CodeSet } from "@rail402.dev/errors";
import { egressCodes } from "@rail402.dev/safe-fetch/codes";
import {
  accountCodes,
  defaultPaid,
  discoveryClientCodes,
  keyCodes,
  mcpTargetCodes,
  networkCodes,
  paymentCodes,
  type AgentCode,
  type Paid,
} from "@rail402.dev/sdk";
import { sellerCodes } from "@rail402.dev/sdk/seller/codes";
import { defaultPaidFor, rpcCodes, toolCodes, type McpServerCode } from "@rail402.dev/mcp";
import { cliCodes, cliErrorCodes, defaultPaidOf, exitStatusFor, type CliErrorCode } from "@rail402.dev/cli";
import { playgroundClientCodes, playgroundServerCodes } from "@rail402.dev/playground/codes";
import type { CodeGroup } from "@rail402.dev/service/codes";

/** One documented group of client-side codes. */
export interface ClientCodeGroup extends CodeGroup {
  /** The `paid` value a code carries unless the error states otherwise; undefined when it never concerns a payment. */
  readonly paid: (code: string) => Paid | undefined;
}

const SDK =
  "Thrown by `@rail402.dev/sdk` as a `PaymentError` with `code`, `reason`, `retryable`, `paid` and `details`.";
const MCP =
  "Returned by the rail402-mcp tools as `isError: true` with `structuredContent.error` carrying the same fields.";
const CLI =
  "Printed by the rail402 command line in the `error` object of its JSON output, with the exit status shown.";

const agentPaid = (code: string): Paid | undefined =>
  Object.hasOwn(defaultPaid, code) ? defaultPaid[code as AgentCode] : undefined;

function agentGroup(id: string, title: string, set: string, pkg: string, codes: CodeSet): ClientCodeGroup {
  return { id, title, set, package: pkg, where: `${SDK} ${MCP} ${CLI}`, codes, paid: agentPaid };
}

/** The client-side code sets, grouped as the error-code reference documents them. */
export const clientCodeGroups: readonly ClientCodeGroup[] = [
  agentGroup("payment", "Buyer payments", "paymentCodes", "@rail402.dev/sdk", paymentCodes),
  agentGroup(
    "discovery-client",
    "Buyer discovery",
    "discoveryClientCodes",
    "@rail402.dev/sdk",
    discoveryClientCodes,
  ),
  agentGroup("mcp-target", "Paid MCP tools", "mcpTargetCodes", "@rail402.dev/sdk", mcpTargetCodes),
  agentGroup("network", "Stellar RPC and transactions", "networkCodes", "@rail402.dev/sdk", networkCodes),
  agentGroup(
    "egress",
    "Outbound requests (SSRF and egress)",
    "egressCodes",
    "@rail402.dev/safe-fetch",
    egressCodes,
  ),
  agentGroup("keys", "Signing keys", "keyCodes", "@rail402.dev/sdk", keyCodes),
  agentGroup("account", "Account setup", "accountCodes", "@rail402.dev/sdk", accountCodes),
  {
    id: "seller",
    title: "Seller helpers",
    set: "sellerCodes",
    package: "@rail402.dev/sdk/seller",
    where:
      "Thrown by `@rail402.dev/sdk/seller` as a `SellerError` when a route or tool declaration is invalid, and reported as findings by `validateListing` and `checkSellerOrigin`. The `rail402 seller` commands print them in their JSON output.",
    codes: sellerCodes,
    paid: () => undefined,
  },
  {
    id: "mcp-tool",
    title: "rail402-mcp tool layer",
    set: "toolCodes",
    package: "@rail402.dev/mcp",
    where: `${MCP} These codes come from the tool layer itself, around the SDK.`,
    codes: toolCodes,
    paid: (code) => defaultPaidFor(code as McpServerCode),
  },
  {
    id: "mcp-rpc",
    title: "rail402-mcp protocol errors",
    set: "rpcCodes",
    package: "@rail402.dev/mcp",
    where:
      "Returned by the rail402-mcp server as a JSON-RPC error (`-32601`, `-32602` or `-32603`) whose `data` carries `{ code, reason }`, for a request that never reaches a tool. An unknown tool is the same kind of error, with `tool_unknown`. Nothing is paid.",
    codes: rpcCodes,
    paid: () => "none",
  },
  {
    id: "cli",
    title: "rail402 command line",
    set: "cliCodes",
    package: "@rail402.dev/cli",
    where: CLI,
    codes: cliCodes,
    paid: (code) => defaultPaidOf(code as CliErrorCode),
  },
  {
    id: "playground-server",
    title: "Playground server",
    set: "playgroundServerCodes",
    package: "@rail402.dev/playground/codes",
    where:
      "Returned by the Playground server as `{ error: { code, reason, retryable, details } }`. A relay refusal means nothing reached the seller.",
    codes: playgroundServerCodes,
    paid: () => "none",
  },
  {
    id: "playground-client",
    title: "Playground page",
    set: "playgroundClientCodes",
    package: "@rail402.dev/playground/codes",
    where:
      "Shown by the Playground page in the browser, next to the codes of the packages above, which it shows unchanged.",
    codes: playgroundClientCodes,
    // A stopped run may have sent a payment; the page keeps proving it in the background.
    paid: (code) => (code === "playground_run_aborted" ? "unknown" : "none"),
  },
];

/** Every client-side code, merged: importing this module fails if two client sets claim one code. */
export const allClientCodes = mergeCodes(
  paymentCodes,
  discoveryClientCodes,
  mcpTargetCodes,
  networkCodes,
  egressCodes,
  keyCodes,
  accountCodes,
  sellerCodes,
  toolCodes,
  rpcCodes,
  cliCodes,
  playgroundServerCodes,
  playgroundClientCodes,
);

/** The exit status rail402 uses for a code, or undefined when the command line never reports it. */
export function cliExitStatus(code: string, paid: Paid | undefined): number | undefined {
  if (!Object.hasOwn(cliErrorCodes, code)) return undefined;
  const spec = cliErrorCodes[code as CliErrorCode];
  return exitStatusFor({ code, paid: paid ?? "none", retryable: spec.retryable });
}
