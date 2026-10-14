import { networkPassphrase } from "@rail402.dev/stellar";
import type { PlaygroundConfig } from "../config.ts";

/** Where SEP-1 puts a domain's stellar.toml. */
export const STELLAR_TOML_PATH = "/.well-known/stellar.toml";

/**
 * The Playground domain's SEP-1 stellar.toml: it lists the account lab sellers are paid to. Together
 * with that account naming the Playground's domain as its home_domain (set on the account itself), it
 * lets the Bazaar raise the sandbox listing to `domain_verified`; a one-way claim proves nothing.
 */
export function stellarToml(config: PlaygroundConfig, payTo: string): string {
  return [
    `VERSION = "2.7.0"`,
    `NETWORK_PASSPHRASE = "${networkPassphrase(config.network)}"`,
    `ACCOUNTS = ["${payTo}"]`,
    "",
  ].join("\n");
}

/** SEP-1 asks for open CORS on stellar.toml so wallets and explorers can read it. */
export const STELLAR_TOML_HEADERS = Object.freeze({
  "content-type": "text/plain; charset=utf-8",
  "access-control-allow-origin": "*",
  "cache-control": "public, max-age=300",
});
