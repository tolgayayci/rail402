import type { Session, SessionConfig } from "./session.js";

/**
 * "Continue in your terminal" — the playground's exit ramp. Turns the current in-browser session
 * into a `.env` the user can run locally with the published `@rail402.dev/*` packages, so the flow they
 * just clicked replays on their own machine.
 *
 * The session secret is included because the whole point is to hand over the wallet. The warning
 * text below travels with it: this is a throwaway TEST-network key that never touched a server, and
 * it must not be reused for anything real.
 */

export interface TerminalExport {
  readonly env: string;
  readonly command: string;
  readonly warning: string;
}

export function buildTerminalExport(session: Session, config: SessionConfig): TerminalExport {
  const env = [
    "# Rail402 playground session — TEST NETWORK ONLY.",
    "# This key was generated in your browser and never sent to any server.",
    "# Do not fund it with real value or reuse it anywhere.",
    `STELLAR_NETWORK=${config.network}`,
    `STELLAR_SECRET=${session.secret}`,
    `STELLAR_ADDRESS=${session.address}`,
    `FACILITATOR_URL=${config.facilitatorUrl}`,
    `USDC_ASSET=${config.usdc.sac}`,
  ].join("\n");

  const command = "npx @rail402.dev/agent-helpers pay $DEMO_URL --budget 0.10";

  const warning =
    "This is a testnet key. It holds only test USDC and test XLM, it never left your browser until now, and it must never be reused for real funds.";

  return { env, command, warning };
}
