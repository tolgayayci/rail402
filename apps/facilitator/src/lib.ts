/**
 * Library entry — self-facilitation.
 *
 * A resource server can run verify/settle in-process, without our hosted service, by importing from
 * here. Importing this module NEVER boots an HTTP server or binds a port: the bootstrap lives in
 * `./index.ts` (the container CMD and the `@rail402.dev/facilitator/server` export), which
 * self-invokes `main()`. This file only re-exports the pieces a seller embeds.
 *
 * Two shapes are supported:
 *
 *   - `buildFacilitator(config)` returns a facilitator whose `verify`/`settle`/`getSupported` you
 *     call directly — no network hop to a separate service.
 *   - `createApp({ config, startedAt })` returns a Hono app (verify/settle/supported/discovery) you
 *     can mount into your own server under any prefix.
 *
 * `loadConfig(env)` validates 12-factor configuration and fails closed on a bad setup.
 */
export { buildFacilitator } from "./facilitator/build.js";
export type { BuiltFacilitator } from "./facilitator/build.js";

export { createApp } from "./app.js";
export type { AppDeps } from "./app.js";

export { loadConfig, describeConfig } from "./config/env.js";
export type { FacilitatorConfig, NetworkConfig, StellarNetwork } from "./config/env.js";

export { createRateLimiter, clientKey } from "./rate-limit.js";
export type { RateLimiterOptions } from "./rate-limit.js";
