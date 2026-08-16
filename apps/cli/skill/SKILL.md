---
name: rail402-cli
description: >
  Discover and pay for x402 APIs on Stellar from the command line. Use when an agent needs to find a
  paid API in the x402 Bazaar, pay for an API call with USDC on Stellar testnet, fund a testnet
  wallet, or look up an x402 settlement on the explorer — via the `rail402` CLI.
---

# rail402 — command-line x402 payments on Stellar

`rail402` lets you (or an agent you drive) **discover paid APIs, pay for them under a spend cap, and
verify the settlement** on Stellar, entirely from the shell. It speaks x402 v2, sponsors fees (the
buyer needs no XLM), and defaults to Rail402's hosted testnet infrastructure — all free, no API keys.

## Install

```bash
npm install -g @rail402.dev/cli    # or prefix any command with: npx @rail402.dev/cli
```

## The rules that keep spending safe

1. **Every payment needs an explicit `--max` cap**, a decimal in the asset's units (`--max 0.10` =
   0.10 USDC). The CLI refuses to spend more, and never pays an unbounded amount.
2. **Store the key in an env var**, never interactively: `export RAIL402_SECRET=S...`. Agents cannot
   type a password.
3. **Always pass `--json`.** Output is then one object: `{ "ok": true, "data": {...} }` on success, or
   `{ "ok": false, "error": { "code", "reason", "retryable" } }` on failure. Branch on `ok` and read
   `error.code` — do not parse human prose.
4. **Testnet only.** Low stakes by construction.

## The loop

```bash
# 1. Get a funded testnet account (only once). Save the secret it prints.
rail402 fund --json
export RAIL402_SECRET=<secret-from-step-1>
# (For real USDC, fund the address at https://faucet.circle.com — friendbot only gives XLM.)

# 2. Discover a paid API in natural language.
rail402 search "convert usdc amounts to stroops" --json

# 3. Discover the cheapest match AND pay it, capped:
rail402 buy "convert usdc amounts to stroops" --max 0.10 --json
#   → data.paid.transaction is the settlement hash; data.body is the API's response.

#    …or pay a specific URL you already have (add query params the endpoint needs):
rail402 pay "https://api.example/convert" --max 0.10 --query amount=100 --json

# 4. Verify the settlement on the explorer.
rail402 tx <transaction-hash> --json
```

## Reading results

- **Paid successfully:** `data.paid` is present — `{ amount (atomic units), asset, transaction }` —
  and `data.body` is the resource's response. `data.explorer` is a link to the settlement.
- **Reached but not charged:** `data.paid` is absent and `data.status` is the resource's HTTP status
  (e.g. a `400` because a required query param was missing — add it with `--query k=v` and retry).
- **Refused:** `ok` is `false`. Common `error.code` values:
  - `mcp_budget_exceeded` — the price is above your `--max`; raise the cap or pick another resource.
  - `mcp_budget_required` — you forgot `--max`.
  - `config_no_signer` — no `RAIL402_SECRET` set; run `rail402 fund` first.
  - `mcp_resource_not_found` — nothing in the Bazaar matched within budget.
  - `mcp_upstream_error` — a network/HTTP problem (`retryable: true`).

## Other commands

- `rail402 whoami --json` — your address and balances.
- `rail402 feed --json` — recent x402 payments across the network.
- `rail402 supported --json` — schemes and networks the facilitator supports.

## Pointing at your own infrastructure

Defaults are Rail402's hosted testnet services; override any of them for a self-hosted deployment:
`--facilitator <url>`, `--explorer <url>` (or `RAIL402_FACILITATOR_URL` / `RAIL402_EXPLORER_URL`), or
persist with `rail402 config set facilitatorUrl <url>`.
