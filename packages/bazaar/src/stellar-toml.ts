import type { IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { parse } from "smol-toml";
import { baseAccount } from "@rail402.dev/stellar";
import { safeLookup } from "./origin.ts";
import { isLoopbackHost } from "./url.ts";

export interface StellarTomlOptions {
  readonly timeoutMs?: number;
  /** Serve plain http from loopback hosts (conformance runs on a local network only). */
  readonly allowLoopback?: boolean;
}

export type StellarTomlResult =
  | { readonly ok: true; readonly accounts: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/** SEP-1 caps stellar.toml at 100 KB. */
const MAX_BYTES = 100 * 1024;
const USER_AGENT = "rail402-bazaar-stellar-toml/1 (+https://rail402.dev)";

/**
 * The Stellar accounts a domain claims in its SEP-1 `stellar.toml` (`ACCOUNTS`), read from
 * `https://<host>/.well-known/stellar.toml`. The same SSRF controls as origin checks apply: every DNS
 * answer must be public, redirects are not followed, and the response is capped in size and time.
 */
export function fetchStellarTomlAccounts(
  host: string,
  options: StellarTomlOptions = {},
): Promise<StellarTomlResult> {
  const hostname = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  const loopback = options.allowLoopback === true && isLoopbackHost(hostname);
  const url = new URL(`${loopback ? "http" : "https"}://${host}/.well-known/stellar.toml`);
  const timeoutMs = options.timeoutMs ?? 3_000;
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: StellarTomlResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const request = send(
      url,
      {
        method: "GET",
        headers: { accept: "text/plain", "user-agent": USER_AGENT },
        lookup: safeLookup(loopback),
        agent: false,
      },
      (response: IncomingMessage) => {
        if (response.statusCode !== 200) {
          response.resume();
          finish({ ok: false, reason: `stellar.toml answered HTTP ${String(response.statusCode ?? 0)}` });
          return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        response.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > MAX_BYTES) {
            response.destroy();
            finish({ ok: false, reason: "stellar.toml exceeds 100 KB" });
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", () => {
          finish({ ok: false, reason: "stellar.toml could not be read" });
        });
        response.on("end", () => {
          finish(accountsOf(Buffer.concat(chunks).toString("utf8")));
        });
      },
    );
    const timer = setTimeout(() => {
      request.destroy(new Error("timed out"));
      finish({ ok: false, reason: `no response within ${String(timeoutMs)} ms` });
    }, timeoutMs);
    request.on("error", (error: Error) => {
      finish({ ok: false, reason: error.message });
    });
    request.end();
  });
}

/** The valid G… and C… addresses in a stellar.toml's `ACCOUNTS`. */
export function accountsOf(toml: string): StellarTomlResult {
  let document: Record<string, unknown>;
  try {
    document = parse(toml);
  } catch {
    return { ok: false, reason: "stellar.toml is not valid TOML" };
  }
  const listed = document["ACCOUNTS"];
  if (!Array.isArray(listed)) return { ok: false, reason: "stellar.toml has no ACCOUNTS list" };
  const accounts = listed.filter(
    (entry): entry is string => typeof entry === "string" && baseAccount(entry) === entry,
  );
  return { ok: true, accounts };
}
