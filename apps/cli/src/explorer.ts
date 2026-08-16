/**
 * Explorer read-API client. Points at Rail402's hosted explorer by default; override with
 * --explorer / RAIL402_EXPLORER_URL to read from your own explorer deployment.
 */

export interface HttpResult {
  ok: boolean;
  status: number;
  body: unknown;
}

async function getJson(url: string, fetchImpl: typeof fetch): Promise<HttpResult> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { accept: "application/json" } });
  } catch (error) {
    // A DNS/TLS/connection failure — surface it as a status-0 result so the caller can turn it
    // into a coded error instead of an uncaught stack trace.
    return { ok: false, status: 0, body: { networkError: error instanceof Error ? error.message : "network error" } };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { ok: res.ok, status: res.status, body };
}

export function txUrl(explorerUrl: string, hash: string): string {
  return `${explorerUrl}/tx/${encodeURIComponent(hash)}`;
}

export function fetchTx(
  explorerUrl: string,
  hash: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HttpResult> {
  return getJson(txUrl(explorerUrl, hash), fetchImpl);
}

export interface FeedParams {
  limit?: number;
  seller?: string;
  buyer?: string;
  facilitator?: string;
  scheme?: string;
}

export function fetchFeed(
  explorerUrl: string,
  params: FeedParams = {},
  fetchImpl: typeof fetch = fetch,
): Promise<HttpResult> {
  const q = new URLSearchParams();
  if (params.limit) q.set("limit", String(params.limit));
  if (params.seller) q.set("seller", params.seller);
  if (params.buyer) q.set("buyer", params.buyer);
  if (params.facilitator) q.set("facilitator", params.facilitator);
  if (params.scheme) q.set("scheme", params.scheme);
  const suffix = q.toString() ? `?${q.toString()}` : "";
  return getJson(`${explorerUrl}/feed${suffix}`, fetchImpl);
}

export function fetchSupported(
  facilitatorUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HttpResult> {
  return getJson(`${facilitatorUrl}/supported`, fetchImpl);
}
