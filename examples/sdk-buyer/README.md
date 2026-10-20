# SDK buyer example

Pays one x402 resource on the Stellar testnet by URL, then searches the Rail402 Bazaar for "current weather
for a city" and pays the first result that is callable and within the spending policy, through its listing.
Every payment needs a cap (`maxAmount`); the testnet defaults also cap each call at 0.10 USDC and each
24-hour budget window at 1.00 USDC.

The example is configured like the `rail402` CLI and the `rail402-mcp` server, through `RAIL402_*`
environment variables. It needs a testnet account with a USDC trustline and some testnet USDC, which the
`rail402` CLI sets up:

```sh
npm install -g @rail402.dev/cli@0.4.2
rail402 keys new                       # prints the address and the key file
rail402 account setup --usdc 1         # Friendbot, USDC trustline, 1 USDC bought on the testnet exchange
export RAIL402_SECRET_KEY_FILE="$(rail402 keys path)"
```

The example itself runs from a clone of this repository, whose `@rail402.dev/sdk` it uses. After
`pnpm install && pnpm build` at the repository root, from this directory:

```sh
node src/index.ts                                           # defaults below
node src/index.ts "https://demo.rail402.dev/weather?city=Ankara" "current weather for a city"
MAX_AMOUNT="0.005 USDC" node src/index.ts                   # a tighter per-call cap
```

Each step prints one JSON line: the payment receipt (with its `transaction` hash and `explorerUrl`), the
seller's answer, and at the end the budget window.

Inside this repository, run it against the workspace sources with `pnpm --filter
@rail402.dev/example-sdk-buyer start`.
