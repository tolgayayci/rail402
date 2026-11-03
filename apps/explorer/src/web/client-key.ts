import { isIPv4, isIPv6 } from "node:net";

/**
 * The key a client is limited under. An IPv4 address, or one mapped into IPv6 (`::ffff:192.0.2.1`), is
 * its own key; an IPv6 address is keyed by its /64, because one subscriber usually holds a whole /64
 * and could otherwise rotate through fresh buckets. Anything else is kept as is.
 */
export function clientKey(address: string): string {
  const bare = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (isIPv4(bare)) return bare;
  if (!isIPv6(bare)) return address;
  const groups = ipv6Groups(bare.toLowerCase());
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const [high = 0, low = 0] = groups.slice(6);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
}

/** The eight 16-bit groups of a valid IPv6 address, with `::` expanded and a dotted IPv4 tail read. */
function ipv6Groups(address: string): number[] {
  let text = address;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted !== null) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const parse = (part: string) => (part === "" ? [] : part.split(":").map((group) => parseInt(group, 16)));
  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  const zeros = tail === undefined ? [] : new Array<number>(8 - left.length - right.length).fill(0);
  return [...left, ...zeros, ...right];
}
