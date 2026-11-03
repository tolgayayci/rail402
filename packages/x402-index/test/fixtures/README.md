# Test fixtures

Real Stellar data, read from the public data lake (`s3://aws-public-blockchain/v1.1/stellar/ledgers/`),
which publishes one zstd-compressed `LedgerCloseMetaBatch` per ledger.

- `ledgers/testnet/<sequence>.xdr.zst`: the objects for testnet ledgers 5,330,305 to 5,330,320 and
  5,330,787 to 5,330,791 (epoch `2025-12-17`, folder `testnet/2025-12-18`), byte for byte as published.
  They contain the hosted Rail402 `exact` settlement `2cc59d87…`, its `upto` settlement `336ef628…` and
  two x402.org settlements, `5543871a…` and `a8bced02…`, next to ordinary traffic.
- `ledgers/testnet-beta/<sequence>.xdr.zst`: testnet ledgers 3,912,565 and 3,953,878, holding the concluded
  beta's `upto` settlements `5ec8b20c…` (contract `CBHDZLYA…`) and `b38c1add…` (contract `CCMM3FMG…`).
- `transactions.json`: single transactions (envelope, result and meta as base64 XDR, with ledger,
  application order and close time) extracted from those objects and from testnet ledger 5,189,151 and
  pubnet ledgers 63,985,581 and 63,985,589.

Hostile cases are built in the tests by editing these transactions, so every negative starts from a real
settlement.
