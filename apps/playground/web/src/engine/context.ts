/**
 * Loading what the engine starts from: the server's public configuration (`GET /api/config`).
 */
import { playgroundError } from "../../../src/shared/codes.ts";
import { CONFIG_PATH, parsePublicConfig, type PublicConfig } from "../../../src/shared/public-config.ts";
import { engineError } from "./errors.ts";

const CONFIG_TIMEOUT_MS = 10_000;

/** Reads and validates the configuration; rejects with `playground_config_unavailable`. */
export async function loadConfig(
  options: { readonly origin?: string; readonly fetch?: typeof fetch } = {},
): Promise<PublicConfig> {
  const origin = options.origin ?? (globalThis as { location?: { origin: string } }).location?.origin;
  const send = options.fetch ?? globalThis.fetch.bind(globalThis);
  const unavailable = () => engineError(playgroundError("playground_config_unavailable"));
  if (origin === undefined) throw unavailable();
  let body: unknown;
  try {
    const response = await send(new URL(CONFIG_PATH, origin).href, {
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error("unavailable");
    body = (await response.json()) as unknown;
  } catch {
    throw unavailable();
  }
  const config = parsePublicConfig(body);
  if (config === undefined) throw unavailable();
  return config;
}
