import type { CatalogEntry } from "../catalog/types.js";
import type { Judgment } from "./metrics.js";
import corpus from "./heldout-corpus.json" with { type: "json" };
import largeCorpus from "./heldout-corpus-large.json" with { type: "json" };
import broadJudgments from "./heldout-judgments-large.json" with { type: "json" };

/**
 * The held-out evaluation set: **real** resources, and queries written against them.
 *
 * ## Why the first judgment set was not enough
 *
 * `fixtures.ts` scores 100% on every metric, and it is worth exactly what that suggests: fifteen
 * resources I wrote myself, with a `serviceName` on every entry, tags on every entry, and a
 * description on every parameter. So twenty real entries were captured from the live CDP Bazaar
 * instead.
 *
 * ## ⚠️ And then twenty turned out to be far too few — in BOTH directions
 *
 * An earlier version of this comment reported, from that 20-entry sample:
 *
 * | Field | 20 real entries | **2000 real entries** |
 * |---|---|---|
 * | `serviceName` (ranker weight **3.0**) | 1/20 — 5% | **1749/2000 — 87%** |
 * | `tags` (weight **2.5**) | 1/20 — 5% | **1737/2000 — 87%** |
 * | per-parameter descriptions (weight 1.5) | 2/20 — 10% | **1359/2000 — 68%** |
 *
 * and concluded "the three fields the ranker leans on hardest barely exist in the wild". **That was
 * wrong.** The sample was one page of a catalog, sixteen of its twenty entries were siblings of a
 * single service that publishes neither field, and a conclusion about the ecosystem was drawn from
 * it. At n=2000 those fields are present on the large majority of entries.
 *
 * The lesson is not "the old number was unlucky". It is that a 20-row sample cannot support a claim
 * about a 15,000-row population, and the confident table above made it look like it could.
 *
 * ## What the distractors did to the score
 *
 * Every judgment below names an entry present in **both** corpora, so the identical queries can be
 * scored against 19 distractors or against 1,999:
 *
 * | | n=20 | **n=2000** |
 * |---|---|---|
 * | dev precision@1 | 100% | **30%** |
 * | dev MRR | 1.000 | **0.490** |
 * | locked precision@1 | 90% | **50%** |
 * | locked MRR | 0.950 | **0.653** |
 *
 * The 90% headline was mostly the corpus being small. Against a realistic catalog the ranker puts
 * the right resource first about half the time. That is the number to quote, and improving it is
 * real work rather than a tuning pass.
 *
 * ## What makes this set hard
 *
 * Sixteen of the twenty entries are siblings of one service — thin wrappers over Ethereum JSON-RPC
 * sharing a single vocabulary. Discriminating `erc20-balance` from `live-balance` from `allowance`
 * from `total-supply` is the actual retrieval problem in a real catalog, and fifteen well-separated
 * synthetic services never pose it. Their descriptions are also unedited, so they carry marketing,
 * pricing notes, RPC method names and catalog URLs — the noise a real ranker has to see through.
 *
 * ## The discipline
 *
 * Queries were written by reading each resource's purpose and phrasing a request an agent would
 * actually make, **before** measuring anything. They are then split into two slices by a fixed rule:
 *
 * - **`DEV`** — may be inspected and tuned against, like any development set.
 * - **`LOCKED`** — measured, never diagnosed. When a locked query fails I do not look at why, and I
 *   do not change the ranker in response to it.
 *
 * That discipline is self-enforced, and saying so is the point: a held-out set whose failures you
 * study is just a slower training set. Both slices are reported separately, always, so nobody
 * (including me) can quote the tuned number alone.
 */

export const HELD_OUT_CORPUS = corpus.entries as unknown as CatalogEntry[];

/**
 * The same twenty resources, plus 1,980 more real ones captured from the same live catalog.
 *
 * Every judgment below names an entry that is in BOTH corpora, so the identical queries can be
 * scored against 19 distractors or against 1,999. That difference is the measurement: at n=20 six
 * materially different field-weight configurations produced byte-identical metrics, which is not
 * evidence that weighting does not matter — it is evidence the instrument could not read it
 */
export const HELD_OUT_CORPUS_LARGE = largeCorpus.entries as unknown as CatalogEntry[];

