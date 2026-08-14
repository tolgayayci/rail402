/**
 * `@rail402/playground/browser` — the browser-safe helper library the playground UI is built on.
 *
 * Everything exported here runs in a browser bundle: keys are generated and payments signed in the
 * tab, over `fetch` to CORS-open endpoints (friendbot, Horizon, Soroban RPC) and the playground's
 * own same-origin API. There are no node built-ins in this module's import graph.
 *
 * The frontend never talks to the x402 SDKs directly — it drives these functions, each of which
 * emits step events the UI renders as the glass timeline.
 */

export {
  createSession,
  bootstrapSession,
  fetchBalances,
  type Session,
  type SessionConfig,
  type Balances,
  type BootstrapStep,
  type BootstrapPhase,
} from "./session.js";

export {
  payExact,
  type PayExactOptions,
  type PayExactResult,
  type PaymentStep,
  type PaymentPhase,
} from "./pay.js";

export {
  openMeterTab,
  callMeter,
  closeMeter,
  type OpenTabOptions,
  type OpenTab,
  type MeterCall,
  type MeterClose,
  type MeterOpenStep,
  type MeterOpenPhase,
} from "./meter.js";

export {
  ATTACKS,
  runAttack,
  type Attack,
  type AttackRequest,
  type AttackOutcome,
} from "./attacks.js";

export {
  searchBazaar,
  type BazaarResource,
  type SearchResult,
} from "./bazaar.js";

export { buildTerminalExport, type TerminalExport } from "./export.js";

export {
  decimalToStroops,
  stroopsToDecimal,
  stroopsToDisplay,
  txUrl,
  accountUrl,
  contractUrl,
  truncate,
} from "./format.js";
