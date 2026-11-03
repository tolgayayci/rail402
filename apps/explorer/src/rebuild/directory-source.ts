import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeLakeObject, type LedgerSource, type SourcedLedger } from "@rail402.dev/ledger-source";

/**
 * Ledgers from a local directory of data lake objects named `<sequence>.xdr.zst`, e.g. a downloaded
 * slice or the committed test fixtures. The same checks apply as for the data lake.
 */
export class DirectorySource implements LedgerSource {
  readonly name = "directory";
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  getLedger(sequence: number): Promise<SourcedLedger | undefined> {
    const file = join(this.#directory, `${String(sequence)}.xdr.zst`);
    if (!existsSync(file)) return Promise.resolve(undefined);
    return Promise.resolve({
      sequence,
      meta: decodeLakeObject(readFileSync(file), sequence),
      source: "lake",
      uri: `${String(sequence)}.xdr.zst`,
    });
  }

  async latestLedger(from: number): Promise<number> {
    let latest = from;
    while (existsSync(join(this.#directory, `${String(latest + 1)}.xdr.zst`))) latest++;
    return Promise.resolve(latest);
  }
}
