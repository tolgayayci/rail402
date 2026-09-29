# Brief for listing writers

You write listing drafts for Rail402's search evaluation corpus: services that sellers put behind
x402 payments on Stellar, as they would appear in a Bazaar discovery catalog. The corpus is
synthetic and labelled so, but it must read like a real catalog, including its mess.

## Inputs and output

- Read `tools/search-eval/construction/taxonomy.json` for your categories and their capabilities.
  Read nothing else in the repository except this brief and the build tool named below.
- Write JSON Lines, one draft per line, to the file you were given. Then validate it:

  ```sh
  node --conditions=@rail402/source tools/search-eval/src/build/corpus.ts --check <your file>
  ```

  Fix every reported problem and rerun until it prints `N of N drafts catalog cleanly`.

## Draft format

```json
{
  "draft": "<batch>-<nnn>",
  "category": "<category id>",
  "capabilities": ["<capability id>", "..."],
  "provider": "<lowercase-slug>",
  "kind": "http | mcp",
  "resource": "https://api.<provider>.example/v1/...  (mcp: https://mcp.<provider>.example/mcp or mcp://tool/<toolName>)",
  "method": "GET | POST (http only)",
  "toolName": "snake_case_name (mcp only)",
  "serviceName": "string or null",
  "description": "string or null",
  "tags": ["..."],
  "parameters": [
    {
      "name": "city",
      "type": "string",
      "required": true,
      "description": "string or null",
      "example": "Lisbon"
    }
  ],
  "output": { "example": "response object" },
  "prices": [
    { "network": "stellar:pubnet | stellar:testnet", "asset": "USDC | EURC | XLM", "amount": "0.002" }
  ],
  "style": "sparse | sloppy | standard | detailed",
  "adversarial": null
}
```

- `amount` is in whole units of the asset (up to 7 decimals), not base units.
- `output` may be null. `parameters` may be an empty list. Every required parameter of an HTTP
  resource needs an `example`: the stock discovery schema requires it in the listing's `info`.
- `provider` identifies the seller: every draft with the same provider is paid to the same account.
- Hosts end in `.example` (a reserved domain), e.g. `api.skycast.example`, `skycast.example`.
- A resource with the same URL and method (or the same MCP URL and tool name) must not repeat on a network.

## What makes the corpus realistic

1. **Your own words.** Never reuse the taxonomy's capability wording. Write as the provider would,
   with its own jargon, brand voice and emphasis. Two providers of the same thing should describe
   it differently ("hourly outlook", "10-day forecast", "met data").
2. **Competition.** Cover every capability in your categories with 2 to 4 competing providers,
   differing in price, depth and quality. Some listings serve two capabilities.
3. **Families.** Many providers sell several endpoints (current vs forecast vs history). MCP
   servers expose several tools at one URL (2 to 6 tools, same resource URL, different `toolName`).
   Some MCP tools use `mcp://tool/<toolName>` resources.
4. **Styles**, roughly: 15% `sparse` (no description or a few words, often no tags, generic path
   like `/v1/q` or `/api/data`), 15% `sloppy` (typos, marketing fluff, capitals, irrelevant
   claims, vague), 50% `standard`, 20% `detailed` (parameter descriptions and an output example).
   A few listings (about 3%) are written in another language.
5. **Mix**, roughly: 70% HTTP and 30% MCP; 55% `stellar:pubnet` and 45% `stellar:testnet`; prices in
   USDC 75%, EURC 10%, XLM 15%; about 10% of listings accept two options (for example USDC and XLM,
   or testnet and pubnet).
6. **Prices** fit the work: simple lookups 0.0001 to 0.01 USD, enrichment and scraping 0.005 to
   0.1, model inference 0.01 to 2. XLM amounts assume roughly 0.35 USD per XLM; EURC roughly 1.1 USD.
7. **Names** are invented. No real companies, products or trademarks.
8. Stellar-specific services use real Stellar concepts correctly: G/C/M addresses, trustlines,
   anchors, SEP numbers, Soroban, stroops, the classic DEX and AMM pools.

Return a short summary: how many drafts you wrote per category, style and kind.
