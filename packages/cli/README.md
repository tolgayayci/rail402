# @rail402.dev/cli

`rail402` searches the Stellar Bazaar and pays x402 resources on Stellar from the command line, under a spending cap.

```sh
rail402 keys new                                   # a testnet key in ~/.config/rail402/keys (0600)
rail402 account setup --usdc 1                     # Friendbot, a USDC trustline, 1 USDC from the testnet exchange
rail402 search "current weather for a city"
rail402 pay https://demo.rail402.dev/weather --query city=Ankara --max 0.01
rail402 tx <hash>                                  # sponsor, transfers, facilitator attribution, explorer link
rail402 session show                               # spent, pending and remaining in the budget window
```

## Commands

| Command                                     | What it does                                                                                               | Signs               |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------- |
| `search <query>`                            | natural-language Bazaar search (`--type --max-price --asset --pay-to --scheme --limit --cursor`)           | no                  |
| `resources`                                 | the catalog, with the discovery filters (`--type --pay-to --scheme --extensions --limit --offset --as-of`) | no                  |
| `listing <id>`                              | one listing, and its public version history with `--versions`                                              | no                  |
| `quote <url>`                               | the unpaid request and each payment option's verdict under the policy; an MCP quote calls the tool unpaid  | no                  |
| `pay <url> --max <amount>`                  | pays an HTTP resource, or an MCP tool with `--tool <name> --args <json>`                                   | one authorization   |
| `purchase <query> --max <amount>`           | searches, picks a result (`--pick <n or listing id>`) and pays it through its listing                      | one authorization   |
| `tx <hash>`                                 | explains a transaction read from the RPC                                                                   | no                  |
| `session show\|list\|start\|end\|reconcile` | budget windows in the local ledger (`--name --max-total --ttl --force`)                                    | no                  |
| `keys new\|import\|show\|path`              | local keys; only the address is printed; `import` reads the seed from stdin                                | no                  |
| `account setup\|status`                     | testnet: Friendbot, trustline, optional `--usdc <n>`; pubnet: the trustline only, with `--yes`             | classic transaction |
| `seller check <url>`                        | checks a paid resource the way the Rail402 catalog will (`--method --tool --args`)                         | no                  |
| `seller validate <file>`                    | validates a saved `PAYMENT-REQUIRED` (JSON or base64) and shows the listing it would produce               | no                  |

Call flags for `pay` and `quote`: `--method`, `--query name=value` (repeatable), `--header "name: value"` (only `accept`, `accept-language` and `x-request-id`), `--data <json>` or `--data-file <path>`, `--tool`, `--args <json>` or `--args-file <path>`, `--transport streamable-http|sse`. Payment flags: `--max` (required; e.g. `0.05` or `"0.05 USDC"`), `--asset`, `--scheme exact|upto`, `--session <name>`, `--idempotency-key <key>`.

`--max` is clamped to the configured per-call ceiling, and the session budget applies on top. Repeating a payment with the same `--idempotency-key` returns the stored result and never pays twice. Budgets live in a SQLite ledger at `$XDG_STATE_HOME/rail402/ledger.sqlite`, shared with `rail402-mcp` for the same key and session.

## Output and exit status

Human-readable text is the default. With `--json` (or `RAIL402_OUTPUT=json`), stdout carries exactly one JSON document, and progress (`--verbose` payment events) goes to stderr:

```json
{"v":1,"ok":true,"command":"pay","network":"stellar:testnet","result":{"paid":true,"payment":{"transaction":"…"}}}
{"v":1,"ok":false,"command":"pay","error":{"code":"payment_per_call_cap_exceeded","reason":"…","retryable":false,"paid":"none"}}
```

`paid` says whether money may have moved: `none`, `not_settled`, `settled` or `unknown`.

| Exit | Meaning                                                                      |
| ---- | ---------------------------------------------------------------------------- |
| 0    | success (including a resource that did not ask for payment)                  |
| 1    | unexpected internal error                                                    |
| 2    | usage, configuration or key problem                                          |
| 3    | refused before signing: nothing was signed (also: `seller` found problems)   |
| 4    | a signed payment was refused by the seller or facilitator and did not settle |
| 5    | paid, or possibly paid: do not retry; check `rail402 session show`           |
| 6    | temporarily unavailable, nothing was paid: retry later                       |
| 7    | not found (listing, transaction, MCP tool, account)                          |

## Configuration

Flags take precedence over `RAIL402_*` environment variables, which take precedence over the config file `$XDG_CONFIG_HOME/rail402/config.json` (or `--config <path>`). The config file holds endpoints, network and caps (`network`, `rpcUrl`, `bazaarUrl`, `facilitatorUrl`, `friendbotUrl`, `maxPerCall`, `maxTotal`, `assets`, `session`, `sessionTtl`, `keyFile`, `explorer`, `allowedRecipients`, `deniedRecipients`, `requireListing`, `minTrust`); a file that contains a secret key is refused.

- `--network stellar:testnet|stellar:pubnet`: testnet by default. Pubnet has no default endpoints or caps: set `--rpc-url`, `--bazaar-url`, `RAIL402_MAX_PER_CALL` and `RAIL402_MAX_TOTAL`.
- Testnet defaults: 0.10 USDC per call and 1.00 USDC per 24-hour window.
- The signing key is looked up in this order: `--key-file`, `RAIL402_SECRET_KEY_FILE`, `RAIL402_SECRET_KEY` (removed from the environment once read), then the default key file for the network. There is no flag that takes a seed. Key files must be readable by their owner only.
- `--facilitator-url` (default: the Bazaar URL) attributes transactions in `tx` and is checked by `seller check`.
- `--allow-http`, `--allow-private-network` and `RAIL402_ALLOWED_PORTS` let the CLI reach sellers on this machine during development; pubnet refuses them.

Part of [Rail402](https://github.com/tolgayayci/rail402), x402 payments and discovery for Stellar.
Documentation: [docs.rail402.dev](https://docs.rail402.dev). Requires Node.js 24.11 or later. Apache-2.0.
