/**
 * MCP rows of the rejection audit: `rail402-mcp` spawned over stdio, exactly as an MCP host runs it,
 * configured only through its environment, with the audited Rail402 as its Bazaar and facilitator.
 * Every refusal is checked on the wire the host sees:
 *
 * - a tool rejection is a result with `isError: true` whose `structuredContent` is
 *   `{ ok: false, error: { code, reason, retryable, paid } }`, the code registered and expected, the
 *   reason non-blank and within the server's published limit, `paid: "none"` (nothing was signed), and
 *   `content[0].text` the same JSON;
 * - a protocol error (an unknown tool, params the MCP schema refuses, an unknown method) is a JSON-RPC
 *   error whose `data` carries `{ code, reason }`.
 *
 * The cases need no funds: every one is refused before anything is signed. A small local seller answers
 * the paid routes with x402 `402` challenges and redirects to a metadata address; the MCP server may
 * reach it on loopback only.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import { z } from "zod";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { MAX_REASON_LENGTH } from "@rail402.dev/mcp";
import type { CaseContext, CaseRecorder } from "./harness.ts";

export interface McpAuditOptions {
  /** Node and arguments that start rail402-mcp over stdio, e.g. `[process.execPath, "…/bin.ts"]`. */
  readonly command: readonly [string, ...string[]];
  /** The Rail402 under audit: the server's Bazaar (and, through sellers, facilitator). */
  readonly facilitator: string;
  readonly network: "stellar:testnet";
  readonly rpcUrl: string;
  /**
   * The accepted asset the policy allows, as the seller prices it. The network's USDC is built into
   * the server; any other token is configured under `symbol`, which must not be `USDC`.
   */
  readonly asset: {
    readonly contract: string;
    readonly symbol: string;
    readonly decimals: number;
    readonly builtIn?: boolean;
  };
  /** A payTo for the seller's challenges; never paid. */
  readonly payTo: string;
  /** Registered client-side codes (SDK, egress and tool codes); anything else fails the case. */
  readonly isRegistered: (code: string) => boolean;
  /** Extra variables for the server process, e.g. `NODE_EXTRA_CA_CERTS`. */
  readonly env?: Readonly<Record<string, string>>;
  readonly log?: (message: string) => void;
}

/** What the MCP server may pay per call and in total, in whole units of the asset. */
const PER_CALL = "0.05";
const SESSION_TOTAL = "0.1";

interface ToolRefusal {
  readonly code: string;
  readonly reason: string;
  readonly retryable: boolean;
  readonly paid: string;
}

/**
 * Runs the MCP cases into `recorder`. One server process serves them all; it is stopped at the end.
 */
