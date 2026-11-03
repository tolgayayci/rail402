import { CHECKS, type FailedAttemptRow, type SettlementRow } from "./types.ts";

const STRKEY = /^[GC][A-Z2-7]{55}$/;
const ACCOUNT = /^G[A-Z2-7]{55}$/;
const CONTRACT = /^C[A-Z2-7]{55}$/;
const HASH = /^[0-9a-f]{64}$/;
const UNSIGNED = /^\d{1,39}$/;
const U64 = /^\d{1,20}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const ASSET_CODE = /^(native|[A-Za-z0-9]{1,12})$/;
const RESULT_CODE = /^[A-Za-z0-9]{1,64}(:[A-Za-z0-9]{1,64}){0,3}$/;
/** Text a row may hold anywhere: no NUL, well-formed UTF-16 (so valid UTF-8 once encoded), bounded. */
const MAX_TEXT = 2048;

/** Whether `value` can be stored as Postgres text exactly as it is. */
export function storableText(value: string): boolean {
  return value.length <= MAX_TEXT && !value.includes("\u0000") && value.isWellFormed();
}

function strings(value: unknown, path: string, out: [string, string][]): void {
  if (typeof value === "string") out.push([path, value]);
  else if (Array.isArray(value))
    value.forEach((item, index) => {
      strings(item, `${path}[${String(index)}]`, out);
    });
  else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) strings(item, path === "" ? key : `${path}.${key}`, out);
  }
}

const shape = (
  problems: string[],
  field: string,
  value: string | null,
  pattern: RegExp,
  nullable = false,
) => {
  if (value === null ? !nullable : !pattern.test(value)) problems.push(field);
};

/**
 * The fields of a classified row that could not be stored exactly as they are, empty when the row is
 * storable. Every string must be storable text, and every field must have its expected shape (strkeys,
 * hashes, decimal amounts, a u64 muxed id, an asset code), so bytes an attacker chose in an event or an
 * envelope can never reach the database, or stop a commit, in any other form. The classifier excludes a
 * row with a problem as `malformed`.
 */
export function unstorableFields(row: SettlementRow | FailedAttemptRow): string[] {
  const problems: string[] = [];
  const all: [string, string][] = [];
  strings(row, "", all);
  for (const [path, value] of all) if (!storableText(value)) problems.push(path);
  if (!Number.isSafeInteger(row.ledger) || row.ledger < 1) problems.push("ledger");
  if (!Number.isSafeInteger(row.txIndex) || row.txIndex < 0 || row.txIndex > 2 ** 31 - 1)
    problems.push("txIndex");
  shape(problems, "txHash", row.txHash, HASH);
  if ("resultCode" in row) {
    shape(problems, "resultCode", row.resultCode, RESULT_CODE);
    shape(problems, "feePayer", row.feePayer, STRKEY);
    shape(problems, "feeChargedStroops", row.feeChargedStroops, UNSIGNED);
    return problems;
  }
  shape(problems, "innerHash", row.innerHash, HASH, true);
  shape(problems, "closedAt", row.closedAt, ISO_TIME);
  shape(problems, "asset.contract", row.asset.contract, CONTRACT);
  shape(problems, "asset.code", row.asset.code, ASSET_CODE, true);
  shape(problems, "asset.issuer", row.asset.issuer, ACCOUNT, true);
  shape(problems, "payer", row.payer, STRKEY);
  shape(problems, "payTo", row.payTo, STRKEY);
  shape(problems, "payToMuxedId", row.payToMuxedId, U64, true);
  shape(problems, "amount", row.amount, UNSIGNED);
  shape(problems, "maxAmount", row.maxAmount, UNSIGNED, true);
  if (row.upto !== null) {
    shape(problems, "upto.contract", row.upto.contract, CONTRACT);
    shape(problems, "upto.authority", row.upto.authority, STRKEY);
  }
  shape(problems, "fee.payer", row.fee.payer, STRKEY);
  shape(problems, "fee.innerSource", row.fee.innerSource, STRKEY);
  shape(problems, "fee.opSource", row.fee.opSource, STRKEY);
  shape(problems, "fee.chargedStroops", row.fee.chargedStroops, UNSIGNED);
  if (!row.checks.every((check) => check in CHECKS)) problems.push("checks");
  return problems;
}
