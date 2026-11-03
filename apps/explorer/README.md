# Rail402 Explorer

The Explorer has two roles in one image: the **indexer** writes x402 settlements from public ledgers into
the Explorer database, and the **web** role serves them as public pages, a read API and the Ecosystem
Report, as a read-only database role. An optional third, the **network window** job, adds the report's
network-wide block. Guide: [docs.rail402.dev/explorer](https://docs.rail402.dev/explorer).

## Indexer

The indexer indexes the registry scope of the network's current epoch. It asks Lumeus Activity (the
discovery source) for the history of every registry facilitator account, within the ledger range the
registry gives it, and of every registered upto contract. The ledgers those histories name are the
candidates; for each one it reads the full ledger from Lumeus RPC `getLedgers` inside the RPC's retention
(about seven days) or from the public data lake before it, verifies the ledger against its own hashes and,
when configured, an independent Horizon anchor, classifies its transactions under the published
[indexing rules](../../packages/x402-index/rules/v2.md) and stores the settlements in the Explorer's own
database. Then it follows the head, polling every route from its checkpoint. Discovery only selects
ledgers: no row comes from Lumeus data. The full scan of every ledger is the rebuild command's job
(`pnpm explorer:rebuild --from … --to …`), run wherever its load does no harm.

Discovery follows Lumeus' sync rules: every walk is ascending and pinned to one read view; each window's
candidates and its `scanned_through_ledger` checkpoint are stored in one transaction; 429 and 5xx answers
are retried after `Retry-After` (a wait over 60 s stops the round instead); `query_timeout` is never
repeated unchanged (the window is halved); `generation_changed` restarts the window; next links are
followed only on the same origin and route; at most 8 Lumeus requests are in flight.

## Database and roles

The Explorer uses its own database, never the facilitator's. `sql/roles.sql` creates it with three roles:
an owner that migrates, a writer for the indexer, and a reader for public pages (SELECT only, read-only
transactions, a 2-second statement timeout). `sql/grants.sql` grants the tables. At startup the indexer
refuses a role that is a superuser, can create roles or databases, or can connect to the facilitator's
database.

## Running

```sh
EXPLORER_NETWORK=testnet \
EXPLORER_LUMEUS_KEY_FILE=/run/secrets/lumeus-testnet \
EXPLORER_DATABASE_URL=postgres://writer:…@localhost:5432/rail402_explorer \
EXPLORER_MIGRATION_DATABASE_URL=postgres://owner:…@localhost:5432/rail402_explorer \
pnpm --filter @rail402.dev/explorer indexer
```

