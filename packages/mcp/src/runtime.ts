import type { McpServerFactory } from "@modelcontextprotocol/server";
import {
  MemorySpendLedger,
  createBuyer,
  egressFromConfig,
  loadSigner,
  type AgentConfig,
  type Buyer,
  type SpendLedger,
} from "@rail402.dev/sdk";
import { SqliteSpendLedger } from "@rail402.dev/sdk/sqlite";
import type { McpConfirmation } from "./confirm-scope.ts";
import type { ConfirmationScope } from "./confirmation.ts";
import { silentLogger, type Logger } from "./logger.ts";
import { createServerFactory } from "./server.ts";
import { createTools, type ToolBuyer, type ToolLimits, type Tools } from "./tools.ts";

export interface Rail402Mcp {
  readonly tools: Tools;
  /** Builds one MCP server instance; give it to a serving entry. */
  readonly factory: McpServerFactory;
}

export interface Rail402McpOptions {
  readonly buyer: ToolBuyer;
  readonly limits?: ToolLimits;
  readonly logger?: Logger;
  /** The confirmation scope paid calls run in (`createMcpConfirmation`). */
  readonly confirmation?: ConfirmationScope;
}

/** The rail402-mcp tools over a buyer, and a factory of MCP servers exposing them. */
export function createRail402Mcp(options: Rail402McpOptions): Rail402Mcp {
  const tools = createTools({
    buyer: options.buyer,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.confirmation === undefined ? {} : { confirmation: options.confirmation }),
  });
  return { tools, factory: createServerFactory(tools) };
}

export interface ConfiguredBuyer {
  readonly buyer: Buyer;
  close(): Promise<void>;
}

/**
 * Opens the buyer a configuration describes: its key (a seed taken from the environment never shows
 * when the configuration is printed; a key file's network tag must fit the network), budget ledger,
 * spending policy, egress policy and payment confirmation. Without `confirmation` the SDK decides: a
 * testnet buyer asks nothing, and a pubnet buyer with a key refuses to open (`payment_policy_invalid`)
 * until it is given one, e.g. `createMcpConfirmation("never")` for a headless agent. Payment events are
 * logged at debug level; they carry no secrets or payloads.
 */
export async function openConfiguredBuyer(
  config: AgentConfig,
  logger: Logger = silentLogger,
  confirmation?: Pick<McpConfirmation, "policy" | "confirm">,
): Promise<ConfiguredBuyer> {
  const signer =
    config.key === undefined
      ? undefined
      : await loadSigner(config.key, { network: config.network, allowUntagged: config.allowUntaggedKey });
  const ledger: SpendLedger =
    config.budgetStore === "sqlite" && signer !== undefined
      ? new SqliteSpendLedger(config.ledgerPath)
      : new MemorySpendLedger();
  try {
    const buyer = await createBuyer({
      network: config.network,
      ...(signer === undefined ? {} : { signer }),
      rpcUrl: config.rpcUrl,
      bazaarUrl: config.bazaarUrl,
      policy: config.policy,
      ledger,
      session: config.session,
      egress: egressFromConfig(config),
      explorer: config.explorer,
      // No default: on pubnet a buyer with a key must be given a confirmation choice, or it refuses.
      ...(confirmation === undefined ? {} : { confirmPolicy: confirmation.policy }),
      ...(confirmation?.confirm === undefined ? {} : { confirm: confirmation.confirm }),
      onEvent: (event) => {
        logger.debug("payment event", { ...event });
      },
    });
    return {
      buyer,
      close: async () => {
        await buyer.close();
        ledger.close();
      },
    };
  } catch (error) {
    ledger.close();
    throw error;
  }
}
