# @rail402.dev/mcp

An MCP server that lets an AI agent find paid x402 resources on Stellar and pay for them under a spending cap.

`rail402-mcp` exposes three tools, in this order:

- `search_stellar_resources`: natural-language search of the Stellar Bazaar, with type, price and recipient filters. Each result carries its prices in whole units, whether it is within the spending policy, and a `listingId`. Searching never pays.
- `pay_and_call`: pays for and calls an HTTP endpoint or MCP tool, given a `listingId` (the payment is bound to the listing's owner) or a URL. `spendingCap` is required and is clamped to the operator's per-call ceiling; the session budget also applies. The result has the seller's answer, the receipt with the transaction hash and an explorer link, and the remaining budget.
- `get_budget`: the network, payer, spending policy, and what the current budget window spent, holds pending and has left.

Every result has an `outputSchema` and `structuredContent`. A refusal is a tool result with `isError: true` and `error: { code, reason, retryable, paid }`, where `paid` says whether money may have moved (`none`, `not_settled`, `settled` or `unknown`); a request that never reaches a tool is a JSON-RPC error whose `data` carries `{ code, reason }` as well: `tool_unknown` (`-32602`) for an unknown tool, `rpc_params_invalid` (`-32602`) for a `tools/call` without a tool name or with arguments that are not an object, and `rpc_method_unknown` (`-32601`) for a method the server does not serve. Seller text and content are returned as untrusted data, stripped of control characters and bounded in size.

Payments use the unmodified `@x402/stellar` exact client, signing through a guard that checks each Soroban authorization against the option the policy selected before the key signs it. Budgets are kept in a local SQLite ledger, so a repeated `idempotencyKey` never pays twice.

## Configuration

The server is configured through the environment. Without a key it only searches.

| Variable                                                  | Default (testnet)                                                      |
| --------------------------------------------------------- | ---------------------------------------------------------------------- |
| `RAIL402_NETWORK`                                         | `stellar:testnet` (`stellar:pubnet` must be explicit)                  |
| `RAIL402_SECRET_KEY_FILE`                                 | none: search-only. The file must be readable by its owner only         |
| `RAIL402_MAX_PER_CALL`, `RAIL402_MAX_TOTAL`               | `0.10 USDC`, `1.00 USDC` per 24 h window; required on pubnet           |
| `RAIL402_RPC_URL`, `RAIL402_BAZAAR_URL`                   | the SDF testnet RPC, `https://testnet.rail402.dev`; required on pubnet |
| `RAIL402_SESSION`, `RAIL402_SESSION_TTL`                  | `default`, `24h`                                                       |
| `RAIL402_ASSETS`                                          | extra tokens as `SYMBOL:C…:DECIMALS`, verified on chain                |
| `RAIL402_ALLOWED_RECIPIENTS`, `RAIL402_DENIED_RECIPIENTS` | none                                                                   |
| `RAIL402_REQUIRE_LISTING`, `RAIL402_MIN_TRUST`            | `false`, `settled`                                                     |
| `RAIL402_SCHEMES`, `RAIL402_UPTO_CONTRACTS`               | `exact,upto` with the canonical testnet upto contract pinned           |
| `RAIL402_LOG_LEVEL`                                       | `info` (JSON lines on stderr)                                          |

For local development only, `RAIL402_ALLOW_HTTP=true`, `RAIL402_ALLOW_PRIVATE_NETWORK=loopback` and `RAIL402_ALLOWED_PORTS` let it reach sellers on this machine; pubnet refuses them.

```json
{
  "mcpServers": {
    "rail402": {
      "command": "npx",
      "args": ["-y", "@rail402.dev/mcp"],
      "env": {
        "RAIL402_NETWORK": "stellar:testnet",
        "RAIL402_SECRET_KEY_FILE": "/home/me/.config/rail402/keys/stellar-testnet.key",
        "RAIL402_MAX_PER_CALL": "0.05 USDC",
        "RAIL402_MAX_TOTAL": "0.50 USDC"
      }
    }
  }
}
```

The server speaks stdio by default, to MCP clients on the 2026-07-28 protocol and on the 2025 revisions alike. `rail402-mcp --http` serves Streamable HTTP at `http://127.0.0.1:3402/mcp` for one operator: it listens on loopback only, checks the Host and Origin headers, limits request bodies to 1 MiB, and requires `Authorization: Bearer $RAIL402_MCP_TOKEN` (at least 32 random bytes, e.g. `openssl rand -base64 32`) whenever a key is configured.

Limits per process: `pay_and_call` 30 calls a minute, the other tools 120, and one paid call in flight (`RAIL402_MAX_INFLIGHT`) with a short queue. A call cancelled before its payment is signed pays nothing; once sent, a payment completes and its result is kept for its idempotency key.

Part of [Rail402](https://github.com/tolgayayci/rail402), x402 payments and discovery for Stellar.
Documentation: [docs.rail402.dev](https://docs.rail402.dev). Requires Node.js 24.11 or later. Apache-2.0.