| Variable                                       | Default                                                                     | Meaning                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EXPLORER_NETWORK`                             | required                                                                    | `testnet` or `pubnet`.                                                                                                                                                                                                                                                                                                                                   |
| `EXPLORER_DATABASE_URL` (or `_FILE`)           | required                                                                    | The writer role's connection.                                                                                                                                                                                                                                                                                                                            |
| `EXPLORER_MIGRATION_DATABASE_URL` (or `_FILE`) | unset                                                                       | When set, migrates the database as this (owner) role before indexing.                                                                                                                                                                                                                                                                                    |
| `EXPLORER_LUMEUS_KEY_FILE`                     | required                                                                    | A file holding this network's Lumeus server key (`lum_test_…` for testnet, `lum_live_…` for mainnet). An inline `EXPLORER_LUMEUS_KEY` is refused. The key is sent only to the network's Lumeus hosts and never logged.                                                                                                                                   |
| `EXPLORER_LUMEUS_API_URL`                      | testnet: `https://api-testnet.lumeus.dev`; pubnet: `https://api.lumeus.dev` | Lumeus Activity, the discovery source. Only the network's own Lumeus host is accepted.                                                                                                                                                                                                                                                                   |
| `EXPLORER_RPC_URL`                             | testnet: `https://rpc-testnet.lumeus.dev`; pubnet: `https://rpc.lumeus.dev` | RPC `getLedgers` for ledgers inside its retention (https). The key goes only to the network's Lumeus RPC; another RPC is used without it, and the other network's Lumeus host is refused.                                                                                                                                                                |
| `EXPLORER_RPC_PAGE_LEDGERS`                    | testnet `100`, pubnet `20` (the maximums)                                   | Ledgers per `getLedgers` call, below Lumeus' 64 MiB answer cap.                                                                                                                                                                                                                                                                                          |
| `EXPLORER_BYTES_IN_FLIGHT_MIB`                 | `64` (at least 8)                                                           | Raw ledger bytes (`getLedgers` metadata, data lake objects) held at once, fetched and not yet decoded (`rail402_explorer_ledger_bytes_in_flight`). Fetching waits while this much is held, a `getLedgers` page is sized to about half of it, and ledgers are decoded one at a time, so the indexer runs within a 512 MB heap at the default concurrency. |
| `EXPLORER_RETENTION_MARGIN_LEDGERS`            | `120`                                                                       | Ledgers this close to the RPC retention's oldest edge are read from the data lake.                                                                                                                                                                                                                                                                       |
| `EXPLORER_ANCHOR_HORIZON_URL`                  | testnet: `https://horizon-testnet.stellar.org`; pubnet: required            | A Horizon with full history: every candidate ledger's hash is checked against it before the ledger is committed (https). `off` is refused on pubnet.                                                                                                                                                                                                     |
| `EXPLORER_FROM_LEDGER`                         | testnet: the epoch's first ledger; pubnet: 61,440,000                       | The first ledger of the index.                                                                                                                                                                                                                                                                                                                           |
| `EXPLORER_TO_LEDGER`                           | unset (follow the head)                                                     | Stop after this ledger: discover and index through it, publish the report and exit. The bound is never stored with the routes, so a later run with a wider bound or none resumes where this one stopped.                                                                                                                                                 |
| `EXPLORER_CONCURRENCY`                         | `8` (at most 8)                                                             | Lumeus requests in flight, routes walked and ledgers verified at once.                                                                                                                                                                                                                                                                                   |
| `EXPLORER_DISCOVERY_WINDOW_LEDGERS`            | `500000`                                                                    | Ledgers per discovery window; every page of a window is committed with the checkpoint it vouches for, so a failure loses at most one page.                                                                                                                                                                                                               |
| `EXPLORER_MAX_CANDIDATES_PER_ROUND`            | `20000`                                                                     | New candidate ledgers one route may add per round; a route that lists more continues next round (`rail402_explorer_candidates_capped_total`).                                                                                                                                                                                                            |
| `EXPLORER_SLOW_ROUTE_ROUNDS`                   | `20`                                                                        | At the head, channel and settlement-authority routes (which Lumeus lists only when they pay a fee or move funds) are walked every this many rounds; fee-paying routes and upto contracts every round.                                                                                                                                                    |
| `EXPLORER_POLL_SECONDS`                        | `15`                                                                        | Wait between rounds at the head.                                                                                                                                                                                                                                                                                                                         |
| `EXPLORER_FACILITATOR_DATABASE`                | `rail402`                                                                   | The database the startup check makes sure the role cannot reach.                                                                                                                                                                                                                                                                                         |
| `EXPLORER_ALLOW_UNSAFE_ROLE`                   | `false`                                                                     | Testnet only, for local development: run under a role the check refuses. Refused on pubnet.                                                                                                                                                                                                                                                              |
| `EXPLORER_HEALTH_HOST`, `EXPLORER_HEALTH_PORT` | `127.0.0.1`, `9464`                                                         | `/health` (JSON) and `/metrics` (Prometheus, `rail402_explorer_*`, including `rail402_explorer_lumeus_requests_total`, `rail402_explorer_lumeus_errors_total`, `rail402_explorer_lag_ledgers`, `rail402_explorer_candidate_ledgers` and `rail402_explorer_ledger_bytes_in_flight`).                                                                      |
| `EXPLORER_MAX_LAG_LEDGERS`                     | `120`                                                                       | `/health` is `ok` only within this lag of the discovery source's head.                                                                                                                                                                                                                                                                                   |
| `EXPLORER_REPORT_REFRESH_SECONDS`              | `300`                                                                       | How often the indexer computes the network's report and publishes it for the web role; `0` turns it off.                                                                                                                                                                                                                                                 |

