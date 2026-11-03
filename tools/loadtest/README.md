# Discovery load test

An open-loop load test of Rail402 discovery (`GET /discovery/search`, `GET /discovery/resources`), with no
dependency beyond Node.js and the workspace, and a settle probe that measures how long a facilitator takes to
settle real payments while that load runs. Run it against a local staging service only, never against a
service other people use.

## The driver

`src/driver.ts` sends requests at a constant arrival rate: request _i_ is due at _i / rate_ seconds and is
sent then, whether or not earlier requests have answered. Each latency is measured from when the request
was due, so time spent waiting in the client counts and a stall shows in the tail instead of slowing the
load down (no coordinated omission). Requests beyond 10,000 in flight are recorded as `client_saturated`
instead of being sent.

With `--concurrency <n>` the driver runs a closed loop instead: n clients, each sending its next request as
soon as its previous one has answered, for a throughput curve (completed requests per second against
clients). A closed loop slows down with the service, so its latencies are service times at that
throughput, not latencies at an arrival rate; report the open-loop runs for those.

## Datasets

All synthetic and deterministic; `data/manifest.json` holds the SHA-256 of each (as JSON Lines), and a unit
test fails if a generator no longer produces them.

| Dataset          | What                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------- |
| `catalogA`       | The search evaluation corpus (500 listings, `tools/search-eval/data/corpus.jsonl`)        |
| `catalogB`       | Catalog A ten times (5,000 listings), each copy on its own host (`c<k>.<host>`) and payTo |
| `queries`        | The 202 evaluation queries                                                                |
| `uncachedSample` | The first 1,000 generated uncached queries for the salt `manifest`                        |

## Cache states

| `--state`    | What is measured                                                                                                                                                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `warm`       | The index is built and every query's embedding is cached: the evaluation queries, each sent once before the run, then repeated. Answers report `queryEmbedding: "cached"`.                                                              |
| `uncached`   | The index is built; every query is new to the service (generated with a per-run salt), so each runs the embedding model: `queryEmbedding: "computed"`, or `"saturated"` with a lexical, partial answer once the embedder is at its cap. |
| `cold-index` | Every `--bump-seconds` a listing is added to the staging catalog through the store; the first answer at each new catalog revision, which includes rebuilding the index, is labelled `cold-index`, the rest `warm-index`.                |

There is no HTTP cache at the origin: discovery responses carry no `Cache-Control`.

## Staging service

Two ways, both with an empty staging database (its name must contain `loadtest`, `staging` or `eval`):

- **The release image**, with the production limits (`cpus: 2`, `mem_limit: 3g` for the service), a
  Postgres of its own, `RATE_LIMIT_PER_MINUTE=0` and `SEARCH_RATE_LIMIT_PER_MINUTE=0`, plus the asset settings
  `node --conditions=@rail402/source tools/search-eval/src/http-main.ts --print-env` prints.
- **`src/staging.ts`**, a discovery-only service for a workstation: the discovery routes over Postgres with the
  search service built as the runtime builds it (pinned model, discovery settings from the environment,
  one-second revision cache, background refresh every 5 seconds) and `/health` with the ranker. It serves no
  payments.

```sh
pnpm models:fetch
DATABASE_URL=postgres://rail402:rail402@localhost:5432/rail402_loadtest PORT=8790 \
  RATE_LIMIT_PER_MINUTE=0 SEARCH_RATE_LIMIT_PER_MINUTE=0 \
  taskset -c 0,1 node --conditions=@rail402/source tools/loadtest/src/staging.ts
```

Run the driver on other CPUs than the service (`taskset`), so it does not take the service's time.

## Runs

```sh
L="taskset -c 4,5 node --conditions=@rail402/source tools/loadtest/src/main.ts --url http://127.0.0.1:8790"
$L --seed postgres://rail402:rail402@localhost:5432/rail402_loadtest --catalog A --state warm --rate 50 --duration 120 --warmup 30
$L --state uncached --rate 100 --duration 120 --warmup 30 --probe /health
$L --seed postgres://rail402:rail402@localhost:5432/rail402_loadtest --state cold-index --rate 50 --duration 120 --bump-seconds 10
$L --state warm --mix mixed --rate 100 --duration 120          # 80 % search, 20 % list pages
$L --state warm --concurrency 16 --duration 60 --warmup 10     # closed loop of 16 clients
```

`--seed` inserts the catalog through the store and waits until the service's searches see it; seeding a
catalog that already holds exactly that catalog changes nothing, and one holding anything else is refused.
`--probe <path>` samples a cheap route of the same service at `--probe-rate` (5/s) during the run, to show how
search load affects the rest of the process. `--config-env <file>` records the load-relevant settings of an
env file (never secrets or connection strings); `--cpus` and `--memory` record the service's limits.

## Settle latency under load

The settle probe (`src/settle.ts`) sends real `exact` payments to a facilitator's `POST /settle` at
`--settle-rate` per second during a run, on the local private Stellar network (`:8000`, from
`docker-compose.yml --profile stellar`); it refuses an RPC that is not on this machine. Each payment is
signed three seconds before it is due, so signing never counts, and its latency runs from when it was due
to the facilitator's answer, as for the discovery driver. Samples are labelled `settle`; a settlement
answered without `success` counts as a failure with its `errorReason`.