export async function runMcpAudit(recorder: CaseRecorder, options: McpAuditOptions): Promise<void> {
  const seller = await startChallengeSeller(options);
  const directory = mkdtempSync(join(tmpdir(), "rail402-mcp-audit-"));
  const keyFile = join(directory, "buyer.key");
  // A fresh, unfunded key: every case is refused before anything is signed with it.
  writeFileSync(keyFile, Keypair.random().secret(), { mode: 0o600 });
  const denied = Keypair.random().publicKey();
  const symbol = options.asset.symbol;
  const [command, ...args] = options.command;
  const transport = new StdioClientTransport({
    command,
    args,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: directory,
      ...options.env,
      RAIL402_NETWORK: options.network,
      RAIL402_RPC_URL: options.rpcUrl,
      RAIL402_BAZAAR_URL: options.facilitator,
      RAIL402_SECRET_KEY_FILE: keyFile,
      ...(options.asset.builtIn === true
        ? {}
        : { RAIL402_ASSETS: `${symbol}:${options.asset.contract}:${String(options.asset.decimals)}` }),
      RAIL402_MAX_PER_CALL: `${PER_CALL} ${symbol}`,
      RAIL402_MAX_TOTAL: `${SESSION_TOTAL} ${symbol}`,
      RAIL402_DENIED_RECIPIENTS: denied,
      RAIL402_ALLOW_HTTP: "true",
      RAIL402_ALLOW_PRIVATE_NETWORK: "loopback",
      RAIL402_ALLOWED_PORTS: String(seller.port),
      RAIL402_LEDGER_PATH: join(directory, "ledger.sqlite"),
      RAIL402_LOG_LEVEL: "warn",
    },
    stderr: "pipe",
  });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
  const client = new Client(
    { name: "rail402-rejection-audit", version: "1" },
    { versionNegotiation: { mode: "auto" } },
  );
  try {
    await client.connect(transport).catch((error: unknown) => {
      throw new Error(
        `rail402-mcp did not start: ${error instanceof Error ? error.message : String(error)} ${stderr.join("").slice(0, 500)}`,
      );
    });
    seller.denied = denied;
    const cap = (amount: string, asset = symbol) => ({ amount, asset });
    const pay = (args: Record<string, unknown>) => ({ name: "pay_and_call", arguments: args });
    const at = (path: string) => `${seller.url}${path}`;

    const cases: readonly {
      id: string;
      title: string;
      call: { name: string; arguments: Record<string, unknown> };
      expected: readonly string[];
    }[] = [
      {
        id: "mcp-cap-missing",
        title: "a paid call without a spending cap",
        call: pay({ resource: at("/priced") }),
        expected: ["tool_input_invalid", "payment_cap_required"],
      },
      {
        id: "mcp-cap-negative",
        title: "a paid call with a negative spending cap",
        call: pay({ resource: at("/priced"), spendingCap: cap("-1") }),
        expected: ["tool_input_invalid", "payment_cap_invalid"],
      },
      {
        id: "mcp-cap-unknown-asset",
        title: "a paid call capped in an asset outside the spending policy",
        call: pay({ resource: at("/priced"), spendingCap: cap("1", "EURC") }),
        expected: ["tool_input_invalid", "payment_cap_invalid"],
      },
      {
        id: "mcp-per-call-cap",
        title: "a price above the caller's cap is refused before signing",
        call: pay({ resource: at("/priced"), spendingCap: cap("0.01") }),
        expected: ["payment_per_call_cap_exceeded"],
      },
      {
        id: "mcp-over-ceiling",
        title: "a cap above the operator's per-call ceiling is clamped: a price above the ceiling is refused",
        call: pay({ resource: at("/expensive"), spendingCap: cap("10") }),
        expected: ["payment_per_call_cap_exceeded"],
      },
      {
        id: "mcp-network-not-permitted",
        title: "a challenge for another network is refused",
        call: pay({ resource: at("/pubnet"), spendingCap: cap(PER_CALL) }),
        expected: ["payment_network_not_permitted", "payment_no_acceptable_option"],
      },
      {
        id: "mcp-asset-not-permitted",
        title: "a challenge in an asset outside the policy is refused",
        call: pay({ resource: at("/foreign-asset"), spendingCap: cap(PER_CALL) }),
        expected: ["payment_asset_not_permitted", "payment_no_acceptable_option"],
      },
      {
        id: "mcp-recipient-not-permitted",
        title: "a challenge paying a denied recipient is refused",
        call: pay({ resource: at("/denied"), spendingCap: cap(PER_CALL) }),
        expected: ["payment_recipient_not_permitted", "payment_no_acceptable_option"],
      },
      {
        id: "mcp-private-address",
        title: "a resource on a private or metadata address is refused before any request",
        call: pay({
          resource: `http://169.254.169.254:${String(seller.port)}/latest`,
          spendingCap: cap(PER_CALL),
        }),
        expected: ["egress_destination_not_allowed"],
      },
      {
        id: "mcp-redirect-private",
        title: "a redirect to a private address is not followed",
        call: pay({ resource: at("/redirect"), spendingCap: cap(PER_CALL) }),
        expected: ["egress_redirect_not_allowed", "egress_destination_not_allowed"],
      },
      {
        id: "mcp-request-too-large",
        title: "a request body over 64 KiB is refused before anything is sent",
        call: pay({ resource: at("/priced"), body: "x".repeat(70_000), spendingCap: cap(PER_CALL) }),
        expected: ["tool_input_invalid", "egress_request_too_large"],
      },
      {
        id: "mcp-malformed-arguments",
        title: "arguments of the wrong type are refused with the failing path",
        call: pay({ resource: 42, spendingCap: "a lot" }),
        expected: ["tool_input_invalid"],
      },
    ];

    for (const entry of cases) {
      await recorder.run(
        { id: entry.id, title: `MCP: ${entry.title}`, checks: ["mcp", "rejection-codes"] },
        async (context) => {
          const result = await client.callTool(entry.call);
          const refusal = toolRefusal(result, entry.id);
          record(context, entry.call.name, refusal);
          check(refusal, entry.expected, options.isRegistered, entry.id);
          context.observe("expectedCodes", entry.expected);
          context.observe("isError", true);
          context.observe("paid", refusal.paid);
        },
      );
    }

    // The session budget is refused only once earlier payments used it up; nothing is paid here.
    recorder.skip(
      {
        id: "mcp-session-cap",
        title: "MCP: a price above what is left of the session budget is refused",
        checks: ["mcp", "rejection-codes"],
      },
      "needs settled payments first; the live agent run refuses it through rail402-mcp after a settled payment, and the SDK's budget ledger tests prove it (packages/sdk/test/guard.test.ts)",
    );

    const protocolCases: readonly {
      id: string;
      title: string;
      request: { method: string; params: Record<string, unknown> };
      jsonRpcCode: number;
      expected: string;
    }[] = [
      {
        id: "mcp-unknown-tool",
        title: "An unknown tool is a JSON-RPC error carrying a code",
        request: { method: "tools/call", params: { name: "withdraw_everything", arguments: {} } },
        jsonRpcCode: -32602,
        expected: "tool_unknown",
      },
      {
        id: "mcp-params-invalid",
        title: "A tools/call without a tool name is a JSON-RPC error carrying a code",
        request: { method: "tools/call", params: { arguments: {} } },
        jsonRpcCode: -32602,
        expected: "rpc_params_invalid",
      },
      {
        id: "mcp-method-unknown",
        title: "A method the server does not serve is a JSON-RPC error carrying a code",
        request: { method: "rail402/withdraw", params: {} },
        jsonRpcCode: -32601,
        expected: "rpc_method_unknown",
      },
    ];
    for (const entry of protocolCases) {
      await recorder.run(
        { id: entry.id, title: `MCP: ${entry.title}`, checks: ["mcp", "rejection-codes"] },
        async (context) => {
          const error = await client.request(entry.request as never, z.object({})).then(
            (result) => {
              throw new Error(`the request answered a result: ${JSON.stringify(result).slice(0, 300)}`);
            },
            (thrown: unknown) => thrown,
          );
          const data = (error as { data?: { code?: unknown; reason?: unknown } }).data;
          const jsonRpcCode = (error as { code?: unknown }).code;
          if (jsonRpcCode !== entry.jsonRpcCode) {
            throw new Error(`JSON-RPC code ${String(jsonRpcCode)}, expected ${String(entry.jsonRpcCode)}`);
          }
          const code = typeof data?.code === "string" ? data.code : "";
          const reason = typeof data?.reason === "string" ? data.reason : "";
          context.rejection({
            surface: "mcp",
            operation: entry.request.method,
            code: code || "missing_code",
            reason: reason || "(empty)",
          });
          check(
            { code, reason, retryable: false, paid: "none" },
            [entry.expected],
            options.isRegistered,
            entry.id,
          );
          context.observe("jsonRpcCode", jsonRpcCode);
        },
      );
    }
  } finally {
    await client.close().catch(() => undefined);
    await seller.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

/** The coded error of a tool result, after checking its shape; throws if it is not a coded refusal. */
function toolRefusal(result: unknown, id: string): ToolRefusal {
  const value = result as {
    isError?: unknown;
    structuredContent?: { ok?: unknown; error?: Record<string, unknown> };
    content?: { type?: unknown; text?: unknown }[];
  };
  if (value.isError !== true)
    throw new Error(`${id}: the result is not isError: ${JSON.stringify(result).slice(0, 300)}`);
  const structured = value.structuredContent;
  if (structured?.ok !== false || structured.error === undefined) {
    throw new Error(`${id}: structuredContent is not { ok: false, error }`);
  }
  const [first] = value.content ?? [];
  if (
    first?.type !== "text" ||
    typeof first.text !== "string" ||
    !isDeepStrictEqual(JSON.parse(first.text), structured)
  ) {
    throw new Error(`${id}: content[0].text is not the structured result`);
  }
  const { code, reason, retryable, paid } = structured.error;
  if (typeof retryable !== "boolean") throw new Error(`${id}: error.retryable is not a boolean`);
  return {
    code: typeof code === "string" ? code : "",
    reason: typeof reason === "string" ? reason : "",
    retryable,
    paid: typeof paid === "string" ? paid : "",
  };
}

function record(context: CaseContext, tool: string, refusal: ToolRefusal) {
  context.rejection({
    surface: "mcp",
    operation: `tools/call ${tool}`,
    code: refusal.code || "missing_code",
    reason: refusal.reason.trim() || "(empty)",
  });
}

function check(
  refusal: ToolRefusal,
  expected: readonly string[],
  isRegistered: (code: string) => boolean,
  id: string,
) {
  if (!isRegistered(refusal.code)) throw new Error(`${id}: code "${refusal.code}" is not registered`);
  if (!expected.includes(refusal.code))
    throw new Error(`${id}: code ${refusal.code}, expected ${expected.join(" | ")}`);
  if (refusal.reason.trim() === "") throw new Error(`${id}: a refusal without a reason`);
  if (refusal.reason.length > MAX_REASON_LENGTH)
    throw new Error(`${id}: reason longer than ${String(MAX_REASON_LENGTH)}`);
  if (refusal.paid !== "none") throw new Error(`${id}: paid is ${refusal.paid}, but nothing was signed`);
}

interface ChallengeSeller {
  readonly url: string;
  readonly port: number;
  /** The recipient the MCP server's policy denies, set once the server is configured. */
  denied: string;
  close(): Promise<void>;
}

/**
 * A seller that only asks: each paid route answers an x402 v2 `402` with `PAYMENT-REQUIRED` and never
 * settles. `/redirect` points at a metadata address.
 */
async function startChallengeSeller(options: McpAuditOptions): Promise<ChallengeSeller> {
  const units = (whole: string) => {
    const [integer = "0", fraction = ""] = whole.split(".");
    return (
      BigInt(integer) * 10n ** BigInt(options.asset.decimals) +
      BigInt(fraction.padEnd(options.asset.decimals, "0") || "0")
    ).toString();
  };
  const option = (overrides: Record<string, unknown> = {}) => ({
    scheme: "exact",
    network: options.network,
    amount: units("0.04"),
    asset: options.asset.contract,
    payTo: options.payTo,
    maxTimeoutSeconds: 60,
    extra: { areFeesSponsored: true },
    ...overrides,
  });
  const state = { denied: "" };
  const routes: Record<string, () => Record<string, unknown>> = {
    "/priced": () => option(),
    "/expensive": () => option({ amount: units("0.08") }),
    "/pubnet": () => option({ network: "stellar:pubnet" }),
    "/foreign-asset": () => option({ asset: StrKey.encodeContract(randomBytes(32)) }),
    "/denied": () => option({ payTo: state.denied }),
  };
  const server: Server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://seller").pathname;
    const build = routes[path];
    if (build !== undefined) {
      const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}${path}`;
      const header = encodePaymentRequiredHeader({
        x402Version: 2,
        error: "Payment required",
        resource: { url, description: "An audited resource", mimeType: "application/json" },
        accepts: [build() as never],
      });
      response.writeHead(402, { "content-type": "application/json", "payment-required": header }).end("{}");
      return;
    }
    if (path === "/redirect") {
      response.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    port,
    get denied() {
      return state.denied;
    },
    set denied(value: string) {
      state.denied = value;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
