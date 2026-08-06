import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { x402Client } from "@x402/core/client";
import { wrapMCPClientWithPayment } from "@x402/mcp";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";

/**
 * The seller's first customer — somebody who already knows the endpoint.
 *
 * Cataloging is settlement-gated, so a listing does not exist until a payment for it settles. This
 * script is that first payment: it is what turns the tool from "running" into "discoverable", with
 * no registration step anywhere. The agent in `agent.ts` then finds it having never been told it
 * exists.
 *
 * It is also the shortest honest answer to "what does an MCP buyer have to write?" — a stock MCP
 * `Client`, a stock `x402Client` holding a Stellar signer, and `wrapMCPClientWithPayment` between
 * them. Nothing here is ours; the discover→pay convenience is what our MCP server adds on top.
 */

const ENDPOINT = process.env.MCP_ENDPOINT ?? "http://localhost:4024/mcp";
const TOOL = process.env.MCP_TOOL ?? "harbour_tides";
const SECRET = process.env.CLIENT_STELLAR_PRIVATE_KEY;
const NETWORK = (process.env.STELLAR_NETWORK ?? "stellar:testnet") as `${string}:${string}`;

if (!SECRET) {
  console.error("CLIENT_STELLAR_PRIVATE_KEY is required");
  process.exit(1);
}

const paymentClient = new x402Client();
paymentClient.register("stellar:*", new ExactStellarScheme(createEd25519Signer(SECRET, NETWORK)));

const mcpClient = new Client({ name: "first-buyer", version: "0.1.0" });
const paid = wrapMCPClientWithPayment(mcpClient, paymentClient, {
  autoPayment: true,
  onPaymentRequested: context => {
    const offer = context.paymentRequired?.accepts?.[0];
    console.log(`[first-buyer] 402 for ${context.toolName}: ${offer?.amount} on ${offer?.network}`);
    return true;
  },
});

// The SDK's `Transport` declares `sessionId?: string` while this transport exposes it as a getter
// returning `string | undefined`; under `exactOptionalPropertyTypes` those are different types.
// Upstream's declaration mismatch, not a runtime question.
await mcpClient.connect(
  new StreamableHTTPClientTransport(new URL(ENDPOINT)) as unknown as Parameters<
    typeof mcpClient.connect
  >[0],
);

const result = await paid.callTool(TOOL, { harbour: "Dover" });

console.log(`[first-buyer] paid: ${result.paymentMade}`);
console.log(`[first-buyer] tx:   ${result.paymentResponse?.transaction ?? "(none)"}`);
console.log(`[first-buyer] out:  ${JSON.stringify(result.content)}`);
console.log(`[first-buyer] the tool is now in the Bazaar — nobody registered it`);

await mcpClient.close();
