import type { rpc } from "@stellar/stellar-sdk";
import { readContractTtl } from "@rail402.dev/stellar";

/** The configured `upto` settlement contract is not on the network, or runs other code. */
export class UptoContractCheckError extends Error {
  override readonly name = "UptoContractCheckError";
  readonly reason: "absent" | "wasm_mismatch";
  constructor(reason: "absent" | "wasm_mismatch", message: string) {
    super(message);
    this.reason = reason;
  }
}

/**
 * Checks that `contract` is live on the network `server` reads and runs exactly the WASM whose hex
 * SHA-256 is `wasmHash`. The contract has no admin and cannot be upgraded, so this one check pins what
 * every `upto` payment will run. Throws `UptoContractCheckError` otherwise; an RPC failure is rethrown.
 */
export async function assertUptoContract(
  server: rpc.Server,
  contract: string,
  wasmHash: string,
): Promise<void> {
  const reading = await readContractTtl(server, [contract]);
  const live = reading.contracts.get(contract);
  if (live === undefined) {
    throw new UptoContractCheckError("absent", `the upto contract ${contract} is not on the network`);
  }
  if (live.wasmHash !== wasmHash.toLowerCase()) {
    throw new UptoContractCheckError(
      "wasm_mismatch",
      `the upto contract ${contract} runs WASM ${live.wasmHash ?? "(built in)"}, not the configured ${wasmHash}`,
    );
  }
}
