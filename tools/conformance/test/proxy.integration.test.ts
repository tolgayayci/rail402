/**
 * The committed proxy example (deploy/proxy/Caddyfile.example) in a real Caddy in front of two stand-in
 * replicas: one replica is stopped while requests keep arriving, and none fails; no log line, of a
 * request answered or of one no replica could answer, holds the API key or a payment header. Needs
 * Docker; every container and network is named for this run and removed afterwards.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/evidence.ts";

const CADDY = "caddy:2.11.6-alpine@sha256:d44355d3c2149dc580ce2cac735955d1c08d3d00882c30489c241aa51a5c10d9";
const NODE =
  "node:24.19.0-trixie-slim@sha256:ab3eebe934147fee049b5eb83c570f68c849a13c930bdfa482de99fcdfa3b3de";
const run = randomBytes(4).toString("hex");
const network = `rail402-proxy-test-${run}`;
const names = { a: `facilitator-a-${run}`, b: `facilitator-b-${run}`, caddy: `rail402-proxy-${run}` };
const API_KEY = `key-${randomBytes(12).toString("hex")}`;
const PAYMENT = `payment-${randomBytes(12).toString("hex")}`;

const docker = (...args: string[]) =>
  execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** Everything Caddy wrote: the access log goes to stdout, its other logs to stderr. */
function caddyOutput(): string {
  const logs = spawnSync("docker", ["logs", names.caddy], { encoding: "utf8" });
  if (logs.status !== 0) throw new Error(`docker logs failed: ${logs.stderr}`);
  return logs.stdout + logs.stderr;
}

/**
 * A stand-in replica: /ready answers 200, /partial promises 1000 bytes and drops the connection after 10,
 * every other path names the replica; SIGTERM drains, then exits.
 */
const REPLICA = `
const http = require("node:http");
const server = http.createServer((req, res) => {
  if (req.url === "/partial") {
    res.writeHead(200, { "content-type": "text/plain", "content-length": "1000" });
    res.write("0123456789");
    setTimeout(() => req.socket.destroy(), 50);
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end(req.url === "/ready" ? "ready" : process.env.NAME);
});
server.listen(8080);
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`;

function startReplica(name: string, alias: string): void {
  docker(
    "run",
    "-d",
    "--name",
    name,
    "--network",
    network,
    "--network-alias",
    alias,
    "-e",
    `NAME=${alias}`,
    NODE,
    "node",
    "-e",
    REPLICA,
  );
}

let port = 0;

interface Credentials {
  readonly key: string;
  readonly payment: string;
}

/** Credentials only one test sends, so a leak points at that test's request. */
const credentialsFor = (name: string): Credentials => ({
  key: `key-${name}-${randomBytes(8).toString("hex")}`,
  payment: `payment-${name}-${randomBytes(8).toString("hex")}`,
});

/**
 * A request with a Host header (fetch does not let a caller set one), the API key and both payment
 * headers. A response cut off mid-body resolves with what arrived.
 */
function get(
  path = "/supported",
  host = "testnet.example.com",
  credentials: Credentials = { key: API_KEY, payment: PAYMENT },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        headers: {
          host,
          "x-api-key": credentials.key,
          "payment-signature": credentials.payment,
          "x-payment": credentials.payment,
          // The Playground relay forwards a buyer's payment to the seller under this name.
          "x-relay-h-payment-signature": credentials.payment,
        },
      },
      (response) => {
        let body = "";
        const done = () => {
          resolve({ status: response.statusCode ?? 0, body });
        };
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", done);
        response.on("close", done);
      },
    );
    request.on("error", reject);
    request.end();
  });
}

/** Caddy's output a moment after a request: some entries are written once the response is over. */
async function outputAfterRequest(): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, 500));
  return caddyOutput();
}

