// esbuild `inject` target: makes `Buffer` resolve to the pure-JS `buffer` polyfill in every
// bundled module (the stock @stellar/stellar-sdk references it as a global). Also seeds
// globalThis.Buffer so any late/runtime lookup finds it.
import { Buffer } from "buffer";
if (typeof globalThis.Buffer === "undefined") globalThis.Buffer = Buffer;
export { Buffer };
