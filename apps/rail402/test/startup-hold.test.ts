import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { ProvisionRefusedError, SignerSetError, type TaskLock } from "@rail402.dev/facilitator";
import { ConfigError } from "../src/config-error.ts";
import { NetworkGate } from "../src/network-state.ts";
import {
  StartupHoldError,
  UptoContractMismatchError,
  holdReasonOf,
  provisionExclusively,
} from "../src/runtime.ts";

/** A provisioning lock another replica holds for good: `run` never gets it. */
const taken: TaskLock = { run: () => Promise.resolve(undefined) };

describe("the hold reason of a failed startup check", () => {
  it("names another replica's provisioning as its own reason, not an unreachable RPC", async () => {
    const error = await provisionExclusively(
      taken,
      "stellar:pubnet",
      Keypair.random(),
      () => Promise.resolve(true),
      0,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StartupHoldError);
    expect(holdReasonOf(error)).toBe("provisioning_busy");
    const gate = new NetworkGate("stellar:pubnet");
    gate.hold(holdReasonOf(error));
    expect(gate.refusal()).toBe(
      "stellar:pubnet is not serving: another replica is still provisioning its accounts. Retry later.",
    );
  });

  it("keeps the reason a check names, and the contradictions' own reasons", () => {
    expect(holdReasonOf(new StartupHoldError("no sponsor", "sponsor_missing"))).toBe("sponsor_missing");
    expect(
      holdReasonOf(
        new StartupHoldError("refused", "channels_missing", { cause: new ProvisionRefusedError("x") }),
      ),
    ).toBe("channels_missing");
    expect(holdReasonOf(new SignerSetError("hot key meets high"))).toBe("sponsor_signers_unsafe");
    expect(holdReasonOf(new UptoContractMismatchError("other WASM"))).toBe("upto_contract_mismatch");
    expect(holdReasonOf(new ConfigError("decimals", "asset_decimals_mismatch"))).toBe(
      "asset_contradicts_config",
    );
  });

  it("calls only an RPC failure unreachable: an RPC error, a hang, or something that is not an Error", () => {
    for (const thrown of [new Error("connect ECONNREFUSED"), { code: -32603 }, "socket closed", undefined]) {
      expect(holdReasonOf(thrown)).toBe("rpc_unreachable");
    }
  });
});
