# Brief for query writers

You write search queries for Rail402's evaluation: what a person or an AI agent types into a
catalog of paid APIs and MCP tools on Stellar when they need something done.

## Blindness

Read only `tools/search-eval/construction/taxonomy.json` and this brief. **Never open the listing
drafts, the corpus or anything else under `tools/search-eval/`**: queries must come from needs, not
from listings, or the evaluation rewards copying listing text. The taxonomy's wording is also a
trap: phrase needs as a user would, not as the taxonomy does.

## Output

JSON Lines, one query per line, in the file you were given:

```json
{
  "draft": "<batch>-<nnn>",
  "text": "the query exactly as typed",
  "class": "intent | paraphrase | keyword | constraint | stellar | mcp | no_answer",
  "targets": ["<capability id>", "..."],
  "filter": { "network": "stellar:testnet", "type": "mcp", "asset": "USDC" },
  "expected": {
    "network": "stellar:pubnet",
    "type": "http",
    "asset": "USDC",
    "maxPrice": { "amount": "0.01", "unit": "USD" }
  }
}
```

- `targets`: the capability ids from the taxonomy that would satisfy the need (usually one or two).
  Empty for `no_answer`.
- `filter`: optional. Structured parameters a client sends next to the text, as a UI or an agent
  framework would (`network`, `type`, `asset`, `payTo` is never used). Most queries have none.
- `expected`: every hard constraint the searcher means, whether stated in the text or in `filter`.
  `maxPrice.unit` is `USD` for dollar or cent amounts (any dollar stablecoin counts), or an asset
  symbol (`USDC`, `EURC`, `XLM`) when the price is stated in that asset. Omit `expected` when there
  is no constraint. Only `constraint` queries and some `mcp` or `stellar` queries have one.

## Classes

- `intent`: a natural description of a need, one sentence or a fragment. Varied length and tone.
- `paraphrase`: the need described without its obvious keywords ("what the sky will do on Saturday"
  for a forecast; "turn a picture of a receipt into text" for OCR).
- `keyword`: 1 to 4 words, as typed into a search box ("iban validator", "btc ohlc").
- `constraint`: a need plus hard constraints: network ("on testnet", "mainnet only"), resource type
  ("as an MCP tool"), payment asset ("paid in EURC", "accepts XLM") or price ceiling ("under 1
  cent", "below $0.05", "max 2 XLM per call"). Phrase constraints many different ways; about a
  third put some constraints in `filter` instead of the text. Labels in `expected` must be exact.
- `stellar`: needs specific to Stellar, using its vocabulary (trustlines, anchors, SEP numbers,
  Soroban, TTL and archival, path payments, muxed accounts, stroops, Horizon, the classic DEX).
- `mcp`: an agent looking for a tool to call, often naming a precise operation where one provider
  offers several sibling tools ("tool that lists an account's trustlines", not just "stellar tool").
- `no_answer`: a plausible paid-API need that falls outside every taxonomy capability (for example
  protein folding, satellite imagery tasking, court records). Make them tempting: near a category but
  not in it.

Mix people and agents, experts and beginners, terse and chatty, a few lowercase and punctuation-free,
and about 5% in another language. Do not repeat a need within your batch.

Validate your file:

```sh
node --conditions=@rail402/source tools/search-eval/src/build/queries.ts --check <your file>
```

Return a short summary of counts per class.
