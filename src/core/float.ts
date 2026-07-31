/**
 * ZX Spectrum 5-byte number format.
 *
 * Every numeric literal in a tokenised BASIC line is stored twice: once as the
 * ASCII digits you see in a LIST, and once as a binary value introduced by 0x0E.
 * The interpreter only ever evaluates the binary form, so that is the value we
 * treat as authoritative -- the digits are display only, and the two are allowed
 * to disagree (some protection schemes rely on exactly that).
 */

/** Small-integer form: 0x00, sign, low, high, 0x00 -- holds -65535..65535. */
function isSmallInt(m: Uint8Array): boolean {
  return m[0] === 0;
}

export function decodeZXFloat(m: Uint8Array): number {
  if (m.length < 5) throw new Error('need 5 bytes');
  if (isSmallInt(m)) {
    const v = m[2] | (m[3] << 8);
    return m[1] === 0xff ? v - 65536 : v;
  }
  // Exponent is biased by 128; the mantissa's top bit is implicit and its slot
  // carries the sign instead.
  const exp = m[0] - 128;
  const neg = (m[1] & 0x80) !== 0;
  const mant =
    ((m[1] | 0x80) * 0x1000000 + (m[2] << 16) + (m[3] << 8) + m[4]) / 0x100000000;
  const v = mant * Math.pow(2, exp);
  return neg ? -v : v;
}

export function encodeZXFloat(v: number): Uint8Array {
  const out = new Uint8Array(5);
  if (Number.isInteger(v) && v >= -65535 && v <= 65535) {
    const neg = v < 0;
    const u = neg ? v + 65536 : v;
    out[0] = 0;
    out[1] = neg ? 0xff : 0x00;
    out[2] = u & 0xff;
    out[3] = (u >> 8) & 0xff;
    out[4] = 0;
    return out;
  }
  if (v === 0) return out; // 0,0,0,0,0

  const neg = v < 0;
  let a = Math.abs(v);
  let exp = Math.ceil(Math.log2(a));
  // Normalise into [0.5, 1) -- log2 rounding can be off by one at boundaries.
  let mant = a / Math.pow(2, exp);
  while (mant >= 1) { mant /= 2; exp++; }
  while (mant < 0.5) { mant *= 2; exp--; }

  let m = Math.round(mant * 0x100000000);
  if (m > 0xffffffff) { m = Math.round(m / 2); exp++; }

  out[0] = exp + 128;
  out[1] = ((m >>> 24) & 0x7f) | (neg ? 0x80 : 0x00);
  out[2] = (m >>> 16) & 0xff;
  out[3] = (m >>> 8) & 0xff;
  out[4] = m & 0xff;
  return out;
}

/** True when `digits` re-encodes to exactly `stored` -- i.e. no override needed. */
export function floatMatchesText(digits: number, stored: Uint8Array): boolean {
  const enc = encodeZXFloat(digits);
  for (let i = 0; i < 5; i++) if (enc[i] !== stored[i]) return false;
  return true;
}
