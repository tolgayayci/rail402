import type { CommandHandler } from "../command.ts";
import { clean, fields } from "../output.ts";
import { withBuyer } from "./common.ts";

/**
 * `rail402 tx <hash>`: a transaction read from the RPC and explained for an x402 buyer: fee sponsor,
 * invocation, authorizations, transfers, whether the configured facilitator sponsored it, and an
 * explorer link. Hashes beyond the RPC's retention are `transaction_not_found`.
 */
export const tx: CommandHandler = {
  pays: false,
  run: (input) =>
    withBuyer(input, { signer: false }, async ({ buyer }) => {
      const report = await buyer.inspectTransaction(input.parsed.positionals[0] ?? "");
      return {
        result: report,
        human: () => {
          const lines = [
            fields([
              ["transaction", report.hash],
              ["status", report.status],
              ["ledger", `${String(report.ledger)} (${report.closedAt})`],
              ["source", report.source],
              [
                "fee sponsor",
                report.feeBump === null
                  ? undefined
                  : `${report.feeBump.feeSource} paid ${report.feeBump.feeCharged} stroops (inner ${report.feeBump.innerHash})`,
              ],
              [
                "facilitator",
                report.facilitator === null
                  ? undefined
                  : `${report.facilitator.url} (${report.facilitator.attributed ? "sponsored by its signer" : "not one of its signers"})`,
              ],
              ["x402 shape", report.x402.shape],
              ["explorer", report.explorerUrl],
            ]),
          ];
          if (report.operations.length > 0) {
            lines.push(
              [
                "operations:",
                ...report.operations.map(
                  (operation) =>
                    `  ${clean(operation.type, 64)}${operation.contract === undefined ? "" : ` ${clean(operation.contract, 64)}`}${operation.function === undefined ? "" : `.${clean(operation.function, 64)}`}`,
                ),
              ].join("\n"),
            );
          }
          if (report.transfers.length > 0) {
            lines.push(
              [
                "transfers:",
                ...report.transfers.map(
                  (transfer) =>
                    `  ${clean(transfer.amount.decimal ?? transfer.amount.atomic, 64)} ${clean(transfer.symbol ?? transfer.contract, 64)}  ${clean(transfer.from, 80)} -> ${clean(transfer.to, 80)}`,
                ),
              ].join("\n"),
            );
          }
          if (report.authorizations.length > 0) {
            lines.push(
              [
                "authorizations:",
                ...report.authorizations.map(
                  (auth) =>
                    `  ${clean(auth.address, 80)} nonce ${clean(auth.nonce, 64)}, expires at ledger ${String(auth.expirationLedger)}${auth.signed ? ", signed" : ""}`,
                ),
              ].join("\n"),
            );
          }
          if (report.x402.checks.length > 0) {
            lines.push(
              ["checks:", ...report.x402.checks.map((check) => `  ${clean(check, 200)}`)].join("\n"),
            );
          }
          return lines.join("\n\n");
        },
      };
    }),
};
