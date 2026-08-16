import {
  searchBazaar,
  payAndFetch,
  discoverAndPay,
  type AgentConfig,
  type SearchOptions,
  type PayOptions,
  type BazaarResource,
  type PaidResponse,
} from "@rail402.dev/agent-helpers";
import { createError, type ErrorCode } from "@rail402.dev/errors";
import type { CliConfig, ConfigKey } from "./config.js";
import { configFilePath, isConfigKey, saveConfigValue } from "./config.js";
import { ok, err, redactSecret, type CmdResult, type CmdError } from "./format.js";
import { toAtomic, toDecimal } from "./amounts.js";
import {
  addressFromSecret,
  generateKeypair,
  friendbotFund,
  getBalances,
  type Balance,
} from "./stellar.js";
import { fetchTx, fetchFeed, fetchSupported } from "./explorer.js";

export interface Ctx {
  config: CliConfig;
  fetchImpl: typeof fetch;
}

function toCmdError(code: ErrorCode, reason?: string, details?: Record<string, unknown>): CmdError {
  const e = createError(code, { ...(reason ? { reason } : {}), ...(details ? { details } : {}) });
  return {
    code: e.code,
    reason: e.reason,
    retryable: e.retryable,
    ...(e.details === undefined ? {} : { details: e.details as Record<string, unknown> }),
  };
}

function upstreamError(status: number, what: string, url: string, flag: string): CmdError {
  if (status === 0) {
    return toCmdError(
      "mcp_upstream_error",
      `Could not reach ${what} at ${url} (network error). Check the URL or pass ${flag}.`,
    );
  }
  return toCmdError("mcp_upstream_error", `${what} returned HTTP ${status}.`, { status });
}

function buildAgentConfig(config: CliConfig): AgentConfig {
  return {
    bazaarUrl: config.facilitatorUrl,
    network: config.network,
    ...(config.secret ? { stellarSecret: config.secret } : {}),
  };
}

function priceLabel(price: BazaarResource["price"]): string {
  if (!price) return "(no Stellar price)";
  const amount = price.amountDecimal ?? toDecimal(price.amount);
  const asset = price.assetIdentity?.code ?? shortAddress(price.asset);
  const sponsored = price.feesSponsored ? ", fees sponsored" : "";
  return `${amount} ${asset}${sponsored}`;
}

