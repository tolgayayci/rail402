import type { rpc } from "@stellar/stellar-sdk";
import { readContractTtl, type AssetKind } from "@rail402.dev/stellar";
import type { AcceptedAsset } from "./policy.ts";

/**
 * Whether each accepted token is a Stellar Asset Contract or another SEP-41 contract, which decides
 * how a token error is named (see `classifyTransferFailure`). A kind given on the accepted asset is
 * used as is; otherwise it is read once from the contract's instance entry. A kind never changes for a
 * deployed contract, so a successful read is kept; a failed read is retried next time.
 */
export class AssetKinds {
  private readonly server: Pick<rpc.Server, "getLedgerEntries">;
  private readonly known = new Map<string, AssetKind>();

  constructor(server: Pick<rpc.Server, "getLedgerEntries">, assets: Iterable<AcceptedAsset>) {
    this.server = server;
    for (const asset of assets) if (asset.kind !== undefined) this.known.set(asset.contract, asset.kind);
  }

  /** The token's kind, or undefined when it cannot be read now. Never rejects. */
  async of(contract: string): Promise<AssetKind | undefined> {
    const known = this.known.get(contract);
    if (known !== undefined) return known;
    try {
      const instance = (await readContractTtl(this.server, [contract])).contracts.get(contract);
      if (instance === undefined) return undefined;
      const kind: AssetKind = instance.kind === "stellar_asset" ? "sac" : "sep41";
      this.known.set(contract, kind);
      return kind;
    } catch {
      return undefined;
    }
  }
}
