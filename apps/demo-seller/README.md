# Demo seller

A public x402 seller on Stellar built from the stock x402 packages (`@x402/express`, the Stellar `exact`
server scheme, the Bazaar server extension and `@x402/mcp`), with every route and tool declared through the
`@rail402.dev/sdk/seller` helpers so a settled payment through Rail402 catalogs it.

Paid HTTP routes: `GET /weather?city=…`, `GET /users/:id`, `POST /translate`; metered (`upto`):
`GET /history?city=…&days=…`. MCP tools at `POST /mcp`: `forecast`, `air_quality`, metered
`hourly_forecast`, free `ping`. `/.well-known/stellar.toml` lists the payTo account under the network's
passphrase (SEP-1), so a payTo whose `home_domain` names this host reaches `domain_verified` listings.
Every route and tool settles through `withSettleDedupe`, so copies of one payment sent at the same time are
served once.

A payment that has the right shape, which anyone can copy from a 402, makes the seller ask the facilitator to
verify it, and the facilitator limits the seller by its address like any other caller. So the seller limits
those payments itself, per client and for all clients together. A payment is counted once it was decoded and
matched to a paid route or tool, just before the facilitator is asked; a request without one, a payment header
that does not decode, and a payment sent to a free route or an unknown path are never counted. A payment over
either limit is refused with `rate_limited`, the code the facilitator itself answers with: an HTTP request gets
a 402 with `Retry-After`, a tool call a result with that error. A payment can cost the facilitator a
verification and a settlement, so keep `PAID_GLOBAL_PER_MINUTE` under half the facilitator's per-address limit
(Rail402's default is 600 a minute), less what other services calling it from the same address use.

A client is its address: an IPv4 address (also when written as IPv6) or an IPv6 /56. Behind proxies,
`TRUST_PROXY_HOPS` must be exactly the number of proxies in front, each of which appends or replaces
`X-Forwarded-For`; a larger value lets a client pick its own address there, and with it a fresh per-client
limit (the limit for all clients still holds). A relay such as the Playground reaches the seller as one client.
The per-client limits are kept for the 10,000 clients seen most recently.

```bash
docker build -f apps/demo-seller/Dockerfile -t rail402-demo-seller .
docker run --rm -p 8080:8080 -e PAY_TO=G... rail402-demo-seller
```

| Variable                 | Default                                  | Meaning                                                                                                            |
| ------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `PAY_TO`                 | required                                 | The `G…` account or `C…` contract paid                                                                             |
| `NETWORK`                | `stellar:testnet`                        | `stellar:testnet` or `stellar:pubnet`                                                                              |
| `FACILITATOR_URL`        | `https://testnet.rail402.dev` on testnet | The facilitator; required on pubnet, https only there                                                              |
| `ASSET`                  | Circle USDC on the network               | `C…:DECIMALS` of the token prices are paid in                                                                      |
| `METERED`                | `true` on testnet, `false` on pubnet     | Serve the `upto` route and tool (they need a facilitator serving `upto`)                                           |
| `PUBLIC_URL`             | each request's scheme and host           | The public origin the MCP tools are declared at                                                                    |
| `PAID_PER_MINUTE`        | `60`                                     | Payments from one client the seller asks the facilitator about per minute                                          |
| `PAID_GLOBAL_PER_MINUTE` | `120`                                    | The same for all clients together                                                                                  |
| `PORT`                   | `8080`                                   |                                                                                                                    |
| `TRUST_PROXY_HOPS`       | `0`                                      | Reverse proxies in front, exactly, so 402 responses name the public https URL and limits see each client's address |

An invalid setting stops the process with a message on stderr and exit status 78.
