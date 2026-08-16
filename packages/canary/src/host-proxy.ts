import http from "node:http";
import { X402Error } from "@rail402.dev/errors";

/**
 * A local reverse proxy that makes a loopback seller present a PUBLIC hostname.
 *
 * Why this exists: a production facilitator soft-drops any loopback / private / IP-literal
 * `resource.url` (SSRF hygiene — `bazaar_resource_url_not_public`), so it will never catalog a
 * `http://127.0.0.1:…` seller. The facilitator never *fetches* the seller, though — it catalogs the
 * `resource.url` the seller *declares*, which the stock `@x402` resource server derives from the
 * request's `Host` header. So a stock seller only needs the request it receives to carry a public
 * Host. This proxy forwards the buyer's request to the loopback seller with `Host` rewritten to a
 * synthetic public hostname.
 *
 * No DNS, no tunnel, no external service — fully offline and deterministic, unlike the cloudflared
 * quick tunnel this replaced. The declared identity stays a legitimately public hostname; only the
 * transport is shimmed, and the x402 buyer/seller logic is untouched.
 */
export interface HostProxy {
  /** Loopback URL the buyer connects to; the proxy rewrites Host before forwarding to the seller. */
  readonly url: string;
  close(): Promise<void>;
}

export async function startPublicHostProxy(
  sellerPort: number,
  publicHost: string,
): Promise<HostProxy> {
  const server = http.createServer((req, res) => {
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: sellerPort,
        method: req.method,
        path: req.url,
        // The one rewrite that matters: the seller derives its resource identity from this.
        headers: { ...req.headers, host: publicHost },
      },
      up => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new X402Error("canary_setup_failed", {
      reason: "the public-host proxy did not bind a TCP port",
    });
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>(resolve => {
        server.close(() => resolve());
      }),
  };
}
