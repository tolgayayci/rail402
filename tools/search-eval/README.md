# Search evaluation

A frozen, graded dataset for Rail402's natural-language search (`GET /discovery/search`) and the
harness that scores the production `SearchService` on it. It reproduces with one command from a
fresh clone:

Prerequisites: Node.js 24.11 or later (`.node-version` pins 24.19.0), pnpm 11.22 through Corepack
(`corepack enable`), and network access to `huggingface.co` on the first run, which downloads the embedding
model (about 90 MB). A run takes about 15 seconds on a laptop CPU. Every number except latency reproduces exactly on the
machine that recorded the baseline; other CPU models have not been checked, and floating-point inference may
differ on them.

```sh
pnpm install
pnpm eval          # prints the report and writes results/report.json
pnpm eval:check    # the release gate CI runs (non-zero exit on failure)
```

The pinned embedding model (`all-MiniLM-L6-v2`, revision and hashes in
`packages/search/models/all-minilm-l6-v2.json`) is downloaded and verified on first use.

## Results (baseline `search-eval-v1.1.0`)

Test split, 81 answerable queries. Relevant means grade ≥ 2; nDCG uses linear gain with the ideal
ranking over all judged listings (trec_eval semantics).

| Mode          | MRR              | nDCG@10           | Recall@20         | P@1   | Latency p50 / p95 |
| ------------- | ---------------- | ----------------- | ----------------- | ----- | ----------------- |
| BM25F         | 0.823            | 0.677             | 0.821             | 0.741 | 0.2 / 0.5 ms      |
| Hybrid (RRF)  | 0.881            | 0.742             | 0.897             | 0.815 | 5.1 / 6.8 ms      |
| Hybrid − BM25 | +0.058 (p 0.020) | +0.066 (p 0.0002) | +0.076 (p 0.0006) |       |                   |

- 95% bootstrap intervals for hybrid: nDCG@10 [0.700, 0.780], Recall@20 [0.846, 0.940].
- p-values are from a paired randomization test.
- Latency is measured over the whole search call, with single-threaded model inference, on an Intel
  Core Ultra 5 225 (`environment` in `data/report.json`).
- **Filter violations: 0** across 1,216 results of 43 constrained queries, checked by an
  implementation independent of the service (`src/constraints.ts`).
- **Constraint extraction**, against hand-labelled constraints (45 queries): network 15/16, type
  23/23, asset 13/14, price 14/15, with no spurious filters. 25 of 658 hybrid results miss a
  constraint the searcher stated but the parser did not recover.

Hybrid by query class, all splits (answerable queries):

| Class      | Queries | nDCG@10 BM25 → hybrid | Recall@20 BM25 → hybrid |
| ---------- | ------- | --------------------- | ----------------------- |
| intent     | 40      | 0.625 → 0.688         | 0.762 → 0.823           |
| paraphrase | 25      | 0.474 → 0.614         | 0.645 → 0.786           |
| keyword    | 30      | 0.699 → 0.737         | 0.834 → 0.905           |
| constraint | 20      | 0.749 → 0.805         | 0.900 → 0.917           |
| stellar    | 25      | 0.769 → 0.766         | 0.905 → 0.911           |
| mcp        | 16      | 0.799 → 0.853         | 0.953 → 0.984           |
| typo       | 12      | 0.664 → 0.776         | 0.772 → 0.835           |

## Filter conformance

Network, asset, scheme, recipient and price filters are each tested on their own, apart from the judged
dataset, by `src/conformance.ts`. It generates a catalog of 172 listings built to stress the filters:

- both networks, and the `exact` and `upto` schemes;
- recipients as a `G…` account, a muxed `M…` address on it, another `G…` account and a contract `C…`;
- assets with 6, 7 and 18 decimals, and one the service does not know;
- prices one base unit below, at and above each ceiling;
- listings whose options each satisfy part of a filter, which must never match the whole of it.

31 queries (5 network, 8 asset, 3 scheme, 7 recipient, 8 price) use the filters as parameters and as
query text, alone and combined. Each runs lexical-only and hybrid and is paged to the end with cursors.
An independent check compares the results both ways: a result, or a payment option shown in it, that breaks
a filter is a violation; a listing that satisfies every filter but is not returned is a miss.

| Filter    | Queries | Results checked | Violations | Missed |
| --------- | ------- | --------------- | ---------- | ------ |
| network   | 5       | 856             | 0          | 0      |
| asset     | 8       | 498             | 0          | 0      |
| scheme    | 3       | 448             | 0          | 0      |
| recipient | 7       | 560             | 0          | 0      |
| price     | 8       | 394             | 0          | 0      |

Results are counted over both modes. The gate fails on any violation or miss.

## The gate

`pnpm eval:check` fails when:

- test nDCG@10 or Recall@20 drops more than 0.02 below `data/baseline.json`;
- hybrid scores below BM25 on either metric, as measured now or as recorded in the baseline;
- any result violates an applied filter, or the filter-conformance run finds a violation or a miss;
- the dataset or the model changed without a re-baseline;
- `data/baseline.json` differs from the copy at the release tag it names (`search-eval-vX.Y.Z`), so a
  change cannot lower the bar by editing it.

A change that improves search re-baselines in a dedicated commit with
`pnpm eval --write-baseline search-eval-vX.Y.Z`, and that commit gets the new annotated tag. CI fetches tags
to check the baseline against it.

## Dataset

`data/` holds everything the harness reads:

- `corpus.jsonl`, `queries.jsonl`, `qrels.tsv` and `assets.json`;
- `judgments.jsonl`: both judges' grades for every pair;
- `manifest.json`, which records the SHA-256 of each file. The harness refuses to run on data that
  does not match it.

