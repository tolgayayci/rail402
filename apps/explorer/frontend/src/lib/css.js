/**
 * Parse the design's inline style strings ("a:b;c:d") into React style objects, memoized.
 * The strings are kept byte-identical to the design source so nothing is restyled in
 * translation; only the first colon splits (values like font stacks contain commas, not colons).
 */
const cache = new Map();
export function css(str) {
  const hit = cache.get(str);
  if (hit) return hit;
  const o = {};
  for (const part of str.split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const prop = part.slice(0, i).trim();
    if (!prop) continue;
    const val = part.slice(i + 1).trim();
    o[prop.startsWith('--') ? prop : prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = val;
  }
  if (cache.size > 4000) cache.clear();
  cache.set(str, o);
  return o;
}