## What stops the indexer

A ledger is never skipped. The indexer marks the ledger `failed`, reports the code on `/health` and in
`rail402_explorer_failures_total`, and exits when:

- a ledger does not hash to its header, or its transaction set or results do not match the header
  (`ledger_hash_invalid`, `tx_set_hash_mismatch`, `result_set_hash_mismatch`), or it is not the ledger
  asked for (`ledger_mismatch`);
- a ledger's hash differs from the Horizon anchor (`anchor_mismatch`);
- a ledger or transaction meta version is unknown (`ledger_undecodable`, `meta_unsupported`);
- a settlement candidate's events do not hash to the result the header commits to (`events_unbound`);
- the discovery source refuses the key or the request, or answers with pages that leave the pinned read
  view, the window, the route or the network (`lumeus_unauthorized`, `lumeus_request_refused`,
  `lumeus_response_invalid`);
- the discovery source's head falls behind the indexed ledgers, which means a testnet reset
  (`epoch_reset`): add the new epoch to the registry and start again;
- a bounded run (`EXPLORER_TO_LEDGER`) cannot discover or read a ledger through its end after its retries
  (`range_incomplete`): the process exits non-zero.

The report stops before a failed ledger. At start, failed ledgers go back to the queue, so a restart reads
them again. Transient failures (Lumeus 429/5xx, `lumeus_rate_limited`, `lumeus_unavailable`, a data lake or
RPC timeout, an anchor Horizon cannot give yet) are retried in the next round; the route keeps its
checkpoint and the ledger stays pending.

At start, the indexer loads the published registry and makes the stored routes its plan: a new account
or contract is walked from its first ledger; a route whose range starts earlier is walked again from the
new start; a removed one is dropped with the ledgers only it listed and those ledgers' rows. Ledgers
indexed under another rules version or other upto contract entries are read again; rows under an older
registry version are re-attributed in place (the same function the classifier uses, so the table equals a
fresh index).

Run one indexer per network. A second one on the same database is harmless (a discovery window that does
not move the checkpoint, and a ledger that is no longer pending, change nothing) but does the same work
twice. The daily and per-account totals are refreshed under a transaction-scoped advisory lock per network
and epoch, so commits that touch the same seller or day take turns.

Transactions whose rows could not be stored exactly as they are (a NUL character or invalid UTF-8 in event
data, a field of the wrong shape) are counted as `malformed` exclusions by the rules, so a hostile
transaction never stops the indexer.

## Network window

The indexer reads only the ledgers of registered facilitators, so its totals never include a facilitator
outside the registry. The network window job measures the whole network over a recent window instead:
every `EXPLORER_NETWORK_WINDOW_EVERY_HOURS`, it rebuilds the newest `EXPLORER_NETWORK_WINDOW_HOURS` of
ledgers (720 per hour) in full from the public data lake with the rebuild command's own code (scope
`full`, the same rules and registry), and stores the window's tier totals and manifest in
`network_windows`. The web role attaches it to the report as `networkWide` and shows it as its own block,
with the window's ledgers and close times and the `pnpm explorer:rebuild --from … --to …` command that
reproduces its manifest hash.

