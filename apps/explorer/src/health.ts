import { createServer, type Server } from "node:http";
import type { Registry } from "prom-client";

export interface HealthSnapshot {
  readonly network: string;
  readonly epoch: string;
  readonly mode: "backfill" | "tail" | "idle";
  readonly lastLedger: number | null;
  readonly head: number | null;
  readonly error: string | null;
  readonly stopped: boolean;
}

/** `ok` in the tail within the lag limit; `degraded` while catching up; `stopped` after a failure. */
export function healthOf(snapshot: HealthSnapshot, maxLagLedgers: number) {
  const lag =
    snapshot.head === null || snapshot.lastLedger === null
      ? null
      : Math.max(0, snapshot.head - snapshot.lastLedger);
  const status = snapshot.stopped ? "stopped" : lag !== null && lag <= maxLagLedgers ? "ok" : "degraded";
  return { status, ...snapshot, lagLedgers: lag };
}

/** `/health` (JSON, 503 unless ok) and `/metrics` (Prometheus) on a private port. */
export function startHealthServer(options: {
  readonly host: string;
  readonly port: number;
  readonly registry: Registry;
  readonly snapshot: () => HealthSnapshot;
  readonly maxLagLedgers: number;
}): Promise<Server> {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (request.method !== "GET") {
      response.writeHead(405).end();
      return;
    }
    if (path === "/health") {
      const body = healthOf(options.snapshot(), options.maxLagLedgers);
      response
        .writeHead(body.status === "ok" ? 200 : 503, {
          "content-type": "application/json",
          "cache-control": "no-store",
        })
        .end(JSON.stringify(body));
      return;
    }
    if (path === "/metrics") {
      options.registry
        .metrics()
        .then((text) => response.writeHead(200, { "content-type": options.registry.contentType }).end(text))
        .catch(() => response.writeHead(500).end());
      return;
    }
    response.writeHead(404).end();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      resolve(server);
    });
  });
}
