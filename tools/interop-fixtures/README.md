# Bazaar interoperability fixtures

Canonical Bazaar records, generated with upstream `@x402/extensions` (Apache-2.0) from the examples of the
x402 Bazaar specification (`specs/extensions/bazaar.md` in `x402-foundation/x402`, Apache-2.0), and the
suite that runs them through Rail402's cataloging and discovery.

Each fixture is the seller's `402` response for one resource: its bazaar extension comes from
`declareDiscoveryExtension`, enriched by `bazaarResourceServerExtension.enrichDeclaration` with the request
a seller's server would see. Hosts are `*.example` names and accounts are derived from fixed labels, so the
files are the same on every run.

| Fixture                | From the specification                        | Network |
| ---------------------- | --------------------------------------------- | ------- |
| `http-get`             | Example: GET Endpoint, with service metadata  | testnet |
| `http-post`            | Example: POST Endpoint                        | pubnet  |
| `mcp-tool`             | Example: MCP Tool, at an `https` endpoint     | testnet |
| `http-dynamic-route`   | Dynamic Routes and `routeTemplate`            | testnet |
| `http-other-extension` | Service Metadata, plus a `payment-identifier` | pubnet  |
| `http-upto`            | GET endpoint with an `upto` option            | testnet |

```sh
node --conditions=@rail402/source tools/interop-fixtures/src/main.ts           # check the committed files
node --conditions=@rail402/source tools/interop-fixtures/src/main.ts --write   # regenerate them
```

`fixtures/manifest.json` lists each file's SHA-256. The unit suite fails when the committed files differ from
what the installed `@x402/extensions` generates, so an upstream change shows up as a diff to review.

## What the suite checks

For every fixture, on the memory store (`pnpm test`) and on Postgres (`pnpm test:integration`):

- the payment is settled into the catalog and the origin check answers with the fixture's `402`;
- `GET /discovery/resources` and `GET /discovery/search` return the resource with `resource`, `type`,
  every `accepts` field (scheme, network, asset, payTo, amount, maxTimeoutSeconds, extra), the bazaar
  `info`, `schema` and `routeTemplate` (and so `input.toolName` and `transport`), `description`,
  `mimeType`, `serviceName`, `tags` and `iconUrl` equal to the fixture, compared as canonical JSON;
- each filter (`type`, `network`, `payTo`, `scheme`, `extensions`, alone and combined) returns the
  fixture exactly when it holds;
- the upstream `withBazaar` client parses the list and search responses;
- every `EXTENSION-RESPONSES` value has the specified `status` and, only when rejected, `rejectedReason`.

## Declared differences

What Rail402 publishes differently from the upstream reference catalog, on purpose:

|     | Difference                                                                                                                                                                                              | Why                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a   | Extensions other than `bazaar` are republished by key, with an empty object (`"payment-identifier": {}`). The `extensions` filter works as specified.                                                   | A buyer's echo can carry its own data (a payment identifier) and a declaration can change with every response (a sign-in challenge); neither belongs in a public catalog. |
| b   | An `upto` listing shows the cap its seller offers, not the amount a settlement moved.                                                                                                                   | The settled amount changes from call to call; the cap is what one call can cost.                                                                                          |
| c   | HTTP resources and MCP tools at an `http(s)` endpoint are published with what their own `402` says, after an origin check, never with the buyer's echo. Cataloging reports `processing` until then.     | Anyone can pay any payTo one base unit; only the resource itself can vouch for its description and price.                                                                 |
| d   | Each item carries a `rail402` object (method, tool name, trust, settlements, listings, option facts), and search responses a `rail402` block.                                                           | Rail402's facts stay out of the specified fields, so stock clients see the specified shape.                                                                               |
| e   | `resource` is canonicalized: lower-case scheme and host, default port, normalized percent-encoding and dot segments, no query or fragment. A dynamic route is published as origin plus `routeTemplate`. | One resource, one listing, however its URL is spelled.                                                                                                                    |
| f   | A `/discovery/resources` page that would exceed 3.5 MiB ends early, and its `pagination.limit` says how many resources it holds.                                                                        | Upstream's `withBazaar` refuses responses over 4 MiB.                                                                                                                     |
| g   | On `stellar:pubnet`, MCP tools under an `mcp://` URL are refused (`bazaar_resource_unverifiable`) and resource URLs must use `https`.                                                                   | Nothing but the settlement would vouch for an originless tool.                                                                                                            |
| h   | `EXTENSION-RESPONSES` adds `code`, `reason`, `listingId`, `version` and `dropped` next to the specified `status` and `rejectedReason`.                                                                  | Sellers can branch on a stable code.                                                                                                                                      |
| i   | A resource sold on several networks is one item whose `accepts` holds every network's options.                                                                                                          | A settlement proves a payTo on its own network; each network keeps its own listing under `rail402.listings`.                                                              |

Search `pagination.limit` is the number of results in the page, as the specification defines it.
