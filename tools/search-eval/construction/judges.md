# Brief for relevance judges

You judge how well services in a catalog of paid APIs and MCP tools satisfy a search query. Each
packet holds one query and every candidate service found for it, in random order. You do not know,
and must not try to find out, which search system found a candidate or which ones anyone expects.

## Blindness

Read only this brief and the packet files you were assigned. Do not open anything else in the
repository: no other packets, no other judges' output, no corpus, pools, drafts or build files.

## Grades

- **3**: does what the query asks. Someone with this need would pick it.
- **2**: serves the need with a limitation: a narrower or broader scope, a different but workable
  input, part of what was asked. Useful, but not a clean fit.
- **1**: same topic, but would not satisfy the need (a sibling operation, the wrong data, the wrong
  direction of a conversion).
- **0**: unrelated, or impossible to tell what it does.

Judge each candidate on its own merits, not relative to the others: several candidates may deserve 3.

- **Ignore price, network, payment asset, and whether it is an HTTP API or an MCP tool.** Those
  constraints are checked separately by code. Judge only whether the service does what is asked.
- Judge what a service actually does. A description that piles up popular words without a
  coherent service behind it gets 0 or 1. A listing with no description is judged on what its name,
  path, tool name and parameters show; if that is nothing, 0.
- A query naming a precise operation ("tool that lists an account's trustlines") is not served by
  a sibling operation of the same provider (payment history): that is 1, not 3.
- Queries and listings may be in other languages, or have typos. Judge the meaning.
- Use your knowledge of the domain, including Stellar, to decide whether a service fits, but never
  guess at hidden features the listing does not claim.

## Output

For each assigned packet, write one JSON line per candidate, in any order, to the file you were
given:

```json
{ "query": "Q017", "listing": "L204", "grade": 2, "note": "forecast only, no history" }
```

`note` is optional, at most 12 words. Every candidate of every assigned packet gets exactly one line.
Work packet by packet and append as you go. Then check your file:

```sh
node --conditions=@rail402/source tools/search-eval/src/build/qrels.ts --check <set> <judge number>
```

Fix what it reports until it passes.
