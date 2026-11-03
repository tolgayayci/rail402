# Facilitator and upto contract registry

`testnet.json` and `pubnet.json` say which accounts belong to which facilitator, in which ledger range,
and which upto settlement contracts the indexing rules count. The format and its checks are in
`src/registry.ts`; how the rules use it is in [rules/v2.md](../rules/v2.md), section 6.

## What an entry needs

- **Public evidence, archived.** A URL anyone can read (a facilitator's `/supported` response, a
  deployment record, an operator's public statement, a ledger record), with a copy of exactly what it
  returned in `evidence/<sha256>.json` and that SHA-256 in the entry. Tests check every copy against its
  hash.
- **Third-party pages as extracts.** For an issue or a comment on someone else's page, the entry has
  `"kind": "extract"`: the archived file keeps only the URL, the page link, its date, the author's login
  and the statement that names the account, with `sourceSha256`, the SHA-256 of the full response it
  was quoted from. Tests check the extract against its own hash, the entry's URL and source hash, and
  that the statement names the account.
- **An epoch and a ledger range.** `validFromLedger` is the account's first transaction, or the first
  ledger its evidence covers; `validToLedger` is `null` while it is in use. One address belongs to at most
  one facilitator in any ledger.
- **For an upto contract, the WASM hash the chain shows.** Check it before adding the entry:
  `pnpm --filter @rail402.dev/explorer registry-check --pubnet-rpc <pubnet RPC URL>`.
- **For the hosted service, every account its `/supported` advertises.** Add new sponsor, channel and
  settlement authority accounts before they settle (at launch and at every rotation), then check:
  `pnpm --filter @rail402.dev/explorer registry-check --hosted-<testnet|pubnet> <service URL> --skip-wasm`.

## Changing it

Changes go through a reviewed pull request, and every change bumps `registryVersion`
(`YYYY-MM-DD.N`), which every indexed row records. A sponsor rotation closes the old range and adds a new
one; nothing is ever re-dated. Operators can ask for their accounts to be added, corrected or labelled
through an issue or a pull request with their evidence.

Only the hosted Rail402 service's accounts are tier `rail402`; a self-hosted Rail402 instance is listed,
if at all, as its operator's facilitator. The concluded beta's settlement contracts are listed with rule
`R-UPTO-BETA` and a range that ends at the beta's end; every settlement through them inside that range is
labelled beta history, whoever submitted it. The contracts cannot be changed and anyone can still call
them, so the closed range is what keeps later calls out of the beta's history. A beta contract may name
only a `rail402-beta` facilitator. A facilitator that also relays transactions other than x402 payments is
marked `sharedRelayer`, and its rows say so.
