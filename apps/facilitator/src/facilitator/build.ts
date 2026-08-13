import { x402Facilitator } from "@x402/core/facilitator";
import { createEd25519Signer, type FacilitatorStellarSigner } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";
import type { Network } from "@x402/core/types";
import type { FacilitatorConfig } from "../config/env.js";
import { EnrichedExactStellarScheme } from "./scheme.js";
import { UptoStellarFacilitatorScheme, uptoContractFor } from "@rail402/scheme-upto-stellar";

/**
 * Assemble the facilitator from validated configuration.
 *
 * Composition, not reimplementation: `@x402/stellar` provides the scheme, `@x402/core` provides
 * the registry and the `/supported` shape, and we contribute configuration, signer management,
 * and the enrichment wrapper.
 */
export interface BuiltFacilitator {
  readonly facilitator: x402Facilitator;
  readonly signerAddresses: readonly string[];
  readonly feeBumpAddress?: string;
}

export function buildFacilitator(config: FacilitatorConfig): BuiltFacilitator {
  // One signer per configured secret. Each is an independent source account with its own
  // sequence number, which is what lets bursty agent traffic settle in parallel instead of
  // serializing behind a single account.
  const primaryNetwork = config.networks[0]!.network as Network;

  const signers: FacilitatorStellarSigner[] = config.signerSecrets.map(secret =>
    createEd25519Signer(secret, primaryNetwork),
  );

  const feeBumpSigner = config.feeBumpSecret
    ? createEd25519Signer(config.feeBumpSecret, primaryNetwork)
    : undefined;

  const facilitator = new x402Facilitator();

  // Register per network so each gets its own RPC endpoint. Testnet has a library default;
  // pubnet does not, and loadConfig() has already guaranteed one is present.
  for (const { network, rpcUrl } of config.networks) {
    const upstream = new ExactStellarScheme(signers, {
      rpcConfig: { url: rpcUrl },
      areFeesSponsored: config.areFeesSponsored,
      maxTransactionFeeStroops: config.maxTransactionFeeStroops,
      ...(feeBumpSigner ? { feeBumpSigner } : {}),
    });

    const enriched = new EnrichedExactStellarScheme(upstream, {
      maxTransactionFeeStroops: config.maxTransactionFeeStroops,
      rpcUrlFor: n => config.networks.find(c => c.network === n)?.rpcUrl,
    });

    facilitator.register(network as Network, enriched);

    // `upto` registers only where a settlement contract is actually deployed. Advertising a scheme
    // we cannot settle would be exactly the advertised-vs-reachable gap this project exists to
    // criticise in others.
    if (uptoContractFor(network as Network)) {
      facilitator.register(
        network as Network,
        new UptoStellarFacilitatorScheme(signers, {
          rpcConfig: { url: rpcUrl },
          areFeesSponsored: config.areFeesSponsored,
          maxTransactionFeeStroops: config.maxTransactionFeeStroops,
        }),
      );
    }
  }

  return {
    facilitator,
    signerAddresses: signers.map(s => s.address),
    ...(feeBumpSigner ? { feeBumpAddress: feeBumpSigner.address } : {}),
  };
}