/** Provenance, for the report header. */
export const HELD_OUT_SOURCE = {
  source: corpus.source,
  capturedTotal: corpus.capturedTotal,
  entries: corpus.entries.length,
};

const R = "https://api.onesource.io/api/chain";

/**
 * Development slice — inspectable, tunable.
 *
 * Deliberately the harder-looking half: if the ranker can be improved at all, this is where the
 * evidence for how should come from.
 */
export const HELD_OUT_DEV: Judgment[] = [
  {
    query: "how much of a token does this wallet hold",
    relevant: [`${R}/erc20-balance`, `${R}/live-balance`],
    note: "Two genuinely relevant siblings. The ERC20-specific one should lead a combined-balance endpoint.",
  },
  {
    query: "what is the current gas price on ethereum",
    relevant: [`${R}/network-info`],
    note: "Gas price is one of three things network-info returns; the word appears once, in a parenthetical.",
  },
  {
    query: "did my transaction succeed or fail",
    relevant: [`${R}/receipt/:hash`, `${R}/tx/:hash`],
    note: "Status lives on the receipt. The transaction-details sibling is related but secondary.",
  },
  {
    query: "is this address a smart contract or a normal wallet",
    relevant: [`${R}/code/:address`, `${R}/contract/:address`],
    note: "The phrasing shares no term with 'eth_getCode'; only the description bridges it.",
  },
  {
    query: "which NFTs does this wallet own in a collection",
    relevant: [`${R}/erc721-tokens`],
    note: "Must beat nft-metadata, which is about one token rather than a wallet's holdings.",
  },
  {
    query: "resolve a .eth name to an address",
    relevant: [`${R}/ens/:input`],
  },
  {
    query: "how many tokens has an owner approved a spender to move",
    relevant: [`${R}/allowance`],
    note: "The one query where the vocabulary is genuinely distinctive. It should be easy; if it is not, something is badly wrong.",
  },
  {
    query: "search the web and summarise an answer",
    relevant: ["https://x402.tavily.com/search"],
    note: "Description is two words — 'Tavily Search - advanced mode'. Almost all signal is in the URL and parameter names.",
  },
  {
    query: "estimate what a transaction will cost before sending it",
    relevant: [`${R}/estimate-gas`],
  },
  {
    query: "find messages in a mailbox matching a term",
    relevant: ["https://mail.cusethejuice.com/admin-api/machine/mailboxes/:email/search"],
    note: "Its description is heavily keyword-stuffed with payment and protocol trivia. Tests that noise does not drown the actual capability.",
  },
];

/**
 * Locked slice — measured, never diagnosed.
 *
 * If one of these fails, that failure is reported and left alone.
 */
export const HELD_OUT_LOCKED: Judgment[] = [
  {
    query: "what is the latest block height",
    relevant: [`${R}/block-number`],
  },
  {
    query: "get a block and its transactions by number",
    relevant: [`${R}/block/:number`],
  },
  {
    query: "next nonce for an account sending a transaction",
    relevant: [`${R}/nonce/:address`],
  },
  {
    query: "who transferred a token to whom",
    relevant: [`${R}/erc20-transfers`],
  },
  {
    query: "total number of tokens ever issued by a contract",
    relevant: [`${R}/total-supply`],
  },
  {
    query: "image and traits for a single NFT",
    relevant: [`${R}/nft-metadata`],
  },
  {
    query: "read a value from a contract without sending a transaction",
    relevant: [`${R}/call`],
  },
  {
    query: "symbol and decimals of a token contract",
    relevant: [`${R}/contract/:address`],
  },
  {
    query: "full details of one transaction including its calldata",
    relevant: [`${R}/tx/:hash`],
  },
  {
    query: "ether balance of an address",
    relevant: [`${R}/live-balance`, `${R}/erc20-balance`],
  },
];

