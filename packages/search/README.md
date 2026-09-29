# @rail402.dev/search

Natural-language search over a Rail402 Bazaar catalog.

BM25F and local sentence embeddings (`all-MiniLM-L6-v2` on ONNX Runtime, pinned and hash-verified, downloaded on first use) fused with reciprocal rank fusion, with hard filters for network, asset, scheme, recipient and price, constraints read from the query text, and signed cursors. See [Search](https://docs.rail402.dev/bazaar/search).

```sh
npm install @rail402.dev/search
```

Part of [Rail402](https://github.com/tolgayayci/rail402), x402 payments and discovery for Stellar.
Documentation: [docs.rail402.dev](https://docs.rail402.dev). Requires Node.js 24.11 or later. Apache-2.0.