| Part       | Size                                                                              |
| ---------- | --------------------------------------------------------------------------------- |
| Listings   | 500: 4 public, 496 sample; 347 HTTP, 153 MCP; 302 pubnet and 248 testnet options  |
| Queries    | 202 in 8 classes, split evenly into dev and test; a typo query follows its source |
| Judgments  | 9,012 pairs, graded 0–3 by two judge sets                                         |
| Answerable | 168 queries with a listing graded ≥ 2; 34 without an answer                       |

### Corpus

**Public listings (4).** The corpus holds every resource in Rail402's hosted testnet catalog when the
dataset was built: the four resources of the public demo seller
(`apps/demo-seller`), ids `P001`–`P004`, `"source": "public"`, each with its `provenance` (catalog URL
and retrieval time). `src/build/public.ts --capture` read them with plain GET requests;
`construction/public/capture.json` keeps the raw pages' SHA-256 hashes, the facilitator version and every
item. A tool several owners declared is kept once, from its most trusted listing: the four other
`forecast` copies in the catalog were test listings from conformance runs.

**Other catalogs are not imported.** Rail402 does not harvest other facilitators' catalogs, whose
licensing and provenance it cannot vouch for, so services listed only elsewhere are not in the corpus.
The rest of the corpus is labelled sample listings.

**Sample listings (496)** are **synthetic, and labelled so** (`"source": "sample"`; the 461 web URLs use
hosts under the reserved `.example` domain, and the 35 `mcp://` URLs use the host `tool`). To keep the
corpus at 500, adding the public listings dropped four samples (`L004`, `L064`, `L353`, `L393`): listings
no judge graded above 0 for any query, and among those the ones the pooled systems returned least.

- **Category plan:** `construction/taxonomy.json` sets 15 categories and 107 capabilities, with
  target mixes of kind, network, asset, style and price.
- **Who wrote them:** six writers drafted listings from `construction/listing-writers.md`:
  - in their own words, never reusing the taxonomy's wording;
  - with competing providers, sibling endpoints and multi-tool MCP servers;
  - in four styles: sparse, sloppy, standard and detailed;
  - including 10 adversarial listings: keyword stuffing, near-clones and empty listings.
- **How drafts became listings:** `src/build/corpus.ts` produces each listing's discovery metadata
  with the stock `declareDiscoveryExtension` from `@x402/extensions`. It then catalogs the draft with
  Rail402's own `extractCandidate`, so the corpus is exactly what the catalog stores after a
  settlement.
- **Ids and payTo:** ids are assigned after a seeded shuffle. payTo is derived per provider.
- **Drafts are kept:** they live in `construction/drafts/`.

### Queries

Three writers worked from `construction/query-writers.md` and never saw the listings: they saw only
the taxonomy, and the listing drafts were being written in parallel.

- **Classes:**
  - intent (40), paraphrase (25), keyword (30);
  - constraint (30): hand-labelled `expected` constraints, some sent as API filters;
  - stellar (25): Stellar vocabulary;
  - mcp (20): precise tool operations;
  - no_answer (20): plausible needs just outside every capability;
  - typo (12): derived deterministically from other queries by `src/build/queries.ts`.
- **Split:** each written class is split 50/50 into dev and test with a fixed seed. A typo query goes
  wherever its source query went, so no dev query reappears, misspelled, in test.
- **Frozen first:** the corpus and queries were committed (`freeze the search evaluation corpus and
queries before judging`) before any system was run on them.

### Judgments

**Pooling.** A query's candidate pool is the union of what six systems return
(`src/build/pool.ts`):

- Rail402 hybrid and BM25;
- dense retrieval with no floor;
- dense retrieval over name and description only;
- an independent TF-IDF;
- every listing written for the query author's target capabilities.

Pools have 22 to 58 candidates. The four public listings are judged against every query rather than
pooled: 808 pairs, by two further judges per set with the same brief, each packet holding one query
and the four public listings in its own random order.

**Blind judging.** Two independent judge sets (brief in `construction/judges.md`) graded every pair.

- Each judge saw one query per packet, with candidates in its own random order.
- Packets carry no price, network or system of origin.
- The packets are generated by `src/build/pool.ts` and `src/build/public.ts`; the exact packets the judges
  read are archived in `construction/judging/packets.tar.gz`.

**Combining the sets.**

- Equal grades stand.
- Grades one apart take the lower.
- Grades two or more apart would go to an adjudicator. None did: the sets agreed exactly on 96.8% of
  pairs and within one grade on all of them.
- Quadratic-weighted kappa is 0.965; kappa on relevant (≥ 2) is 0.961.

**Constraints decided by code.** A listing that breaks a query's labelled constraints is graded 0 by
code, whatever the judges said: 214 grades were overridden this way.

**Independence audit.** `src/build/qrels.ts` refuses to assemble the judgments if both sets judged any
query identically, notes included.

## Limitations

- **Synthetic data.** The sample listings and the queries are synthetic. The corpus is diverse by
  construction, but it is not a sample of a real catalog.
- **No-answer handling is weak.** Search returned results for 33 of 34 unanswerable queries. It has
  no confidence threshold that yields an empty result. The no-answer class measures this.
- **Small classes.** With 12 to 40 queries per class, per-class differences under about 0.07 nDCG
  are within noise.
- **Assets.** The evaluation prices listings in USDC, EURC and XLM on both networks. A deployment's
  search knows the assets its facilitator accepts (USDC by default), which are the only assets its
  catalog can hold listings in.