/**
 * The broad held-out set — 107 blind, explicitly-graded judgments spanning ~67 distinct hosts and
 * ~80 services across the 2000-resource corpus (geocoding, weather, price feeds, token/NFT data,
 * search, identity, media, and deliberate sibling-discrimination pairs).
 *
 * This is the set the note at the bottom of this file asked for — "100+ queries written blind against
 * the large corpus". Twenty judgments over 2000 documents is a wide task measured with a narrow
 * ruler; 107 is wide enough that a field-weight or ranker change is measurable rather than lost in
 * the noise of ten queries. Scored ONLY against the 2000-document corpus (its keys are large-corpus
 * resources), split dev/locked by a hash of the query so neither slice is the easy half. 75/107 are
 * "hard" (low query↔answer vocabulary overlap or same-host siblings that must be ordered); 27 share
 * zero content tokens with their best answer. Grades are explicit (3/2/1) and judge-assigned — where
 * two vendors do the identical thing both are graded as genuine siblings rather than invented into an
 * ordering. Every key was verified present in the corpus.
 *
 * Caveat carried from the corpus: all 2000 entries are `type:"http"`, so there are no MCP tools to
 * judge — ranking over MCP resources remains unmeasured by this set (Phase 3 adds MCP coverage).
 */
export const HELD_OUT_BROAD_DEV = broadJudgments.dev as unknown as Judgment[];
export const HELD_OUT_BROAD_LOCKED = broadJudgments.locked as unknown as Judgment[];

/**
 * Floors for the held-out slices.
 *
 * Set from the FIRST measured run rather than from ambition, so they are a regression guard and not
 * a target nobody has hit. Raise them when the ranker genuinely improves; never lower one to make a
 * build pass without recording why in this comment.
 *
 * They are deliberately far below the synthetic set's floors. That gap is the honest statement of
 * how much of that 100% was the corpus rather than the ranker.
 */
export const HELD_OUT_THRESHOLDS = {
  precisionAt1: 0.8,
  recallAt5: 0.9,
  mrr: 0.85,
  ndcgAt10: 0.9,
  zeroResultRate: 0.0,
} as const;

/**
 * Floors for the 2000-document sets, set from the FIRST measurement and slightly below it.
 *
 * Deliberately unambitious, for the same reason as the small-corpus floors: these are a regression
 * guard, not a target. A change that drops locked MRR below 0.60 has made retrieval worse on
 * realistic data and should fail the build even if it looks better on the twenty-document set.
 */
export const HELD_OUT_LARGE_THRESHOLDS = {
  // Re-baselined 2026-08-05 when retrieval became HYBRID (BM25 + static-embedding RRF). This narrow
  // set is 16 near-identical ERC20 siblings — pure lexical discrimination, the ONE case where static
  // embeddings are a known liability (they place `allowance` and `balance` near each other), so the
  // hybrid trades some recall HERE for a large, decisive gain on the realistic broad set (broad nDCG
  // dev 0.519 -> 0.641). A documented, net-positive tradeoff, not a masked regression: the narrow
  // LOCKED slice actually improved sharply (p@1 50% -> 80%, nDCG 0.701 -> 0.822); only the narrow DEV
  // slice fell (recall@5 0.60, MRR 0.433, nDCG 0.482), and these floors sit just under it. Prior BM25
  // baseline for the record: dev 30% / r@5 0.75 / MRR 0.490 / nDCG 0.562.
  precisionAt1: 0.25,
  recallAt5: 0.55,
  mrr: 0.4,
  ndcgAt10: 0.45,
  zeroResultRate: 0.0,
} as const;

/**
 * Floors for the broad set (107 judgments over 2000 documents), set under the worse of the two
 * slices from the FIRST measurement (2026-08-05) and slightly below it — a regression guard, never a
 * target, and never lowered to make a build pass without recording why here.
 *
 * First measurement, explicit-grade metric:
 *
 * | | broad dev (52) | broad locked (55) |
 * |---|---|---|
 * | precision@1 | 44.2% | 41.8% |
 * | recall@5 | 50.2% | 53.2% |
 * | MRR | 0.533 | 0.504 |
 * | nDCG@10 | 0.519 | 0.505 |
 * | zero-result | 0% | 0% |
 *
 * The two slices agreeing to within ~3 points is the useful part: the split is fair (neither is the
 * easy half), and the ranker's real behaviour on a wide, hard, realistic set is ~42-44% right-first,
 * MRR ~0.5. That is the number to improve — and with 107 judgments an improvement is measurable
 * rather than lost in the noise of ten queries. `precision@5` is structurally capped near 20% for the
 * 59 single-answer judgments, so it is deliberately not floored here.
 */
