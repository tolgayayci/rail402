import { AsyncLocalStorage } from "node:async_hooks";
import { paymentError, type ConfirmPolicy, type ConfirmSigning } from "@rail402.dev/sdk";
import {
  ConfirmationRequired,
  covers,
  type ConfirmationScope,
  type ToolCallContext,
} from "./confirmation.ts";

/** The confirmation wiring of one rail402-mcp process: the buyer's confirm function and its scope. */
export interface McpConfirmation extends ConfirmationScope {
  readonly policy: ConfirmPolicy;
  /** For `createBuyer`; undefined when the policy never asks. */
  readonly confirm: ConfirmSigning | undefined;
}

/**
 * Builds the confirm function the buyer calls before signing. Within a tool call it approves a
 * payment the client already confirmed for this call, refuses one the client declined, and otherwise
 * asks the client (`ConfirmationRequired`), or refuses with `payment_confirmation_unavailable` when
 * the client cannot be asked. Outside a tool call nothing is approved.
 */
export function createMcpConfirmation(policy: ConfirmPolicy): McpConfirmation {
  const storage = new AsyncLocalStorage<ToolCallContext>();
  const confirm: ConfirmSigning = (intent) => {
    const context = storage.getStore();
    const answer = context?.answer;
    if (answer !== undefined && covers(answer.intent, intent)) return answer.approved;
    if (answer !== undefined && !answer.approved) return false;
    if (context?.canElicit !== true) {
      throw paymentError("payment_confirmation_unavailable", {
        reason:
          "This payment needs the user's confirmation, and the MCP client cannot show one (no form elicitation support). Use a client that supports elicitation, or set RAIL402_MCP_CONFIRM=never for a headless agent that its caps alone bound.",
        callId: intent.callId,
      });
    }
    throw new ConfirmationRequired(intent);
  };
  return {
    policy,
    confirm: policy === "never" ? undefined : confirm,
    run: (context, body) => storage.run(context ?? { canElicit: false }, body),
  };
}