It is off unless `EXPLORER_NETWORK_WINDOW_HOURS` is set, runs as its own process (`network-window` role,
the writer's connection), reads no Lumeus product and nothing of the facilitator, and adds no
transaction anywhere. Each run holds at most `EXPLORER_NETWORK_WINDOW_BYTES_IN_FLIGHT_MIB` of fetched
ledger bytes and one decoded ledger at a time, streams rows to files it removes when the run ends, and
stops at its time, download or row budget (`network_window_time_budget`,
`network_window_download_budget`, `network_window_row_budget` in the log); the last published window
stays. On public testnet a 24-hour window (17,280 ledgers) downloads about 365 MiB of ledgers and takes
about 12 minutes with 8 requests in flight. Pubnet ledgers are far larger, so a pubnet window requires an explicit download budget, and independent anchors as the indexer
does.

```sh
EXPLORER_NETWORK=testnet EXPLORER_NETWORK_WINDOW_HOURS=24 \
EXPLORER_DATABASE_URL=postgres://writer:…@localhost:5432/rail402_explorer \
pnpm --filter @rail402.dev/explorer network-window          # add --once to run one window and exit
```

| Variable                                      | Default                                                          | Meaning                                                                                                                                                                                                  |
| --------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EXPLORER_NETWORK_WINDOW_HOURS`               | `0` (off)                                                        | The window, 1 to 168 hours (7 days).                                                                                                                                                                     |
| `EXPLORER_NETWORK_WINDOW_EVERY_HOURS`         | `24`                                                             | Hours between runs.                                                                                                                                                                                      |
| `EXPLORER_NETWORK_WINDOW_MAX_SECONDS`         | `3600`                                                           | Time budget of one run (at least 60).                                                                                                                                                                    |
| `EXPLORER_NETWORK_WINDOW_MAX_DOWNLOAD_MIB`    | testnet: `8192`; pubnet: required                                | Ledger bytes one run may download.                                                                                                                                                                       |
| `EXPLORER_NETWORK_WINDOW_MAX_ROWS`            | `500000`                                                         | Settlement rows one window may hold.                                                                                                                                                                     |
| `EXPLORER_NETWORK_WINDOW_BYTES_IN_FLIGHT_MIB` | `32`                                                             | Fetched ledger bytes held at once (at least 8).                                                                                                                                                          |
| `EXPLORER_NETWORK_WINDOW_CONCURRENCY`         | `4`                                                              | Data lake requests in flight (at most 16).                                                                                                                                                               |
| `EXPLORER_NETWORK_WINDOW_DIR`                 | the system temporary directory                                   | Where a run writes its rebuild files; removed when it ends.                                                                                                                                              |
| `EXPLORER_ANCHOR_HORIZON_URL`                 | testnet: `https://horizon-testnet.stellar.org`; pubnet: required | Anchors both ends of each window; the printed command names it (`--anchor-horizon`). `off` (testnet only) leaves them out.                                                                               |
| `EXPLORER_NETWORK_WINDOW_PUBLIC_ANCHOR_URL`   | the anchor, when its path is `/`                                 | The Horizon the published window and its command name, a bare origin. Required when `EXPLORER_ANCHOR_HORIZON_URL` has a path, which may carry a provider key; the anchor itself is then never published. |

`EXPLORER_NETWORK`, `EXPLORER_DATABASE_URL`, `EXPLORER_MIGRATION_DATABASE_URL`,
`EXPLORER_FACILITATOR_DATABASE` and `EXPLORER_ALLOW_UNSAFE_ROLE` mean what they mean for the indexer, and
pubnet refuses an unsafe role.

## Web role

```sh
EXPLORER_DATABASE_URL=postgres://reader:…@localhost:5432/rail402_explorer \
pnpm --filter @rail402.dev/explorer web
```

At startup it refuses a role that can write any Explorer table, lacks read-only transactions or a
statement timeout of at most 5 seconds, or can reach the facilitator's database. The timeout does not rest
on the role setting alone, which a session could change with `SET`: the web role sends every statement
with a 2-second `statement_timeout` and cancels any statement still running after that with
`pg_cancel_backend`. Waiting more than 2 seconds for a free connection answers `503 explorer_unavailable`.

The indexer refuses a writer role that can modify `schema_migrations`; `sql/grants.sql` (run after the
first migration) leaves the migration log to the owner.

| Variable                                                                     | Default                                                                                                      | Meaning                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EXPLORER_DATABASE_URL` (or `_FILE`)                                         | required                                                                                                     | The reader role's connection.                                                                                                                                                                                                                                                                                                                             |
| `EXPLORER_NETWORKS`                                                          | `testnet,pubnet`                                                                                             | Networks to serve. Mainnet pages have no prefix, testnet pages live under `/testnet`; with testnet only, `/` redirects to `/testnet`.                                                                                                                                                                                                                     |
| `EXPLORER_HOST`, `EXPLORER_PORT`                                             | `0.0.0.0`, `8080`                                                                                            | Pages, `/api/v1/…` and `/health`.                                                                                                                                                                                                                                                                                                                         |
| `EXPLORER_TESTNET_LUMEUS_KEY_FILE`, `EXPLORER_PUBNET_LUMEUS_KEY_FILE`        | unset                                                                                                        | A file holding that network's Lumeus key for live lookups: use a key apart from the indexer's, either a read-access server key or a publishable key (`lum_pub_…`) whose allowed origins include `EXPLORER_PUBLIC_URL` (sent as `Origin`). With it, live lookups default to the network's Lumeus RPC and send the key there only. Inline keys are refused. |
| `EXPLORER_TESTNET_LOOKUP_RPC_URL`, `EXPLORER_PUBNET_LOOKUP_RPC_URL`          | the network's Lumeus RPC with a key file; else testnet: `https://soroban-testnet.stellar.org`, pubnet: unset | RPC for live lookups of hashes not indexed yet; off when unset. Keep it apart from any settlement RPC. Another host never gets the Lumeus key.                                                                                                                                                                                                            |
| `EXPLORER_TESTNET_PUBLIC_RPC_URL`, `EXPLORER_PUBNET_PUBLIC_RPC_URL`          | the public SDF testnet RPC, `https://mainnet.sorobanrpc.com`                                                 | The RPC shown in each page's copy-paste `getTransaction` command.                                                                                                                                                                                                                                                                                         |
| `EXPLORER_LOOKUP_PER_CLIENT_PER_MINUTE`, `EXPLORER_LOOKUP_GLOBAL_PER_MINUTE` | `6`, `60`                                                                                                    | Live lookup budgets, per client and per network; a quarter of the global budget is kept for clients' first lookup in a minute. A found transaction is answered from memory for 60 s.                                                                                                                                                                      |
| `EXPLORER_LOOKUP_NEGATIVE_TTL_SECONDS`                                       | `20`                                                                                                         | How long an unknown hash is answered from memory.                                                                                                                                                                                                                                                                                                         |
| `EXPLORER_RATE_LIMIT_PER_MINUTE`                                             | `120`                                                                                                        | Requests per client per minute, pages and API together.                                                                                                                                                                                                                                                                                                   |
| `EXPLORER_TRUSTED_PROXY_HOPS`                                                | `0`                                                                                                          | Proxies in front that append to `X-Forwarded-For` (see below).                                                                                                                                                                                                                                                                                            |
| `EXPLORER_MAX_IN_FLIGHT`                                                     | `32`                                                                                                         | Requests served at once; beyond it the answer is `503 explorer_unavailable` with `Retry-After`.                                                                                                                                                                                                                                                           |
| `EXPLORER_REPORT_REFRESH_SECONDS`                                            | `30`                                                                                                         | How often the report the indexer published is read again.                                                                                                                                                                                                                                                                                                 |
| `EXPLORER_STATUS_URL`                                                        | unset                                                                                                        | Where service availability is reported (https); the report links to it.                                                                                                                                                                                                                                                                                   |
| `EXPLORER_TESTNET_BAZAAR_URL`, `EXPLORER_PUBNET_BAZAAR_URL`                  | testnet: `https://testnet.rail402.dev`; pubnet: unset                                                        | The Bazaar whose public read API (`/discovery/…`) names what each payment paid for and lists the services (an https origin without a path; `off` turns it off). Unset means no Bazaar data on that network's pages. Pages render without it when it does not answer, and say so.                                                                          |
| `EXPLORER_TESTNET_BAZAAR_KEY_FILE`, `EXPLORER_PUBNET_BAZAAR_KEY_FILE`        | unset                                                                                                        | A file holding a `discovery-internal` access key (`r402_…`) of that network's Bazaar. With it every Bazaar call carries the key and an HMAC of the visitor's rate-limit key (`X-Rail402-Client`), so each visitor has its own discovery budget; without it all calls share the Explorer's address. Inline keys are refused; the key is never logged.      |
| `EXPLORER_BAZAAR_TIMEOUT_MS`, `EXPLORER_BAZAAR_CACHE_SECONDS`                | `2500`, `60`                                                                                                 | Per Bazaar call, and how long its answers are kept (a failure for 5 s). Answers are capped at 1 MiB, and all Bazaar calls of one page share a 3-second deadline.                                                                                                                                                                                          |
| `EXPLORER_TESTNET_HOLDINGS`, `EXPLORER_PUBNET_HOLDINGS`                      | testnet `on`, pubnet `off`                                                                                   | Live holdings on account and facilitator pages from Lumeus Assets, with the network's `EXPLORER_<NETWORK>_LUMEUS_KEY_FILE` key (off without one). Labelled "Live · not audited" and never counted.                                                                                                                                                        |
| `EXPLORER_HOLDINGS_PER_MINUTE`                                               | `30`                                                                                                         | Lumeus Assets calls per network per minute across all visitors; answers are kept 3 minutes.                                                                                                                                                                                                                                                               |
| `EXPLORER_PUBLIC_URL`                                                        | `https://explorer.rail402.dev`                                                                               | The Explorer's own origin, for absolute links in API answers and snapshots.                                                                                                                                                                                                                                                                               |
| `EXPLORER_METRICS_HOST`, `EXPLORER_METRICS_PORT`                             | `127.0.0.1`, `9465`                                                                                          | `/metrics` (Prometheus, `rail402_explorer_web_*`).                                                                                                                                                                                                                                                                                                        |
| `EXPLORER_FACILITATOR_DATABASE`, `EXPLORER_ALLOW_UNSAFE_ROLE`                | `rail402`, `false`                                                                                           | As for the indexer; the unsafe role is refused while pubnet is served.                                                                                                                                                                                                                                                                                    |

Limits are keyed by client address: an IPv4 address, or an IPv6 /64. Set `EXPLORER_TRUSTED_PROXY_HOPS` to
the number of proxies that append to `X-Forwarded-For` in front of the web role, counting every hop. The
proxy example (`deploy/proxy/Caddyfile.example`) does not append: it replaces `X-Forwarded-For` with the
one client address Caddy determined (`header_up X-Forwarded-For {client_ip}`), so behind it the value is
`1`. With a CDN in front of Caddy, keep `1`, and make `{client_ip}` the visitor rather than the CDN's
edge with Caddy's global `servers` options: `trusted_proxies static <the CDN's address ranges>` and
`client_ip_headers <the header in which the CDN sends the visitor's address>`. Without them every visitor
behind one CDN edge shares that edge's budget. With `0` behind a proxy, every visitor shares the proxy's
budget. The limits are per process; run the edge's own limits in front of several replicas.

`pnpm --filter @rail402.dev/explorer snapshot --network testnet --out ./snapshot` exports a network's
report as `report.html`, `report.json` and the rebuild's own files; its manifest is byte-identical to
what `pnpm explorer:rebuild` writes for the same range. With a network window published, its manifest is
written too, as `network-window-manifest.json`.

### Upgrading a full-scan database

Migration `0003_discovery.sql` moves an Explorer from full-scan to registry-scope indexing. It removes
every settlement, failed attempt, anchor, total and report the full scan wrote, because a registry-scope
report may count only rows of the ledgers it lists; the indexer rebuilds them from the candidate ledgers.
Take a database backup before applying it. Until the indexer publishes its first registry-scope report,
the web role serves no report (`explorer_report_unavailable`), and it never serves a stored report of
another scope or manifest version.

## Image

`apps/explorer/Dockerfile` builds one image for both roles; `EXPLORER_ROLE` (or the first argument)
picks `web`, `indexer`, `network-window`, `snapshot` or `migrate`. `migrate` applies pending migrations as the owner
(`EXPLORER_MIGRATION_DATABASE_URL` or `_FILE`), prints them as one JSON line and exits, so a deployment can
migrate in a one-shot step and keep the owner's credentials away from the long-running indexers. The image holds only the Explorer's sources, migrations and SQL
templates and the built, published files of its production dependencies: no tests, fixtures or other
workspace files. `compose.yaml` runs both against the local Postgres, with a Lumeus testnet key from a
file mounted as a secret:

```sh
EXPLORER_LUMEUS_TESTNET_KEY_FILE=./lumeus-testnet.key \
  docker compose -f docker-compose.yml -f apps/explorer/compose.yaml --profile explorer up -d --build
```

Add `--profile explorer-window` to run the network window job too (a 24-hour testnet window once a day).
