import { describe, expect, it } from "vitest";
import { simpleAccountWasm } from "@rail402.dev/testkit";

/** Node's WebAssembly module API; the project's type libraries (no DOM) do not declare it. */
interface WasmModules {
  readonly Module: {
    new (bytes: Uint8Array): object;
    exports(module: object): readonly { readonly name: string; readonly kind: string }[];
  };
}
const { Module } = (globalThis as unknown as { WebAssembly: WasmModules }).WebAssembly;

/** The functions a contract's WASM exports: the only ones a Soroban invocation can reach. */
function exportedFunctions(wasm: Buffer): string[] {
  return Module.exports(new Module(wasm))
    .filter((entry) => entry.kind === "function")
    .map((entry) => entry.name)
    .sort();
}

describe("the fixture smart account", () => {
  it("takes its owner in the constructor and exports no function that could replace it", () => {
    // The constructor runs inside the transaction that creates the contract, so no other account can
    // set the owner first, and nothing exported afterwards can change it.
    expect(exportedFunctions(simpleAccountWasm())).toEqual(["__check_auth", "__constructor"]);
  });
});
