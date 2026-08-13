import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { x402Client } from "@x402/core/client";
import { wrapMCPClientWithPayment } from "@x402/mcp";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { UptoStellarClientScheme } from "@rail402/scheme-upto-stellar";
import {
  budgetSelector,
  selectPayable,
  fail,
  isPayableResourceUrl,
  succeed,
  type BudgetExceededError,
  type PricedOption,
  type ToolResult,
} from "./tools.js";

/**
 * Paying for an **MCP tool**, as opposed to an HTTP endpoint.
 *
 * The Bazaar catalogs MCP tools as first-class resources — keyed on the tuple
 * (`resource.url`, `input.toolName`), because one endpoint multiplexes many tools — and `pay_and_call`
 * accepted a `toolName` from the day the schema was written. It never used it: every call went out as
 * an HTTP request, so an agent that found an MCP tool through search could not actually call it. This
 * closes that half of the loop.
 *
 * ## Built on `@x402/mcp`, not on our own framing
 *
 * x402-over-MCP is a real transport with real details: the challenge comes back as a JSON-RPC error
 * carrying `PaymentRequired` in `error.data` (under SEP-1036's `-32042`, because that is the only
 * custom code the MCP SDK propagates with `data` intact), the payload travels in
 * `params._meta["x402/payment"]`, and the settlement response comes back in
 * `result._meta["x402/payment-response"]`. Hand-rolling any of that would guarantee eventual
 * divergence from every other implementation, which is precisely the interop failure this project
 * exists to avoid. `@x402/mcp` is Apache-2.0 and pins `@x402/core ~2.20.0`, the
 * version everything else here is on, so it introduces no second copy of the core client.
 *
 * ## The spend cap binds in exactly the same place
 *
 * `wrapMCPClientWithPayment` takes an `x402Client`, and our budget-enforcing
 * `paymentRequirementsSelector` lives on that client — so the ceiling is re-applied to the challenge
 * the *server actually sent*, immediately before the payload is created. Nothing is signed if it does
 * not fit. This is the same enforcement point as the HTTP path, and it has to be: a budget checked
 * anywhere earlier is a budget checked against a quote nobody has to honour
 *
 * One difference from HTTP, in our favour: there is no unpaid probe here. The 402 arrives as an error
 * on the *first* call and the wrapper retries with payment, so the price an agent is told it declined
 * is the price it was actually quoted, with no second request in between that could disagree.
 */

export interface McpCallResult {
  transport: "mcp";
  toolName: string;
  /** The tool's content blocks, forwarded from the MCP SDK unchanged. */
  body: unknown;
  /** The tool reported a domain-level failure. The call itself, and any payment, still succeeded. */
  isError: boolean;
  paid: { amount: string; asset: string; network: string; transaction?: string } | undefined;
}

export interface McpCallOptions {
  readonly resource: string;
  readonly toolName: string;
  readonly toolArguments?: Record<string, unknown> | undefined;
  readonly budget: string;
  readonly network?: string | undefined;
  readonly stellarSecret: string;
  readonly allowPrivateHosts: boolean;
}

/** MCP tool calls can be slow (a model behind them, often). Bounded so a hung server is not forever. */
const CALL_TIMEOUT_MS = 120_000;

