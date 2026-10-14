/** Where the browser tests' stack listens (e2e/stack.ts), and what it reports about itself. */

function port(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0 || value > 65_535) throw new Error(`${name} is not a port`);
  return value;
}

/** The Playground server, serving the production build. */
export const E2E_PORT = port("PLAYGROUND_E2E_PORT", 18791);
/** The stack's control server. */
export const E2E_CONTROL_PORT = port("PLAYGROUND_E2E_CONTROL_PORT", 18792);

export const E2E_ORIGIN = `http://127.0.0.1:${String(E2E_PORT)}`;
export const E2E_CONTROL = `http://127.0.0.1:${String(E2E_CONTROL_PORT)}`;

export interface StackInfo {
  readonly publicUrl: string;
  readonly rpcUrl: string;
  readonly friendbotUrl: string;
  readonly rail402Url: string;
  /** The facilitator's fee sponsor. */
  readonly sponsor: string;
  readonly demoSeller: { readonly url: string; readonly payTo: string };
  readonly labPayTo: string;
  /** The USDC contract and its issuer. */
  readonly asset: string;
  readonly assetIssuer: string;
  /** The upto settlement contract. */
  readonly uptoContract: string;
  /** A seller that redirects every call to the decoy origin. */
  readonly redirectorUrl: string;
}
