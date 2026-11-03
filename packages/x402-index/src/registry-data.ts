import pubnet from "../registry/pubnet.json" with { type: "json" };
import testnet from "../registry/testnet.json" with { type: "json" };
import { parseRegistry, type RegistrySnapshot } from "./registry.ts";
import type { IndexNetwork } from "./types.ts";

/** The published facilitator and upto contract registries, parsed and validated. */
export const REGISTRIES: Readonly<Record<IndexNetwork, RegistrySnapshot>> = {
  "stellar:testnet": parseRegistry(testnet),
  "stellar:pubnet": parseRegistry(pubnet),
};