1. Create the payers: an asset issued on the local network, 20 funded payers and a recipient, written to
   `results/settle-setup.json` (throwaway keys of the private network). It prints the settings the
   facilitator needs (`TESTNET_RPC_URL`, `TESTNET_ASSETS`):

   ```sh
   node --conditions=@rail402/source tools/loadtest/src/settle-setup.ts --payers 20
   ```

2. Start the facilitator under test with those settings, a funded sponsor of the local network, its own
   Postgres (a staging database) and `RATE_LIMIT_PER_MINUTE=0`, `SEARCH_RATE_LIMIT_PER_MINUTE=0`. Discovery
   load and settlements then share one process, as in production.
3. Measure settle latency alone (`--rate 0`), then under a search flood against the same process:

   ```sh
   S="--settle http://127.0.0.1:8795 --settle-setup tools/loadtest/results/settle-setup.json --settle-rate 1"
   $L --seed postgres://rail402:rail402@localhost:5432/rail402_loadtest --catalog A --state uncached --rate 0 --duration 120 --warmup 0 $S
   $L --state uncached --rate 100 --duration 120 --warmup 30 $S
   ```

Compare `labels.settle.latencyMs` (p50/p95/p99) between the two runs. These runs measure the facilitator of
the checkout on a private network, with every listing and payment on `stellar:testnet`; the private network
closes ledgers at its own pace, so the absolute figures are not those of a public network. The definitive
measurement of pubnet settlement under a testnet flood runs against the release stack with its production
configuration, which is a separate run.

Each run writes `results/<run>/` (git-ignored):

- `requests.ndjson`: one line per request: when it was due, label, path, status, latency from due and
  service time, and for searches `method`, `partialResults`, `queryEmbedding` and `revision`;
- `summary.json`: per label, p50/p95/p99/mean/max latency three ways: `latencyMs` over every request sent
  (a failure counts at the time it took to fail, a timeout at its timeout, 30 s for discovery and 60 s for settlements; report this one),
  `successLatencyMs` over the successful answers only, and `errorLatencyMs` over the failures only; the error
  count and rate (unsent requests included), `unsent` (requests due at the in-flight cap, settlements the probe could not sign), statuses, and the
  counts of methods, query-embedding outcomes and partial answers; with a settle probe, `settle` gives the
  settlements sent and those it could not sign;
- `config.json`: arguments, git commit and whether the tree was dirty, Node.js version, CPU model and cores,
  the recorded limits and settings, dataset hashes, the service's version and ranker from `/health`, and for
  a settle probe the facilitator, RPC, asset, payer count and amount (never the payers' keys).

Report `partialResults` and `queryEmbedding` with the latencies: under load the embedder's cap trades result
quality (lexical answers) for latency.

## Published package

`package.sh` runs the whole set against a local staging stack and assembles a package that is committed
under `published/<date>/`:

```sh
docker build --build-arg RAIL402_VERSION=$(git rev-parse --short HEAD) -t rail402-facilitator:loadtest .
docker compose --profile stellar up -d stellar     # the local private network at :8000
IMAGE=rail402-facilitator:loadtest tools/loadtest/package.sh
```

The stack is the release image with the production limits and hardening (2 CPUs, 3 GiB, 512 processes,
read-only root, no capabilities), its own Postgres (`postgres:18.6-alpine`, 1.5 CPUs, 2 GiB) and the
production facilitator settings, with these overrides, each recorded with its reason in `config.json`: the
local private network as RPC, the corpus's testnet assets and the probe's asset, upto off (the private
network has no upto contract), no proxy hops, no rate limits, and two that keep the synthetic catalog
published: origin checks once an hour (their hosts are under the reserved `.example` domain, so a check
withdraws them as unreachable) and a ten-year retention for listings no origin confirmed (their settlement
dates are in the past). Each run records the listings by state before and after it. The corpus's assets
are public testnet contracts the private network lacks, so the stack is taken as ready when every
readiness check but the asset check passes. The service and Postgres share the cpuset `SERVICE_CPUS`
(0-3); the driver runs on `DRIVER_CPUS` (6,7).

For each catalog (A, then B on a fresh database): `warm` at 50/s with a `/health` probe, `warm` mixed at
100/s, `uncached` at 100/s and at 300/s with a `/health` probe, closed loops of 1, 4, 16 and 64 clients for
`warm` and for `uncached`, settle latency alone and under an `uncached` flood at 100/s and at 300/s (above
the uncached throughput the closed loops reach), at 0.9 settlements a second so their due times drift
across the ledger closes, and last `cold-index` at 50/s with a listing added every 10 s. Open-loop runs
last 120 s after a 30 s warm-up, closed-loop runs 60 s after 10 s.

On a shared host, `LOAD_WAIT_BELOW=2` holds each run until the host's 1-minute load average is below 2,
checked every `LOAD_WAIT_POLL` seconds (default 120) for at most `LOAD_WAIT_MAX` (default 5400), after
which the run starts anyway; the run's `host.json` records the wait and the load average it started at.

The package holds `summary.json` (p50/p95/p99 per run and label), `config.json` (image and its ID, Node.js
and ONNX Runtime versions in the image, the settings and overrides, limits, Postgres image, host CPU,
driver commit and Node.js version, dataset hashes) and per run `runs/<run>/`: the driver's `summary.json`
and `config.json`, `host.json` (the host's load average, the service's memory and the listings by state, before and after) and
`requests.ndjson.gz`, every request.
