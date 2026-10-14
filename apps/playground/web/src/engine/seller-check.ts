/**
 * "Check your endpoint": the Playground server checks a seller's URL the way the Rail402 catalog will
 * (`POST /api/seller-check`), and the page shows the report as a checklist. Every string in the report
 * comes from or describes the seller, so all of it is cleaned and bounded here.
 */
import { untrustedReason } from "@rail402.dev/sdk/browser";
import { playgroundError } from "../../../src/shared/codes.ts";
import { isRelayErrorBody } from "../../../src/shared/relay-protocol.ts";
import { readJson } from "../transport/body.ts";
import { isRecord, requiredView, type DecodeContext } from "./decode.ts";
import { EngineError, engineError, toJsonValue } from "./errors.ts";
import type { SellerCheckRequest, SellerCheckView } from "./types.ts";

export const SELLER_CHECK_PATH = "/api/seller-check";
const REPORT_BYTES = 1_048_576;
const CHECK_TIMEOUT_MS = 60_000;

/** Asks the server to check a seller; rejects with a coded error. */
export async function checkSeller(
  request: SellerCheckRequest,
  options: { readonly origin: string; readonly fetch: typeof fetch; readonly context: DecodeContext },
): Promise<SellerCheckView> {
  let response: Response;
  try {
    response = await options.fetch(new URL(SELLER_CHECK_PATH, options.origin).href, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
  } catch {
    throw engineError(
      playgroundError("playground_upstream_unavailable", {
        reason: "The seller check could not be reached.",
      }),
    );
  }
  const body = await readJson(response.body, REPORT_BYTES);
  if (!response.ok) {
    if (isRelayErrorBody(body)) {
      throw new EngineError({
        code: body.error.code,
        reason: untrustedReason(body.error.reason, 300),
        retryable: body.error.retryable,
      });
    }
    throw engineError(playgroundError("playground_upstream_unavailable"));
  }
  const view = sellerCheckView(body, options.context);
  if (view === undefined) {
    throw engineError(
      playgroundError("playground_upstream_unavailable", {
        reason: "The seller check answered with an invalid report.",
      }),
    );
  }
  return view;
}

function text(value: unknown, max: number): string | null {
  return typeof value === "string" ? untrustedReason(value, max) : null;
}

/** The server's origin report as the page's checklist; undefined when it has the wrong shape. */
export function sellerCheckView(report: unknown, context: DecodeContext): SellerCheckView | undefined {
  if (!isRecord(report) || typeof report["url"] !== "string") return undefined;
  if (report["type"] !== "http" && report["type"] !== "mcp") return undefined;
  const validation = isRecord(report["validation"]) ? report["validation"] : undefined;
  const domain = isRecord(report["domain"]) ? report["domain"] : undefined;
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value.slice(0, 50) : []);
  return {
    url: untrustedReason(report["url"], 2_048),
    type: report["type"],
    ok: report["ok"] === true,
    status: typeof report["status"] === "number" ? report["status"] : null,
    required: requiredView(report["paymentRequired"], context) ?? null,
    validation:
      validation === undefined
        ? null
        : {
            catalogable: validation["catalogable"] === true,
            code: text(validation["code"], 100),
            reason: text(validation["reason"], 300),
            dropped: list(validation["dropped"])
              .filter((item): item is string => typeof item === "string")
              .map((item) => untrustedReason(item, 200)),
            lint: list(validation["lint"])
              .filter(isRecord)
              .map((item) => ({
                code: text(item["code"], 100) ?? "",
                reason: text(item["reason"], 300) ?? "",
              })),
            preview: toJsonValue(validation["preview"]) ?? null,
          },
    findings: list(report["findings"])
      .filter(isRecord)
      .map((finding) => {
        const details = toJsonValue(finding["details"]);
        return {
          code: text(finding["code"], 100) ?? "",
          reason: text(finding["reason"], 300) ?? "",
          ...(details === undefined ? {} : { details }),
        };
      }),
    receivable: list(report["receivable"])
      .filter(isRecord)
      .map((item) => ({
        asset: text(item["asset"], 64) ?? "",
        payTo: text(item["payTo"], 69) ?? "",
        receivable: typeof item["receivable"] === "boolean" ? item["receivable"] : null,
      })),
    domain:
      domain === undefined
        ? null
        : {
            host: text(domain["host"], 253) ?? "",
            claimsOwner: domain["claimsOwner"] === true,
            homeDomainMatches:
              typeof domain["homeDomainMatches"] === "boolean" ? domain["homeDomainMatches"] : null,
          },
  };
}
