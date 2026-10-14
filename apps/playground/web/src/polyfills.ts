/**
 * Runs before anything else on the page (main.tsx imports it first).
 *
 * - `Buffer`: stellar-sdk and the x402 packages expect the npm `buffer` polyfill as a global in browsers.
 * - zod: jitless parsing, so zod never probes `new Function`, which the page's CSP forbids.
 */
import { Buffer } from "buffer";
import { z } from "zod";

const scope = globalThis as { Buffer?: typeof Buffer };
scope.Buffer ??= Buffer;

z.config({ jitless: true });