export async function callMcpTool(options: McpCallOptions): Promise<ToolResult<McpCallResult>> {
  // Same gate as the HTTP path, for the same reason: this is a caller-supplied URL that we connect to
  // and whose response we hand back, so the decision about where we are willing to send a request has
  // to happen before any request.
  if (!isPayableResourceUrl(options.resource, options.allowPrivateHosts)) {
    return fail("mcp_resource_host_refused", { details: { resource: options.resource } });
  }

  let endpoint: URL;
  try {
    endpoint = new URL(options.resource);
  } catch {
    return fail("mcp_resource_not_payable", {
      reason: `"${options.resource}" is not a valid URL, so there is no MCP endpoint to connect to.`,
    });
  }

  // Captured as the selector raises it, never recovered from the thrown error. The wrapper layers
  // rethrow without `cause` and without the class, so reconstructing the refusal downstream loses
  // both the refused price and the real budget — which is how a numeric field once published the
  // string "the configured maximum".
  let refusal: BudgetExceededError | undefined;
  /** The challenge the server sent, so a refusal can name the real price rather than guess it. */
  let quoted: PricedOption | undefined;

  const mcpClient = new Client({ name: "x402-stellar-discovery", version: "0.1.0" });
  let connected = false;

  try {
    const signer = createEd25519Signer(
      options.stellarSecret,
      (options.network ?? "stellar:testnet") as `${string}:${string}`,
    );
    const paymentClient = new x402Client(
      budgetSelector(options.budget, options.network, r => {
        refusal = r;
      }) as ConstructorParameters<typeof x402Client>[0],
    );
    paymentClient.register("stellar:*", new ExactStellarScheme(signer));
    // Register `upto` too, so an agent can pay an `upto` resource over the MCP transport.
    paymentClient.register("stellar:*", new UptoStellarClientScheme(signer));

    const paidClient = wrapMCPClientWithPayment(mcpClient, paymentClient, {
      autoPayment: true,
      onPaymentRequested: context => {
        // Record what the SELECTOR would choose, not merely the first Stellar option on offer.
        //
        // `selectPayable` picks the CHEAPEST affordable option; taking `accepts.find(...)` here
        // instead reported the first one, so a seller offering [expensive, cheap] would be paid
        // `cheap` while the agent was told it paid `expensive`. An agent reconciling spend against
        // its own ledger would over-count, and the number is about money.
        const { chosen } = selectPayable(
          (context.paymentRequired?.accepts ?? []) as PricedOption[],
          options.budget,
          options.network,
        );
        quoted = chosen;
        return true;
      },
    });

    // The cast is narrow and it is upstream's, not ours. `Transport` declares `sessionId?: string`,
    // while `StreamableHTTPClientTransport` exposes it as a getter returning `string | undefined` —
    // and a getter cannot be an absent property, so the two cannot both be right under
    // `exactOptionalPropertyTypes`. Nothing about the runtime value is in question; only the
    // declaration is. Filed as an interop question rather than fixed by relaxing the
    // compiler flag for the whole package, which would hide real optionality bugs in our own code.
    await mcpClient.connect(new StreamableHTTPClientTransport(endpoint) as unknown as Transport);
    connected = true;

    const result = await paidClient.callTool(options.toolName, options.toolArguments ?? {}, {
      timeout: CALL_TIMEOUT_MS,
    });

    const settlement = result.paymentResponse;
    const chosen = quoted;
    return succeed({
      transport: "mcp",
      toolName: options.toolName,
      body: result.content,
      isError: result.isError === true,
      paid:
        result.paymentMade && chosen
          ? {
              amount: chosen.amount,
              asset: chosen.asset,
              network: chosen.network,
              ...(typeof settlement?.transaction === "string" && settlement.transaction.length > 0
                ? { transaction: settlement.transaction }
                : {}),
            }
          : undefined,
    });
  } catch (error) {
    if (refusal) {
      return fail("mcp_budget_exceeded", {
        reason: `${refusal.message} No payment was made and the tool was not called.`,
        details: {
          ...(refusal.cheapest
            ? {
                price: refusal.cheapest.amount,
                asset: refusal.cheapest.asset,
                network: refusal.cheapest.network,
              }
            : {}),
          maxAmount: refusal.budget,
          toolName: options.toolName,
        },
      });
    }
    return fail("mcp_upstream_error", {
      reason: `Calling MCP tool "${options.toolName}" at ${options.resource} failed: ${
        error instanceof Error ? error.message : "unknown error"
      }.`,
      details: { resource: options.resource, toolName: options.toolName },
    });
  } finally {
    // Always tear the transport down. A leaked streamable-HTTP session holds a socket open on the
    // seller's server, and an agent runtime makes many of these.
    if (connected) await mcpClient.close().catch(() => undefined);
  }
}
