# @rail402.dev/safe-fetch

Outbound HTTP for URLs that come from untrusted input, such as a resource URL an AI agent picked or a seller's origin.

`createSafeFetch()` returns a fetch-compatible function built on `node:http(s)`, with no third-party dependencies (only `@rail402.dev/errors`, which has none). It returns a native `Response`, or rejects with an `EgressError` that carries a stable `code`, a `stage` and a non-empty `reason`:

- https only on port 443 by default; http (port 80) only when enabled.
- The URL is checked before any DNS lookup. IP literals are classified here, in every spelling, because Node does not call a custom `lookup` for them.
- Private, loopback, link-local, carrier-grade NAT, cloud metadata, documentation, NAT64, 6to4 and IPv4-mapped addresses are refused. `allowPrivateNetwork: "loopback"` admits this machine only, for local development.
- DNS answers are checked when connecting and the socket dials only validated addresses; a host with any private address is refused whole. The connected address is checked again. Environment proxies are never used.
- Redirects are refused unless a request opts into `redirect: "same-origin"`, which follows up to 3 hops on the same host and port.
- Request headers and bodies, response headers and decoded response bodies (gzip, deflate, br) are capped. Connect, header, idle and total timeouts apply.
- Errors never repeat a resolved address.

```ts
import { createSafeFetch } from "@rail402.dev/safe-fetch";

const safeFetch = createSafeFetch();
const response = await safeFetch("https://api.example.com/weather?city=Paris");
```

```sh
npm install @rail402.dev/safe-fetch
```

Part of [Rail402](https://github.com/tolgayayci/rail402), x402 payments and discovery for Stellar.
Documentation: [docs.rail402.dev](https://docs.rail402.dev). Requires Node.js 24.11 or later. Apache-2.0.
