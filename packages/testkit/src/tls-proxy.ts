import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";

const CORS = { "access-control-allow-origin": "*" } as const;

export interface TlsRpcProxy {
  /** https://localhost:<port>, trusted by this process once `trust()` ran. */
  readonly url: string;
  /** The proxy's self-signed certificate (PEM). */
  readonly certificate: string;
  /** Adds the certificate to this process's default CA list, so clients without options accept it. */
  trust(): void;
  close(): Promise<void>;
}

/**
 * An https front for a plain-http Stellar RPC, with a throwaway self-signed certificate for
 * localhost. The upstream x402 Stellar client only reaches an RPC over https (it cannot set
 * `allowHttp`), so tests run the unmodified client against the local network through this proxy.
 * Like the public RPCs it answers CORS for any origin, so a page in a browser can call it too.
 * Needs the `openssl` command.
 */
export async function startTlsRpcProxy(target: string): Promise<TlsRpcProxy> {
  const directory = mkdtempSync(join(tmpdir(), "rail402-tls-"));
  let key: Buffer;
  let certificate: string;
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-keyout",
        join(directory, "key.pem"),
        "-out",
        join(directory, "cert.pem"),
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
    key = readFileSync(join(directory, "key.pem"));
    certificate = readFileSync(join(directory, "cert.pem"), "utf8");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  const server: Server = createServer({ key, cert: certificate }, (request, response) => {
    if (request.method === "OPTIONS") {
      response
        .writeHead(204, {
          ...CORS,
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": request.headers["access-control-request-headers"] ?? "*",
          "access-control-max-age": "600",
        })
        .end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      void (async () => {
        try {
          const upstream = await fetch(target, {
            method: request.method ?? "POST",
            headers: { "content-type": "application/json" },
            ...(request.method === "GET" ? {} : { body: Buffer.concat(chunks) }),
          });
          response
            .writeHead(upstream.status, {
              ...CORS,
              "content-type": upstream.headers.get("content-type") ?? "application/json",
            })
            .end(Buffer.from(await upstream.arrayBuffer()));
        } catch (error) {
          response.writeHead(502, CORS).end(String(error));
        }
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `https://localhost:${String(port)}`,
    certificate,
    trust() {
      tls.setDefaultCACertificates([...tls.getCACertificates("default"), certificate]);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
