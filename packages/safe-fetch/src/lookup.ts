import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";
import type { Resolver } from "./limits.ts";

/** Error code carried by a lookup that refused its answer. */
export const REFUSED_LOOKUP = "ERAIL402_DESTINATION_NOT_ALLOWED";

/**
 * A `lookup` for `http.request` and `net.connect` that resolves the host itself and refuses the whole
 * answer when it is empty or when **any** address fails `isAllowed`, so a host with one public and one
 * private address cannot be used to reach the private one. The addresses it returns are the ones the
 * socket dials: the check and the connection cannot disagree (no DNS rebinding window). It honours
 * `options.all`, so happy-eyeballs only ever tries validated addresses.
 *
 * The error never names the refused address, only the host that was asked for. `observe` receives
 * every accepted answer, so callers can assert the connected address later.
 */
export function pinnedLookup(
  isAllowed: (address: string) => boolean,
  resolve?: Resolver,
  observe?: (hostname: string, addresses: readonly LookupAddress[]) => void,
): LookupFunction {
  return (hostname, options, callback) => {
    const answer = (error: NodeJS.ErrnoException | null, addresses: readonly LookupAddress[]) => {
      if (error !== null) {
        callback(error, "", 0);
        return;
      }
      // Every address is checked, whatever family was asked for: a mixed answer is refused whole.
      const family = options.family === 4 || options.family === 6 ? options.family : undefined;
      const candidates =
        family === undefined ? addresses : addresses.filter((entry) => entry.family === family);
      if (candidates.length === 0 || addresses.some((entry) => !isAllowed(entry.address))) {
        const refused = Object.assign(
          new Error(`refused to connect to ${hostname}: it resolves to a private, local or reserved address`),
          { code: REFUSED_LOOKUP },
        );
        callback(refused, "", 0);
        return;
      }
      observe?.(hostname, candidates);
      if (options.all === true) {
        callback(null, [...candidates]);
      } else {
        const [first] = candidates as [LookupAddress];
        callback(null, first.address, first.family);
      }
    };

    if (resolve !== undefined) {
      resolve(hostname).then(
        (addresses) => {
          answer(null, addresses);
        },
        (error: unknown) => {
          answer(
            Object.assign(new Error(`could not resolve ${hostname}`), { code: "ENOTFOUND", cause: error }),
            [],
          );
        },
      );
      return;
    }
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      answer(error, addresses);
    });
  };
}
