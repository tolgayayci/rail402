# MCP agent example

An MCP client that pays for what it needs without knowing any endpoint in advance. It starts `rail402-mcp`
over stdio, calls `search_stellar_resources` with a plain-language query (default: "air quality for a city"),
picks the first result that is `callable` and `withinPolicy`, and calls `pay_and_call` with that result's
`listingId`, the listing's own example input, a spending cap and an idempotency key. There is no model in
the loop, so every run takes the same steps.

The example installs from npm alone: `@modelcontextprotocol/client` and `@rail402.dev/mcp` (which provides
`rail402-mcp`) are pinned to published versions. Download it and run it from its directory:

```sh
curl -fsSL https://codeload.github.com/tolgayayci/rail402/tar.gz/main | tar -xz --strip-components=2 rail402-main/examples/mcp-agent
cd mcp-agent
```

Then:

```sh
npm install
export RAIL402_SECRET_KEY_FILE=~/.config/rail402/keys/stellar-testnet.key   # see below
npm start                                   # npm puts the installed rail402-mcp on the PATH
npm start -- "current weather for a city"
SPENDING_CAP=0.005 npm start
```

It prints one JSON line per step: the search results it saw, the full `pay_and_call` result, and the
settlement's `transaction` hash with its `explorerUrl`.

The key file holds the secret seed of a testnet account with a USDC trustline and some testnet USDC. The
`rail402` CLI creates one at that path:

```sh
npm install -g @rail402.dev/cli@0.5.7
rail402 keys new                       # ~/.config/rail402/keys/stellar-testnet.key, tagged for stellar:testnet
rail402 account setup --usdc 1         # Friendbot, USDC trustline, 1 USDC bought on the testnet exchange
```

Every `RAIL402_*` variable is passed through to the server. `RAIL402_MCP_COMMAND` changes how the server is
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
