# Changelog

## 0.2.0

The first release of Rail402 from this repository. Earlier `@rail402.dev` packages on npm (0.1.x) came from a
prototype with a different API and are deprecated.

### Facilitator

- `/supported`, `/verify` and `/settle` for the x402 v2 `exact` scheme on `stellar:testnet`, built on the
  unmodified `@x402/stellar` 2.27.0 scheme; `stellar:pubnet` is configurable.
- Fees are sponsored through channel accounts derived from one sponsor key; the facilitator is never the source
  of a payment.
- `G…` and `C…` payers and recipients, SEP-41 amounts, trustline and balance checks, expiry, tampering and
  replay protection, with a stable code and reason for every rejection.
- Idempotent, crash-safe settlement with a Postgres ledger, and reconciliation of pending settlements.
- API keys, per-caller metering, a configurable service fee and Postgres-backed rate limits.

### Bazaar

- Cataloging of HTTP endpoints and MCP tools from settled payments that carry the `bazaar` extension, bound to
  the settled `payTo`, confirmed against the resource's own 402 and, where the domain's SEP-1 `stellar.toml`
  lists the owner, marked `domain_verified`.
- `GET /discovery/resources` with filters, stable pagination and a public version history per listing; one
  resource sold on several networks is one item.
- `GET /discovery/search`: BM25F and local embeddings fused with RRF, hard filters, constraints read from the
  query text, signed cursors.

### Tooling

- One-command deploys with Docker (`deploy/docker.sh`) and Railway (`deploy/railway.sh`); a container image on
  GHCR for every version tag.
- Packages on npm: `@rail402.dev/facilitator`, `bazaar`, `search`, `store-postgres`, `stellar`, `errors`.
- A reproducible search evaluation (`pnpm eval`) with a CI gate, and conformance runs against a live
  facilitator.
