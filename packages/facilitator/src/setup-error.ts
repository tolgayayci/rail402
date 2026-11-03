/**
 * The stable codes `createStellarFacilitator` refuses a setup with. Where the Rail402 service has a
 * startup check for the same thing, the code is the same (see docs/configuration.md, "Startup checks").
 */
export type FacilitatorSetupCode =
  | "config_rpc_missing"
  | "config_sponsor_secret_missing"
  | "config_pubnet_rpc_insecure"
  | "config_pubnet_guard_missing"
  | "config_pubnet_fee_ceiling_missing"
  | "config_pubnet_inclusion_floor_too_low"
  | "config_pubnet_assets_missing";

/**
 * A setup `createStellarFacilitator` refuses, before anything is signed or sent: `code` is stable and
 * machine-readable, `message` says which field to set.
 */
export class FacilitatorSetupError extends Error {
  override readonly name = "FacilitatorSetupError";
  readonly code: FacilitatorSetupCode;

  constructor(code: FacilitatorSetupCode, message: string) {
    super(message);
    this.code = code;
  }
}