function shortAddress(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

// ── fund ──────────────────────────────────────────────────────────────────────

export async function cmdFund(ctx: Ctx): Promise<CmdResult> {
  const net = ctx.config.network;
  let address: string;
  let secret: string | undefined;
  let generated = false;

  if (ctx.config.secret) {
    try {
      address = addressFromSecret(ctx.config.secret);
    } catch (e) {
      return err(toCmdError("config_invalid_value", (e as Error).message));
    }
  } else {
    if (net !== "stellar:testnet") {
      return err(
        toCmdError(
          "config_no_signer",
          `No secret configured and auto-generation is testnet-only (network is ${net}). Pass --secret.`,
        ),
      );
    }
    const kp = generateKeypair();
    address = kp.publicKey;
    secret = kp.secret;
    generated = true;
  }

  if (net !== "stellar:testnet") {
    return err(
      toCmdError(
        "config_invalid_value",
        `friendbot funding is testnet-only (network is ${net}). Fund ${address} yourself.`,
      ),
    );
  }

  try {
    await friendbotFund(address, ctx.fetchImpl);
  } catch (e) {
    return err(toCmdError("mcp_upstream_error", `friendbot funding failed: ${(e as Error).message}`));
  }

  let balances: Balance[] = [];
  try {
    balances = await getBalances(address, net, ctx.fetchImpl);
  } catch {
    // Balance read is best-effort; funding already succeeded.
  }

  const data = {
    address,
    network: net,
    funded: true,
    generated,
    ...(generated && secret ? { secret } : {}),
    balances,
  };
  const lines: string[] = [`✓ funded ${address} on ${net}`];
  if (generated && secret) {
    lines.push(
      "",
      `  secret: ${secret}`,
      "  ⚠ ephemeral testnet key — save it, or set it for future commands:",
      `      export RAIL402_SECRET=${secret}`,
      `      (or: rail402 config set secret ${secret})`,
    );
  }
  lines.push("", "  balances:", ...balances.map(b => `    ${b.balance} ${b.asset}`));
  lines.push(
    "",
    "  Note: friendbot funds XLM. Testnet USDC comes from the Circle faucet:",
    "      https://faucet.circle.com  (select Stellar testnet)",
  );
  return ok(data, lines);
}

// ── whoami ────────────────────────────────────────────────────────────────────

export async function cmdWhoami(ctx: Ctx): Promise<CmdResult> {
  if (!ctx.config.secret) {
    return err(
      toCmdError(
        "config_no_signer",
        "No secret configured. Set RAIL402_SECRET, pass --secret, or run `rail402 fund`.",
      ),
    );
  }
  let address: string;
  try {
    address = addressFromSecret(ctx.config.secret);
  } catch (e) {
    return err(toCmdError("config_invalid_value", (e as Error).message));
  }
  let balances: Balance[] = [];
  try {
    balances = await getBalances(address, ctx.config.network, ctx.fetchImpl);
  } catch (e) {
    return err(toCmdError("mcp_upstream_error", (e as Error).message));
  }
  const funded = balances.length > 0;
  const data = { address, network: ctx.config.network, funded, balances };
  const lines = [
    `address: ${address}`,
    `network: ${ctx.config.network}`,
    funded ? "balances:" : "balances: (account not funded — run `rail402 fund`)",
    ...balances.map(b => `  ${b.balance} ${b.asset}`),
  ];
  return ok(data, lines);
}

// ── search ────────────────────────────────────────────────────────────────────

export async function cmdSearch(
  ctx: Ctx,
  opts: { query: string; max?: string; type?: "http" | "mcp"; limit?: number },
): Promise<CmdResult> {
  if (!opts.query) {
    return err(toCmdError("mcp_invalid_input", 'search needs a query, e.g. rail402 search "summarize a url"'));
  }
  const searchOptions: SearchOptions = {};
  if (opts.type) searchOptions.type = opts.type;
  if (opts.limit) searchOptions.limit = opts.limit;
  if (opts.max) {
    try {
      searchOptions.maxPrice = toAtomic(opts.max);
    } catch (e) {
      return err(toCmdError("config_invalid_value", (e as Error).message));
    }
  }
  const result = await searchBazaar(buildAgentConfig(ctx.config), opts.query, searchOptions, ctx.fetchImpl);
  if (!result.ok) return err(result.error as CmdError);

  const resources = result.data ?? [];
  const data = { query: opts.query, count: resources.length, resources };
  const lines =
    resources.length === 0
      ? [`No Stellar resources matched "${opts.query}".`]
      : resources.flatMap((r, i) => [
          `${i + 1}. ${r.serviceName ?? r.resource}`,
          `   ${priceLabel(r.price)}`,
          ...(r.description ? [`   ${r.description}`] : []),
          `   ${r.type === "mcp" ? `mcp tool: ${r.toolName ?? "?"}` : r.resource}`,
        ]);
  return ok(data, lines);
}

// ── pay ───────────────────────────────────────────────────────────────────────

export async function cmdPay(
  ctx: Ctx,
  opts: { url: string; max?: string; method?: string; query?: Record<string, string> },
): Promise<CmdResult> {
  if (!opts.url) {
    return err(toCmdError("mcp_invalid_input", "pay needs a URL: rail402 pay <url> --max 0.10"));
  }
  if (!opts.max) {
    return err(toCmdError("mcp_budget_required", "pay needs a spend cap: --max <amount> (e.g. --max 0.10)"));
  }
  if (!ctx.config.secret) {
    return err(
      toCmdError(
        "config_no_signer",
        "No secret configured. Set RAIL402_SECRET, pass --secret, or run `rail402 fund`.",
      ),
    );
  }
  let maxAmount: string;
  try {
    maxAmount = toAtomic(opts.max);
  } catch (e) {
    return err(toCmdError("config_invalid_value", (e as Error).message));
  }
  const payOptions: PayOptions = {
    maxAmount,
    ...(opts.method ? { method: opts.method } : {}),
    ...(opts.query ? { queryParams: opts.query } : {}),
  };
  const result = await payAndFetch(buildAgentConfig(ctx.config), opts.url, payOptions, ctx.fetchImpl);
  if (!result.ok) return err(result.error as CmdError);
  return renderPaid(ctx, result.data as PaidResponse, { resource: opts.url });
}

// ── buy (discover + pay) ────────────────────────────────────────────────────────

export async function cmdBuy(
  ctx: Ctx,
  opts: { query: string; max?: string; type?: "http" | "mcp" },
): Promise<CmdResult> {
  if (!opts.query) {
    return err(toCmdError("mcp_invalid_input", 'buy needs a query: rail402 buy "summarize a url" --max 0.10'));
  }
  if (!opts.max) {
    return err(toCmdError("mcp_budget_required", "buy needs a spend cap: --max <amount> (e.g. --max 0.10)"));
  }
  if (!ctx.config.secret) {
    return err(
      toCmdError(
        "config_no_signer",
        "No secret configured. Set RAIL402_SECRET, pass --secret, or run `rail402 fund`.",
      ),
    );
  }
  let maxAmount: string;
  try {
    maxAmount = toAtomic(opts.max);
  } catch (e) {
    return err(toCmdError("config_invalid_value", (e as Error).message));
  }
  const options: PayOptions & SearchOptions = { maxAmount, ...(opts.type ? { type: opts.type } : {}) };
  const result = await discoverAndPay(buildAgentConfig(ctx.config), opts.query, options, ctx.fetchImpl);
  if (!result.ok) return err(result.error as CmdError);
  const paid = result.data as PaidResponse & { discovered: BazaarResource };
  return renderPaid(ctx, paid, {
    resource: paid.discovered.serviceName ?? paid.discovered.resource,
    discovered: paid.discovered,
  });
}

function renderPaid(
  ctx: Ctx,
  paid: PaidResponse,
  meta: { resource: string; discovered?: BazaarResource },
): CmdResult {
  const tx = paid.paid?.transaction;
  const link = tx ? `${ctx.config.explorerWebUrl}/tx/${tx}` : undefined;
  const data = {
    resource: meta.resource,
    status: paid.status,
    paid: paid.paid ?? null,
    ...(link ? { explorer: link } : {}),
    ...(meta.discovered ? { discovered: meta.discovered } : {}),
    body: paid.body,
  };
  const lines: string[] = [];
  if (paid.paid) {
    lines.push(`✓ paid ${meta.resource}`);
    lines.push(`  amount: ${toDecimal(paid.paid.amount)} (${shortAddress(paid.paid.asset)})`);
    if (tx) lines.push(`  tx: ${tx}`, `  open: ${link}`);
    lines.push(`  status: ${paid.status}`);
  } else {
    lines.push(
      `→ ${meta.resource} responded ${paid.status} without requiring payment (nothing was charged)`,
    );
  }
  return ok(data, lines);
}

// ── tx ────────────────────────────────────────────────────────────────────────

export async function cmdTx(ctx: Ctx, opts: { hash: string }): Promise<CmdResult> {
  if (!opts.hash) {
    return err(toCmdError("mcp_invalid_input", "tx needs a transaction hash: rail402 tx <hash>"));
  }
  const res = await fetchTx(ctx.config.explorerUrl, opts.hash, ctx.fetchImpl);
  if (res.status === 404) {
    return err(
      toCmdError("mcp_resource_not_found", `No x402 payment indexed for tx ${opts.hash}.`, {
        hash: opts.hash,
      }),
    );
  }
  if (!res.ok) {
    return err(upstreamError(res.status, "the explorer", ctx.config.explorerUrl, "--explorer <url>"));
  }
  const link = `${ctx.config.explorerWebUrl}/tx/${opts.hash}`;
  const body = res.body as { payments?: Array<Record<string, unknown>> };
  const data = { ...(body as object), explorer: link };
  const payments = body.payments ?? [];
  const lines = [
    `tx ${opts.hash}`,
    `  payments: ${payments.length}`,
    ...payments.map((p, i) => {
      const amount = (p.amountDecimal as string) ?? (p.amount as string) ?? "?";
      const asset = (p.assetCode as string) ?? "";
      return `    ${i + 1}. ${p.scheme ?? "?"}  ${amount} ${asset}  ${p.confidence ?? ""}`.trimEnd();
    }),
    "",
    `  open: ${link}`,
  ];
  return ok(data, lines);
}

// ── feed ──────────────────────────────────────────────────────────────────────

export async function cmdFeed(
  ctx: Ctx,
  opts: { limit?: number; seller?: string; scheme?: string },
): Promise<CmdResult> {
  const res = await fetchFeed(
    ctx.config.explorerUrl,
    { limit: opts.limit ?? 10, ...(opts.seller ? { seller: opts.seller } : {}), ...(opts.scheme ? { scheme: opts.scheme } : {}) },
    ctx.fetchImpl,
  );
  if (!res.ok) {
    return err(upstreamError(res.status, "the explorer", ctx.config.explorerUrl, "--explorer <url>"));
  }
  const body = res.body as { items?: Array<Record<string, unknown>> };
  const items = body.items ?? [];
  const data = { count: items.length, payments: items };
  const lines =
    items.length === 0
      ? ["No payments in the feed."]
      : items.map((p, i) => {
          const amount = (p.amountDecimal as string) ?? (p.amount as string) ?? "?";
          const asset = (p.assetCode as string) ?? "";
          const hash = ((p.txHash as string) ?? "").slice(0, 12);
          const confidence = (p.confidence as string) ?? "";
          return `${i + 1}. ${p.scheme ?? "?"}  ${amount} ${asset}  ${hash}…  ${confidence}`.trimEnd();
        });
  return ok(data, lines);
}

// ── supported ──────────────────────────────────────────────────────────────────

export async function cmdSupported(ctx: Ctx): Promise<CmdResult> {
  const res = await fetchSupported(ctx.config.facilitatorUrl, ctx.fetchImpl);
  if (!res.ok) {
    return err(upstreamError(res.status, "the facilitator", ctx.config.facilitatorUrl, "--facilitator <url>"));
  }
  const body = res.body as { kinds?: Array<Record<string, unknown>>; extensions?: string[] };
  const kinds = body.kinds ?? [];
  const data = { facilitator: ctx.config.facilitatorUrl, ...(body as object) };
  const lines = [
    `facilitator: ${ctx.config.facilitatorUrl}`,
    "supported:",
    ...kinds.map(k => {
      const extra = k.extra as { areFeesSponsored?: boolean } | undefined;
      const sponsored = extra?.areFeesSponsored ? " (fees sponsored)" : "";
      return `  ${k.scheme} on ${k.network}${sponsored}`;
    }),
    ...(body.extensions?.length ? [`extensions: ${body.extensions.join(", ")}`] : []),
  ];
  return ok(data, lines);
}

// ── config ─────────────────────────────────────────────────────────────────────

export function cmdConfig(
  ctx: Ctx,
  opts: { action: "show" | "set" | "path"; key?: string; value?: string },
): CmdResult {
  if (opts.action === "path") {
    const path = configFilePath();
    return ok({ path }, [path]);
  }
  if (opts.action === "set") {
    if (!opts.key || !opts.value) {
      return err(toCmdError("mcp_invalid_input", "usage: rail402 config set <key> <value>"));
    }
    if (!isConfigKey(opts.key)) {
      return err(
        toCmdError(
          "config_invalid_value",
          `unknown config key "${opts.key}". Valid keys: facilitatorUrl, explorerUrl, explorerWebUrl, network, secret.`,
        ),
      );
    }
    const path = saveConfigValue(opts.key as ConfigKey, opts.value);
    return ok({ set: opts.key, path }, [`✓ set ${opts.key} → written to ${path}`]);
  }
  // show
  const shown = {
    facilitatorUrl: ctx.config.facilitatorUrl,
    explorerUrl: ctx.config.explorerUrl,
    explorerWebUrl: ctx.config.explorerWebUrl,
    network: ctx.config.network,
    secret: redactSecret(ctx.config.secret),
    configFile: configFilePath(),
  };
  const lines = [
    `facilitatorUrl: ${shown.facilitatorUrl}`,
    `explorerUrl:    ${shown.explorerUrl}`,
    `explorerWebUrl: ${shown.explorerWebUrl}`,
    `network:        ${shown.network}`,
    `secret:         ${shown.secret}`,
    `configFile:     ${shown.configFile}`,
  ];
  return ok(shown, lines);
}
