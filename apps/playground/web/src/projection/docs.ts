/**
 * Documentation links the page shows. Rail402 pages are paths on the configured docs site (a test
 * maps each one to a page in the repository's `docs/`); x402 pages are absolute.
 */

export interface DocRef {
  readonly label: string;
  /** A path on the Rail402 docs site (`/reference/spending-policy`) or an absolute https URL. */
  readonly path: string;
}

export const DOCS = Object.freeze({
  x402: { label: "How x402 works", path: "https://docs.x402.org" },
  x402Headers: { label: "x402 headers", path: "https://docs.x402.org" },
  architecture: { label: "Payment requirements", path: "/architecture/overview" },
  feeSponsorship: { label: "Fee sponsorship", path: "/architecture/overview" },
  facilitator: { label: "Facilitator", path: "/architecture/overview" },
  verificationRules: { label: "Verification rules", path: "/verification-rules" },
  authorization: { label: "Authorization entries", path: "/verification-rules" },
  idempotency: { label: "Idempotency", path: "/verification-rules" },
  spendingPolicy: { label: "Spending caps", path: "/reference/spending-policy" },
  agentLimits: { label: "Agent limits", path: "/reference/spending-policy" },
  errorCodes: { label: "Error codes", path: "/reference/error-codes" },
  egress: { label: "Safe URLs", path: "/reference/egress" },
  upto: { label: "The upto scheme", path: "/facilitator/upto" },
  uptoContract: { label: "upto contract", path: "/reference/upto-contract" },
  receipts: { label: "Receipts", path: "/agents/sdk" },
  cli: { label: "CLI", path: "/agents/cli" },
  walletCli: { label: "Fund and manage wallets with the CLI", path: "/agents/cli" },
  mcpServer: { label: "MCP server", path: "/agents/mcp-server" },
  meteredPricing: { label: "Metered pricing", path: "/sellers/helpers" },
  sellerQuickstart: { label: "Seller quickstart", path: "/quickstart/sellers" },
  sellerInstall: { label: "Install guide", path: "/sellers/helpers" },
  sellHttpRoute: { label: "Seller helpers", path: "/sellers/helpers#an-http-route" },
  sellMcpTool: { label: "Sell an MCP tool", path: "/sellers/helpers#an-mcp-tool" },
  sellUpto: { label: "Charge per use with upto", path: "/sellers/helpers#charge-what-a-call-used-upto" },
  cataloging: { label: "How cataloging works", path: "/bazaar/cataloging" },
  listing: { label: "How listing works", path: "/bazaar/cataloging" },
  listingTrust: { label: "Listing trust", path: "/bazaar/cataloging" },
  search: { label: "Bazaar search", path: "/bazaar/search" },
} satisfies Record<string, DocRef>);

/** The link for a doc reference on the configured docs site. */
export function docHref(doc: DocRef, docsUrl: string): string {
  if (/^https:\/\//.test(doc.path)) return doc.path;
  return `${docsUrl.replace(/\/+$/, "")}${doc.path}`;
}
