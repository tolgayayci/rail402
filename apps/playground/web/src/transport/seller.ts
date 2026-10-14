/**
 * The page's seller transport, as the browser buyer takes it: lab sellers on the Playground's own
 * origin are called directly, every other seller goes through the relay, and both are observed. The
 * operator fetch reaches only the Bazaar and facilitator proxies.
 */
import type { EgressPolicy, SafeFetch, SafeRequestInit } from "@rail402.dev/safe-fetch/shared";
import type { BuyerTransport } from "@rail402.dev/sdk/browser";
import type { PublicConfig } from "../../../src/shared/public-config.ts";
import { RELAY_PATH } from "../../../src/shared/relay-protocol.ts";
import { createDirectFetch, isLabUrl } from "./direct-fetch.ts";
import type { Observer } from "./observe.ts";
import { createOperatorFetch } from "./operator-fetch.ts";
import { transportPolicy } from "./policy.ts";
import { createRelayFetch } from "./relay-fetch.ts";

export interface SellerTransportOptions {
  readonly config: PublicConfig;
  readonly observer: Observer;
  /** The browser's fetch; tests pass their own. */
  readonly fetch?: typeof fetch;
}

/** Sends lab URLs to `direct` and everything else to `relay`, under one policy. */
export function routeSellerFetch(
  origin: string,
  relay: SafeFetch,
  direct: SafeFetch,
  policy: EgressPolicy,
): SafeFetch {
  const route = (input: string | URL, init?: SafeRequestInit): Promise<Response> =>
    isLabUrl(input, origin) ? direct(input, init) : relay(input, init);
  return Object.assign(route, { policy, close: () => undefined });
}

export function createSellerTransport(options: SellerTransportOptions): BuyerTransport & {
  readonly policy: EgressPolicy;
} {
  const { config, observer } = options;
  const origin = new URL(config.urls.public).origin;
  const policy = transportPolicy(config);
  const relay = createRelayFetch({
    relayUrl: new URL(RELAY_PATH, origin).href,
    policy,
    checkPorts: config.mode !== "local",
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const direct = createDirectFetch({
    origin,
    policy,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const seller = routeSellerFetch(
    origin,
    observer.wrap(relay, "relay"),
    observer.wrap(direct, "direct"),
    policy,
  );
  return {
    policy,
    seller,
    operator: createOperatorFetch({
      origin,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    }),
  };
}