export const HELD_OUT_BROAD_THRESHOLDS = {
  // RAISED 2026-08-05 to lock in the hybrid-retrieval gain, under the worse of the two slices. Hybrid
  // measurement: dev p@1 51.9% / r@5 65.7% / MRR 0.655 / nDCG 0.641; locked p@1 43.6% / r@5 62.3% /
  // MRR 0.554 / nDCG 0.575 (the BM25 first-measurement baseline in the block above was dev nDCG 0.519
  // / locked 0.505). The per-query sign test over all 107 broad judgments is p ≈ 0.003 (40 better, 17 worse, 50 EXACT TIES — the hybrid changes nothing on half the set), so the gain
  // is real, not noise. Never lowered to make a build pass without recording why here.
  precisionAt1: 0.4,
  recallAt5: 0.58,
  mrr: 0.52,
  ndcgAt10: 0.55,
  zeroResultRate: 0.0,
} as const;

/**
 * What was actually measured, 2026-07-31, and what it cost.
 *
 * First run, before any change:
 *
 * | | dev | locked |
 * |---|---|---|
 * | precision@1 | 90% | 90% |
 * | MRR | 0.933 | 0.950 |
 * | nDCG@10 | 0.936 | 0.963 |
 * | zero-result | 0% | 0% |
 *
 * Two changes followed, both diagnosed from the **dev** slice only:
 *
 * 1. **Conversational filler added to the stop list.** "how much of a token does this wallet hold"
 *    returned the *allowance* endpoint, whose description contains the phrase "how much". Because
 *    "much" is rare in the corpus its IDF is high, so one meaningless rare word outweighed two
 *    meaningful common ones. Hand-written keyword-ish queries never expose this; natural language
 *    is full of it.
 * 2. **`balance → hold` added to the index-time synonym map.** A pure lexical ranker cannot cross
 *    from "what does this wallet hold" to a description saying "token balance", and that is the
 *    single most common phrasing of the question.
 *
 * After both: **dev 100%** precision@1, MRR 1.000. **Locked: unchanged, 90% and 0.950.**
 *
 * That last sentence is the useful one. Tuning against the dev slice bought ten points on the dev
 * slice and *nothing* on held-out data — which is what tuning against a small set usually buys, and
 * why the two numbers are reported separately and always will be.
 *
 * The remaining locked failure is known to exist and has deliberately not been diagnosed.
 *
 * ## The field-weight ablation, re-run at n=2000
 *
 * At n=20, six materially different weightings produced **byte-identical** metrics — which looked
 * like evidence that field weighting does nothing and was really evidence that the instrument could
 * not read it. At n=2000 the same ablation separates:
 *
 * | Weighting | dev p@1 / MRR | locked p@1 / MRR |
 * |---|---|---|
 * | shipped (3.0 / 2.5 / 2.0 / 1.5 / 1.0) | 30% / 0.490 | 50% / 0.653 |
 * | flat (everything 1.0) | 30% / 0.451 | 50% / 0.650 |
 * | description-led | 30% / 0.483 | 60% / 0.717 |
 * | url-heavy | 30% / 0.439 | 60% / 0.717 |
 * | params-led | **40% / 0.510** | 50% / 0.633 |
 * | extreme serviceName/tags | 30% / 0.470 | 60% / 0.683 |
 *
 * Two things follow, and the second is the one that takes discipline.
 *
 * 1. **Weighting matters after all**, and the shipped weights beat flat — modestly, on MRR.
 * 2. **Nothing here has been changed in response.** Several variants beat the shipped weights on
 *    the *locked* slice. Picking one because of that would convert the held-out set into a training
 *    set in a single commit, and the whole value of these numbers is that nobody optimised against
 *    them. The dev slice does favour `params-led`, but on ten queries one flip is ten points, which
 *    is the same small-sample trap this file has now fallen into once already.
 *
 * **The bottleneck is no longer the corpus, it is the judgments.** Twenty judgments over 2000
 * documents is a wide task measured with a narrow ruler. The next honest step is 100+ queries
 * written blind against the large corpus — then tune on dev, report on locked, and only then ask
 * whether a vector component earns its keep.
 */
