/**
 * Temporary holding page for rail402.dev, until the real landing page ships.
 *
 * Deliberately a SEPARATE Worker from the facilitator, with zero imports and no bundler work, so it
 * cannot cold-start badly. This matters: the facilitator bundles to ~2.6 MB and its FIRST request
 * after idle returns Cloudflare error 1104 (measured: 10/10 succeed warm, the first after idle
 * fails). A reviewer clicking a link in a submission is, by definition, the first visitor after
 * idle, so redirecting the apex straight at the facilitator would break the one click that matters.
 *
 * REMOVE THIS as soon as the real landing page is live: `npx wrangler@4 delete` from this
 * directory. While it exists the route intercepts ALL apex traffic, so a landing page deployed to
 * rail402.dev will not be reachable until it is gone.
 */
const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rail402 — x402 facilitator and discovery layer for Stellar</title>
<style>
:root{color-scheme:light dark}
body{font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;max-width:46rem;margin:0 auto;padding:3rem 1.5rem}
h1{font-size:1.5rem;line-height:1.25;margin:0 0 .5rem}
p{margin:0 0 1.25rem;opacity:.85}
h2{font-size:.8rem;text-transform:uppercase;letter-spacing:.08em;opacity:.6;margin:2rem 0 .75rem}
ul{padding-left:1.1rem;margin:0}li{margin-bottom:.5rem}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}
small{opacity:.6}
</style></head><body>
<h1>Rail402</h1>
<p>An open-source x402 facilitator for Stellar, and the first Stellar-native Bazaar:
the discovery layer that lets AI agents find and pay for Stellar services automatically.
Settling real payments on testnet today.</p>

<h2>Upstream contributions</h2>
<ul>
<li><a href="https://github.com/stellar/stellar-docs/pull/2718">Merged into Stellar's official docs</a></li>
<li><a href="https://github.com/x402-foundation/x402/pull/3018">Fixed a bug blocking <code>__check_auth</code> contract accounts on Stellar, upstream in the x402 package</a></li>
<li><a href="https://github.com/stellar/x402-stellar/issues/71">Proposed <code>upto</code> scheme support for Stellar</a></li>
<li><a href="https://github.com/stellar/x402-stellar/issues/72">Authored the <code>exact</code> + <code>upto</code> design discussion with SDF engineers</a></li>
</ul>

<h2>Working on testnet</h2>
<ul>
<li><a href="https://facilitator.rail402.dev/supported">Live facilitator <code>/supported</code></a> <small>(first load after idle can be slow)</small></li>
<li><a href="https://stellar.expert/explorer/testnet/tx/ad015d7fdc535d2830bdf3e5c05109e805ce1ba09a242e9abd9b379624fce978"><code>upto</code> settling 750,000 of a 2,000,000 ceiling, from a smart account</a></li>
<li><a href="https://stellar.expert/explorer/testnet/tx/9733b83aad41bef8e704cf3a3f5b6752f43b6105f919fc04a6f637c36d3d2c96">The unspent budget released back on-ledger by a Soroban contract</a></li>
<li><a href="https://stellar.expert/explorer/testnet/tx/820d31908a6dec7c3012ad5badc475ce55e023f7e9e35c7e1fc8b7f219859592"><code>exact</code> paid by a <code>__check_auth</code> contract account</a></li>
</ul>

<p><small>Full site shortly.</small></p>
</body></html>`;

// The ecosystem report is a ~900KB static page. Serve it from the explorer's static host by proxy
// rather than embedding it here — a large inline string would risk the exact cold-start failure
// (error 1104 on the first request after idle) this Worker exists to avoid.
const REPORT_URL = "https://explorer.rail402.dev/reports/state-of-x402-2026-08.html";

export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/ecosystem" || pathname === "/ecosystem/") {
      const upstream = await fetch(REPORT_URL, { cf: { cacheTtl: 300, cacheEverything: true } });
      return new Response(upstream.body, {
        status: upstream.ok ? 200 : 502,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, max-age=300",
        },
      });
    }
    return new Response(HTML, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        // Short cache only. This page is about to be replaced, and a long TTL would outlive it.
        "cache-control": "public, max-age=60",
      },
    });
  },
};
