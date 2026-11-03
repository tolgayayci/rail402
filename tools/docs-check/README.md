# Clean-environment docs check

Follows the published quickstarts the way a developer new to Rail402 would, with nothing but Node.js, npm
and the network, and records how long each step took:

1. fetches `quickstart/sellers` and `quickstart/buyers` from the docs site (their published Markdown);
2. installs a seller and a buyer with the exact `npm` commands the pages give;
3. creates the seller's receiving account and a buyer holding 1 testnet USDC with the pages' own
   `create-account.ts` (Friendbot and the testnet exchange);
4. starts the page's `seller.ts` and pays it with the page's `buyer.ts`;
5. with `--public-url`, polls `/discovery/resources?payTo=…` until the resource is listed.

```sh
node src/main.ts                                     # published docs, payment only
node src/main.ts --docs docs                         # the MDX sources of a checkout
node src/main.ts --public-url https://<host> --out record.json
```

| Flag                | Default                        | Meaning                                                          |
| ------------------- | ------------------------------ | ---------------------------------------------------------------- |
| `--docs`            | `https://docs.rail402.dev`     | The docs site, or a directory with `docs.json` and the MDX pages |
| `--facilitator`     | the URL the seller page names  | The facilitator and Bazaar the seller uses                       |
| `--public-url`      | none                           | An https origin that forwards to the seller's port (4021)        |
| `--listing-timeout` | `900`                          | Seconds to wait for the listing                                  |
| `--out`             | none                           | Also write the JSON record to this file                          |
| `--work`, `--keep`  | a temporary directory, removed | Where the two projects are installed                             |

The Bazaar lists only resources on public https hosts, so the listing step needs `--public-url`; the
seller page's step for a TLS-terminating proxy (`app.set("trust proxy", 1)`) is applied then. Without it the
seller runs on localhost and the listing step is recorded as skipped.

The record (stdout, and `--out`) holds each step's duration and outcome, the docs pages read, the package
versions the pages pin and the ones npm installed, the two account addresses, the settlement transaction
hash and, when listed, the listing's id, trust and version. Secret seeds stay in the child processes'
environment and are removed from anything recorded. The run uses testnet only.
