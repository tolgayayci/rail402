/**
 * Library entry for the playground server — importing this never boots anything. The bootstrap
 * lives in `./index.ts` (the `@rail402/playground/server` export), which self-invokes `main()`.
 */

export { createApp } from "./app.js";
export type { AppDeps } from "./app.js";

export { loadConfig, describeConfig, NETWORK, HORIZON_URL, FRIENDBOT_URL } from "./config.js";
export type { PlaygroundConfig } from "./config.js";

export { createDispenser, createHorizonGateway } from "./dispenser.js";
export type { HorizonGateway, BalanceLine, DispenserDeps, DripResult } from "./dispenser.js";

export { createMeter, MeterRefusal, TAB_SECONDS } from "./meter.js";
export type { MeterDeps, FacilitatorVerifyBody, FacilitatorSettleBody } from "./meter.js";

export { createShareStore } from "./share.js";
export type { ShareEntry } from "./share.js";

export { decimalToStroops, stroopsToDecimal, stroopsToDisplay, STROOPS_PER_UNIT } from "../shared/amounts.js";
