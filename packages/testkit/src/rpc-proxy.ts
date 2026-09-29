import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface RpcProxy {
  readonly url: string;
  /** Every `sendTransaction` envelope (base64 XDR) that passed through, in order. */
  readonly sent: string[];
  /**
   * When true, `sendTransaction` is forwarded to the network but the caller receives HTTP 502, as if
   * the connection dropped after broadcast. Models a crash or timeout after submission.
   */
  loseSendResponses: boolean;
  /** When true, `getTransaction` answers NOT_FOUND, as if confirmation were slow. */
  hideTransactions: boolean;
  close(): Promise<void>;
}

/** A JSON-RPC proxy in front of a Stellar RPC, for fault-injection tests. */
export async function startRpcProxy(target: string): Promise<RpcProxy> {
  const sent: string[] = [];
  const proxy = { loseSendResponses: false, hideTransactions: false };

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      void (async () => {
        const body = Buffer.concat(chunks).toString("utf8");
        let method: string | undefined;
        try {
          const parsed = JSON.parse(body) as { method?: string; params?: { transaction?: string } };
          method = parsed.method;
          if (method === "sendTransaction" && typeof parsed.params?.transaction === "string") {
            sent.push(parsed.params.transaction);
          }
        } catch {
          // Forward unparseable bodies unchanged; the RPC reports the error.
        }
        try {
          const upstream = await fetch(target, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          });
          let text = await upstream.text();
          if (method === "sendTransaction" && proxy.loseSendResponses) {
            response.writeHead(502).end("connection lost");
            return;
          }
          if (method === "getTransaction" && proxy.hideTransactions) text = hidden(text);
          response.writeHead(upstream.status, { "content-type": "application/json" }).end(text);
        } catch (error) {
          response.writeHead(502).end(String(error));
        }
      })();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    sent,
    get loseSendResponses() {
      return proxy.loseSendResponses;
    },
    set loseSendResponses(value: boolean) {
      proxy.loseSendResponses = value;
    },
    get hideTransactions() {
      return proxy.hideTransactions;
    },
    set hideTransactions(value: boolean) {
      proxy.hideTransactions = value;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

/** Rewrites a getTransaction response to NOT_FOUND, keeping the ledger range fields. */
function hidden(text: string): string {
  const parsed = JSON.parse(text) as { result?: Record<string, unknown> };
  if (parsed.result === undefined) return text;
  const { latestLedger, latestLedgerCloseTime, oldestLedger, oldestLedgerCloseTime } = parsed.result;
  return JSON.stringify({
    ...parsed,
    result: { status: "NOT_FOUND", latestLedger, latestLedgerCloseTime, oldestLedger, oldestLedgerCloseTime },
  });
}
