# MCP agent example

An MCP client that pays for what it needs without knowing any endpoint in advance. It starts `rail402-mcp`
over stdio, calls `search_stellar_resources` with a plain-language query (default: "air quality for a city"),
picks the first result that is `callable` and `withinPolicy`, and calls `pay_and_call` with that result's
`listingId`, the listing's own example input, a spending cap and an idempotency key. There is no model in
the loop, so every run takes the same steps.

The example runs from a clone of this repository after `pnpm install && pnpm build` at its root (it uses the
workspace's `@modelcontextprotocol/client`), from this directory, with `rail402-mcp` installed from npm (or the
workspace's server, with `RAIL402_MCP_COMMAND="node ../../packages/mcp/dist/bin.js"`):

```sh
npm install -g @rail402.dev/mcp@0.4.2
export RAIL402_SECRET_KEY_FILE=~/.config/rail402/keys/stellar-testnet.key   # see below
node src/index.ts
node src/index.ts "current weather for a city"
SPENDING_CAP=0.005 node src/index.ts
```

It prints one JSON line per step: the search results it saw, the full `pay_and_call` result, and the
settlement's `transaction` hash with its `explorerUrl`.

The key file holds the secret seed of a testnet account with a USDC trustline and some testnet USDC;
`rail402 keys new` and `rail402 account setup --usdc 1` from `@rail402.dev/cli` create one. Every
`RAIL402_*` variable is passed through to the server. `RAIL402_MCP_COMMAND` changes how the server is
started (default `rail402-mcp`).

## Use rail402-mcp from an MCP host

The same server works in any MCP host. It runs over stdio, and its configuration comes from the
environment: the key file, and optionally tighter caps than the testnet defaults (0.10 USDC per call,
1.00 USDC per 24-hour window).

Hosts that read an `mcpServers` object, such as Cursor (`~/.cursor/mcp.json`) and most desktop MCP clients:

```json
{
  "mcpServers": {
    "rail402": {
      "command": "rail402-mcp",
      "env": {
        "RAIL402_NETWORK": "stellar:testnet",
        "RAIL402_SECRET_KEY_FILE": "~/.config/rail402/keys/stellar-testnet.key",
        "RAIL402_MAX_PER_CALL": "0.05 USDC",
        "RAIL402_MAX_TOTAL": "0.50 USDC"
      }
    }
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.rail402]
command = "rail402-mcp"
env = { RAIL402_NETWORK = "stellar:testnet", RAIL402_SECRET_KEY_FILE = "~/.config/rail402/keys/stellar-testnet.key" }
```

The server exposes three tools: `search_stellar_resources`, `pay_and_call` and `get_budget`. See the
[MCP server reference](https://docs.rail402.dev/agents/mcp-server).
