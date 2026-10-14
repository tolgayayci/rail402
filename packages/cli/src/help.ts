import { printable } from "./args.ts";

export const HELP = `Usage: rail402 [flags] <command> [arguments]

Search the Stellar Bazaar and pay x402 resources under a spending cap.

Discovery (never signs):
  search <query>              natural-language search   --type http|mcp --max-price --asset --pay-to
                              --scheme exact|upto --limit --cursor
  resources                   catalog listing            --type http|mcp --pay-to --scheme exact|upto --extensions
                              --limit --offset --as-of
  listing <id>                one listing                --versions
  quote <url>                 unpaid probe and each option's verdict (an MCP quote runs a free tool)   --max --asset

Payments (sign one authorization per call):
  pay <url> --max <amount>    pay an HTTP resource, or an MCP tool with --tool
  purchase <query> --max <amount>
                              search, pick (--pick <n|listing id>), pay and call through the listing
                              --type http|mcp --path-param k=v
    call flags: --method --query k=v --header "k: v" --data <json> --data-file <path>
                --tool <name> --args <json> --args-file <path> --transport streamable-http|sse
    payment flags: --asset --scheme exact|upto --session <name> --idempotency-key <key>

Inspection and budget:
  tx <hash>                   explain a transaction: sponsor, transfers, facilitator attribution, explorer link
  session show|list|start|end|reconcile
                              budget windows            --name --max-total --ttl --force
Keys and accounts:
  keys new|import|show|path   local keys; only public data is printed; import reads the seed from stdin   --name
  account setup|status        testnet: Friendbot, trustline, --usdc <n> from the testnet exchange; pubnet: trustline with --yes
  seller check <url>          check a paid resource the way the catalog will   --method --tool --args
  seller validate <file>      validate a saved PAYMENT-REQUIRED (JSON or base64)
  version

Global flags:
  --network stellar:testnet|stellar:pubnet   (default testnet; pubnet needs explicit endpoints and caps)
  --rpc-url --bazaar-url --facilitator-url   endpoints
  --key-file <path>           key lookup: --key-file, RAIL402_SECRET_KEY_FILE, RAIL402_SECRET_KEY, then the default key
  --config <path>             default $XDG_CONFIG_HOME/rail402/config.json (never holds a secret)
  --json                      one JSON document on stdout (also RAIL402_OUTPUT=json)
  --verbose                   payment events on stderr
  --allow-http --allow-private-network   local development only (testnet)
  --timeout <seconds>         default 120

Exit status: 0 ok, 1 internal error, 2 usage/config/key, 3 refused before signing, 4 signed but refused
(not settled), 5 paid or possibly paid (do not retry), 6 temporarily unavailable (retry), 7 not found.
`;

const COMMAND_HELP: Readonly<Record<string, string>> = {
  pay: `Usage: rail402 pay <url> --max <amount> [flags]

Pays an HTTP resource (or an MCP tool with --tool) and prints the seller's answer and the receipt.
--max is required and is clamped to the configured per-call ceiling; the session budget also applies.
Repeating a call with the same --idempotency-key never pays twice.
`,
  purchase: `Usage: rail402 purchase <query> --max <amount> [--pick <n|listing id>] [flags]

Searches the Bazaar, picks the first payable result (or --pick), and pays it through its listing, so
the payment is bound to the listing's owner and, for HTTP, its price.
`,
  session: `Usage: rail402 session show|list|start|end|reconcile [--name <session>]

show       the budget: spent, pending and remaining per asset
list       every budget window of this key
start      start a session: --name <session> --max-total <amount> --ttl <duration, e.g. 2h> [--force]
end        end a session; its pending payments still settle or return as the chain proves them
reconcile  settle or release pending payments from on-chain proof
`,
  keys: `Usage: rail402 keys new|import|show|path [--name <name> | --key-file <path>]

new     create a key file (0600, never overwritten); prints the address and the file
import  read a seed from stdin (hidden on a terminal) into a new key file
show    the address of the configured key
path    where the key file is
`,
  account: `Usage: rail402 account setup|status [--asset <symbol>] [--usdc <amount>] [--yes]

setup   testnet: fund with Friendbot, add the asset's trustline, and buy --usdc USDC with XLM
        pubnet: add the trustline only, after --yes
status  XLM, trustlines and balances of the configured key (or a G… address given)
`,
};

export function commandHelp(command: string): string {
  return COMMAND_HELP[command] ?? `rail402 ${printable(command)}: see rail402 --help.\n\n${HELP}`;
}
