/** A test token deployed on a public test network. */
export interface TestTokenDeployment {
  /** CAIP-2 network. */
  readonly network: string;
  /** Contract address (`C…`). */
  readonly address: string;
  readonly symbol: string;
  readonly decimals: number;
  /** Hex sha256 of the installed WASM (`fixtures/test_token.wasm`). */
  readonly wasmHash: string;
}

/**
 * `TEST6` on testnet: the test token from `contracts/testing/test-token` with 6 decimals, an open
 * `faucet(to)` (100 tokens per call, no authorization) and no admin. Its deployment record is
 * `contracts/testing/deployments/test6-testnet.json`.
 */
export const TEST6_TESTNET: TestTokenDeployment = Object.freeze({
  network: "stellar:testnet",
  address: "CDS45IRSWVDBV4JM2FPZ52EYXYO54J6DJL35GOSXOTRA4BYM6FFRK2BK",
  symbol: "TEST6",
  decimals: 6,
  wasmHash: "b2a8948479de732f4374a92810d2aaef365a68dab53b227ffbaba707e55ed9e0",
});
