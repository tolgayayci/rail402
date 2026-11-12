# Paid HTTP API example

A paid, discoverable HTTP API on Stellar: the stock `@x402/express` middleware with the Stellar `exact`
scheme and the Bazaar extension, its route declared with the `@rail402.dev/sdk/seller` helpers. `GET
/quote?topic=…` costs 0.001 USDC; the first settled payment through a Rail402 facilitator lists it in the
Bazaar, bound to `PAY_TO`. Its facilitator client is wrapped with `withSettleDedupe`, so each settled payment
is served once. It installs from npm alone; no clone of this repository is needed:

```sh
curl -fsSL https://codeload.github.com/tolgayayci/rail402/tar.gz/main | tar -xz --strip-components=2 rail402-main/examples/seller-http
cd seller-http
```

## Run it

`PAY_TO` is the account that receives the payments. A `G…` account needs a USDC trustline. The `rail402` CLI
creates one on the testnet in a key file of its own, so it stays apart from the buyer's key below (an account
cannot pay itself):

```sh
npm install -g @rail402.dev/cli@0.5.7
rail402 --key-file ~/.config/rail402/keys/seller-testnet.key keys new        # prints the seller's address
rail402 --key-file ~/.config/rail402/keys/seller-testnet.key account setup   # Friendbot and the USDC trustline
npm install
PAY_TO=G... npm start                      # stellar:testnet, the hosted facilitator at testnet.rail402.dev
```

In a second terminal, a buyer with 1 testnet USDC pays it. The seller runs on `localhost` over plain http,
which the buyer tools allow on testnet only when asked to:

```sh
curl -i "http://localhost:4021/quote?topic=craft"   # 402 with a PAYMENT-REQUIRED header
rail402 keys new                                    # the buyer's default key file
rail402 account setup --usdc 1
RAIL402_ALLOWED_PORTS=4021 rail402 pay "http://localhost:4021/quote?topic=craft" --max 0.01 --allow-http --allow-private-network
```

The payment settles on the testnet and the seller logs the Bazaar's answer: `bazaar_resource_unsafe`, because
`localhost` is not a public host (see below).

Or as a container:

```sh
docker build -t rail402-seller-http .
docker run --rm -p 4021:4021 -e PAY_TO=G... rail402-seller-http
```

| Variable           | Default                       | Meaning                                                                      |
| ------------------ | ----------------------------- | ---------------------------------------------------------------------------- |
| `PAY_TO`           | required                      | The `G…` account or `C…` contract paid                                       |
| `NETWORK`          | `stellar:testnet`             | `stellar:testnet` or `stellar:pubnet`                                        |
| `FACILITATOR_URL`  | `https://testnet.rail402.dev` | The facilitator; on pubnet an https facilitator that serves pubnet, required |
| `PRICE`            | `0.001`                       | USDC per call                                                                |
| `PORT`             | `4021`                        |                                                                              |
| `TRUST_PROXY_HOPS` | `0`                           | Set `1` behind a TLS proxy, so the 402 names the public https URL            |

## Get listed

The Bazaar lists only resources on public https hosts. Deploy the container behind TLS on a public host name,
set `TRUST_PROXY_HOPS=1`, and pay it once. Then:

```sh
curl "https://testnet.rail402.dev/discovery/resources?payTo=$PAY_TO"
```

shows the listing, first `pending`, then `published` once Rail402 has confirmed the route's own 402. To see
the listing before you deploy, run a facilitator of your own that catalogs loopback resources
([Try the Bazaar locally](https://docs.rail402.dev/facilitator/docker#try-the-bazaar-locally)). See the
[seller path](https://docs.rail402.dev/paths/sell) for networks, assets, what the buyer signs and fee
sponsorship.

The dependencies are pinned to the published versions this example is tested with; they move with each
Rail402 release.
