import {
  MemorySpendLedger,
  createBuyer,
  egressFromConfig,
  loadSigner,
  paymentError,
  type Buyer,
  type PaymentEventListener,
  type SpendLedger,
} from "@rail402.dev/sdk";
import type { CliContext } from "./config.ts";

export interface OpenedBuyer {
  readonly buyer: Buyer;
  /** The budget ledger the buyer reserves in. */
  readonly ledger: SpendLedger;
  close(): Promise<void>;
}

export interface OpenBuyerOptions {
  /** Load the configured key. Commands that only read (search, listing, tx) never do. */
  readonly signer: boolean;
  /** Refuse when no key is configured. */
  readonly requireSigner?: boolean;
  readonly onEvent?: PaymentEventListener;
}

export type OpenBuyer = (context: CliContext, options: OpenBuyerOptions) => Promise<OpenedBuyer>;

/**
 * Opens the buyer the configuration describes. A buyer with a key uses the shared SQLite budget
 * ledger (unless configured for memory), so the CLI and rail402-mcp spend from one budget per key and
 * session; a read-only buyer never opens it.
 */
export const openBuyer: OpenBuyer = async (context, options) => {
  const { agent } = context;
  if (options.requireSigner === true && agent.key === undefined) {
    throw paymentError("payment_signer_unavailable", {
      reason:
        "No signing key is configured: create one with rail402 keys new, or pass --key-file or RAIL402_SECRET_KEY_FILE.",
    });
  }
  const signer = options.signer && agent.key !== undefined ? await loadSigner(agent.key) : undefined;
  let ledger: SpendLedger;
  if (signer !== undefined && agent.budgetStore === "sqlite") {
    // Loaded on demand: node:sqlite is only needed by commands that spend.
    const { SqliteSpendLedger } = await import("@rail402.dev/sdk/sqlite");
    ledger = new SqliteSpendLedger(agent.ledgerPath);
  } else {
    ledger = new MemorySpendLedger();
  }
  try {
    const buyer = await createBuyer({
      network: agent.network,
      ...(signer === undefined ? {} : { signer }),
      rpcUrl: agent.rpcUrl,
      bazaarUrl: agent.bazaarUrl,
      policy: agent.policy,
      ledger,
      session: agent.session,
      egress: egressFromConfig(agent),
      explorer: agent.explorer,
      ...(context.facilitatorUrl === undefined ? {} : { facilitatorUrl: context.facilitatorUrl }),
      ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
    });
    return {
      buyer,
      ledger,
      close: async () => {
        await buyer.close();
        ledger.close();
      },
    };
  } catch (error) {
    ledger.close();
    throw error;
  }
};
