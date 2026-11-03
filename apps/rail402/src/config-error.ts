export class ConfigError extends Error {
  override readonly name = "ConfigError";
  /**
   * A stable identifier of what is wrong, printed before the message when startup stops (for example
   * `config_pubnet_fee_ceiling_missing`, or `asset_decimals_mismatch` for a configuration the network
   * contradicts). `config_invalid` covers malformed values and inconsistent limits.
   */
  readonly code: string;

  constructor(message: string, code = "config_invalid") {
    super(message);
    this.code = code;
  }
}

/** The line startup prints to stderr before exiting with code 78: `rail402: <code>: <message>`. */
export function configFailureLine(error: ConfigError): string {
  return `rail402: ${error.code}: ${error.message}\n`;
}
