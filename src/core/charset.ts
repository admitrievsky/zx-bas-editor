/**
 * Byte <-> text escaping, matching zmakebas's input syntax exactly.
 *
 * The escape table below was verified empirically against the zmakebas WASM
 * build rather than taken from documentation:
 *   \\        -> 0x5C
 *   \*        -> 0x7F  (copyright)
 *   \<l><r>   -> 0x80..0x8F block graphics, where each of the two chars is one
 *                of ' ' (empty), '\'' (top), '.' (bottom), ':' (both), giving
 *                0x80 | leftTop<<1 | leftBottom<<3 | rightTop<<0 | rightBottom<<2
 *   \a..\u    -> 0x90..0xA4 UDGs A..U
 *   \{0xNN}   -> any byte verbatim  (confirmed exact for 0x00..0xFF)
 *
 * \{0xNN} is the universal fallback, so every byte is representable losslessly.
 */

const GRAPHIC_CHARS = [' ', "'", '.', ':'] as const;

/** Column char -> (top, bottom) filled flags. */
const COLUMN_BITS: Record<string, [number, number]> = {
  ' ': [0, 0],
  "'": [1, 0],
  '.': [0, 1],
  ':': [1, 1],
};

function graphicEscape(b: number): string {
  const n = b & 0x0f;
  const leftTop = (n >> 1) & 1, leftBottom = (n >> 3) & 1;
  const rightTop = n & 1, rightBottom = (n >> 2) & 1;
  const col = (t: number, bt: number) =>
    GRAPHIC_CHARS.find((c) => COLUMN_BITS[c][0] === t && COLUMN_BITS[c][1] === bt)!;
  return '\\' + col(leftTop, leftBottom) + col(rightTop, rightBottom);
}

const hex2 = (b: number) => '\\{0x' + b.toString(16).padStart(2, '0') + '}';

/**
 * Render one data byte (inside a string literal or REM) as editable text.
 * Never emits a raw newline, so a BASIC line always stays on one text line.
 */
export function escapeByte(b: number): string {
  if (b === 0x5c) return '\\\\';
  if (b >= 0x20 && b <= 0x7e) return String.fromCharCode(b);
  if (b === 0x7f) return '\\*';
  if (b >= 0x80 && b <= 0x8f) return graphicEscape(b);
  if (b >= 0x90 && b <= 0xa4) return '\\' + String.fromCharCode(0x61 + (b - 0x90));
  return hex2(b);
}

export function escapeBytes(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += escapeByte(b);
  return s;
}