describe("the proxy example in front of two replicas", () => {
  beforeAll(async () => {
    docker("network", "create", network);
    startReplica(names.a, "facilitator-a");
    startReplica(names.b, "facilitator-b");
    // The example as committed, with the sites served over plain HTTP for the test.
    const directory = mkdtempSync(join(tmpdir(), "rail402-proxy-"));
    const caddyfile = readFileSync(join(REPO_ROOT, "deploy/proxy/Caddyfile.example"), "utf8")
      .replace(/^testnet\.example\.com \{/m, "http://testnet.example.com {")
      .replace(/^mainnet\.example\.com \{/m, "http://mainnet.example.com {");
    writeFileSync(join(directory, "Caddyfile"), caddyfile);
    docker(
      "run",
      "-d",
      "--name",
      names.caddy,
      "--network",
      network,
      "-p",
      "127.0.0.1::80",
      "-v",
      `${directory}:/etc/caddy:ro`,
      CADDY,
    );
    port = Number(docker("port", names.caddy, "80/tcp").split(":").at(-1));
    // Wait until both replicas are healthy behind the proxy.
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const seen = new Set<string>();
      for (let i = 0; i < 6; i += 1) {
        try {
          const answer = await get();
          if (answer.status === 200) seen.add(answer.body);
        } catch {
          // Caddy is still starting.
        }
      }
      if (seen.size === 2) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("the proxy never reached both replicas");
  }, 120_000);

  afterAll(() => {
    for (const name of Object.values(names)) {
      try {
        docker("rm", "-f", name);
      } catch {
        // already gone
      }
    }
    try {
      docker("network", "rm", network);
    } catch {
      // already gone
    }
  });

  it("serves every request while one replica restarts", async () => {
    const results: number[] = [];
    const state = { running: true };
    const load = (async () => {
      while (state.running) {
        results.push((await get()).status);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })();
    docker("stop", "--time", "10", names.a);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    docker("start", names.a);
    // The restarted replica returns to rotation once its /ready answers.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if ((await get()).body === "facilitator-a") break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    state.running = false;
    await load;
    expect(results.length).toBeGreaterThan(5);
    expect(results.filter((status) => status !== 200)).toEqual([]);
  }, 120_000);

  it("keeps the API key and the payment headers out of the access log", () => {
    const combined = caddyOutput();
    expect(combined).toContain('"uri":"/supported"');
    expect(combined).not.toContain(API_KEY);
    expect(combined).not.toContain(PAYMENT);
  });

  it("keeps them out of the log of a response a replica cut off", async () => {
    // reverse_proxy reports a body it could not finish on its own logger, with the request's headers.
    const credentials = credentialsFor("partial");
    const answer = await get("/partial", "testnet.example.com", credentials);
    expect(answer.status).toBe(200);
    expect(answer.body.length).toBeLessThan(1000);
    const combined = await outputAfterRequest();
    expect(combined).toContain("aborting with incomplete response");
    expect(combined).not.toContain(credentials.key);
    expect(combined).not.toContain(credentials.payment);
  });

  it("keeps them out of the log of a request whose Host differs in case", async () => {
    // The site matches the host without case, but its access log is chosen by the exact host name.
    const credentials = credentialsFor("host-case");
    const answer = await get("/supported", "TESTNET.Example.COM", credentials);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatch(/^facilitator-[ab]$/);
    const combined = await outputAfterRequest();
    expect(combined).toContain('"host":"TESTNET.Example.COM"');
    expect(combined).not.toContain(credentials.key);
    expect(combined).not.toContain(credentials.payment);
  });

  it("answers a host no site claims with 404 and keeps its credentials out of the log", async () => {
    const credentials = credentialsFor("unknown-host");
    const answer = await get("/settle", "unknown.example.net", credentials);
    expect(answer.status).toBe(404);
    const combined = await outputAfterRequest();
    expect(combined).not.toContain(credentials.key);
    expect(combined).not.toContain(credentials.payment);
  });

  it("keeps them out of the log of a request no replica could answer", async () => {
    // With both replicas gone the request fails after lb_try_duration, and Caddy logs the failure with
    // the request's headers as a handler error, apart from the access log.
    docker("kill", names.a, names.b);
    const answer = await get("/settle");
    expect(answer.status).toBeGreaterThanOrEqual(500);
    const combined = caddyOutput();
    expect(combined).toMatch(/"logger":"http\.log\.error[".]/);
    expect(combined).not.toContain(API_KEY);
    expect(combined).not.toContain(PAYMENT);
  }, 60_000);
});
