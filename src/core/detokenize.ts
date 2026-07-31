/**
 * Tokenised BASIC -> editable text.
 *
 * Program data is a run of lines:
 *   [u16 line number BIG-endian][u16 body length LE][body...][0x0D]
 *
 * Within a body, four contexts decide how bytes are read, and getting these
 * wrong is what makes a naive detokeniser produce garbage:
 *   1. inside "..."      -- raw characters, no keyword or number decoding
 *   2. after REM         -- raw characters to end of line
 *   3. after a letter    -- digits belong to the identifier (M1, J3), not a literal
 *   4. otherwise         -- a digit run is a literal, followed by 0x0E + 5 bytes
 */

import { escapeByte, escapeBytes } from './charset.ts';
import { decodeZXFloat, floatMatchesText } from './float.ts';
import {
  FIRST_TOKEN, NUMBER_MARKER, TOKEN_BIN, TOKEN_DEF_FN, TOKEN_REM,
  tokenText, tokenWantsTrailingSpace,
} from './tokens.ts';

/**
 * A numeric literal whose stored binary value does not match its digits.
 * zmakebas always regenerates the value from the digits, so these must be
 * patched back into the tape image after re-tokenising or the program's
 * behaviour changes silently.
 */
export interface FloatOverride {
  line: number;        // BASIC line number
  index: number;       // n-th numeric literal within that line, 0-based
  digits: string;      // what the listing shows
  value: number;       // what the interpreter actually uses
  bytes: Uint8Array;   // the 5 stored bytes
}

export interface DetokenizeResult {
  text: string;
  overrides: FloatOverride[];
  warnings: string[];
  lineCount: number;
}

const isDigit = (b: number) => b >= 0x30 && b <= 0x39;
const isLetter = (b: number) => (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);

/**
 * zmakebas discards whitespace between tokens, so inserting a space is always
 * safe -- but omitting one is not, when a keyword would run into a neighbouring
 * identifier and be re-read as part of that name.
 */
function needsSpaceBefore(sofar: string, keyword: string): boolean {
  const prev = sofar.at(-1);
  if (prev === undefined) return false;
  if (!/[A-Za-z0-9$]/.test(prev)) return false;
  return /^[A-Za-z]/.test(keyword);
}

export function detokenizeProgram(data: Uint8Array, varsOffset = data.length): DetokenizeResult {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out: string[] = [];
  const overrides: FloatOverride[] = [];
  const warnings: string[] = [];
  const end = Math.min(varsOffset, data.length);
  let p = 0;
  let lineCount = 0;

  while (p + 4 <= end) {
    const lineNo = (data[p] << 8) | data[p + 1];
    const len = dv.getUint16(p + 2, true);
    p += 4;
    if (p + len > end) {
      warnings.push(`line ${lineNo}: body runs past end of program, stopping`);
      break;
    }
    const body = data.subarray(p, p + len);
    p += len;
    lineCount++;

    const { text, lineOverrides, lineWarnings } = detokenizeLine(lineNo, body);
    out.push(`${lineNo} ${text}`);
    overrides.push(...lineOverrides);
    warnings.push(...lineWarnings);
  }

  return { text: out.join('\n') + (out.length ? '\n' : ''), overrides, warnings, lineCount };
}

function detokenizeLine(lineNo: number, body: Uint8Array) {
  let s = '';
  const lineOverrides: FloatOverride[] = [];
  const lineWarnings: string[] = [];
  let inString = false;
  let literalIndex = 0;
  let i = 0;

  const readNumber = (at: number, digits: string) => {
    // Expect 0x0E + 5 bytes straight after the digits.
    if (body[at] !== NUMBER_MARKER || at + 5 >= body.length + 1) return null;
    const bytes = body.subarray(at + 1, at + 6);
    if (bytes.length < 5) return null;
    const value = decodeZXFloat(bytes);
    const asText = digits.startsWith('%') ? parseInt(digits.slice(1), 2) : parseFloat(digits);
    if (!Number.isFinite(asText) || !floatMatchesText(asText, bytes)) {
      lineOverrides.push({
        line: lineNo, index: literalIndex, digits,
        value, bytes: new Uint8Array(bytes),
      });
    }
    literalIndex++;
    return at + 6;
  };

  while (i < body.length) {
    const b = body[i];

    if (b === 0x0d) break; // terminator, should only be the final byte

    if (inString) {
      if (b === 0x22) { inString = false; s += '"'; i++; continue; }
      s += escapeByte(b);
      i++;
      continue;
    }

    if (b === 0x22) { inString = true; s += '"'; i++; continue; }

    // REM swallows the remainder of the line verbatim.
    if (b === TOKEN_REM) {
      s += 'REM ' + escapeBytes(body.subarray(i + 1, body[body.length - 1] === 0x0d ? body.length - 1 : body.length));
      i = body.length;
      break;
    }

    if (b >= FIRST_TOKEN) {
      const kw = tokenText(b);
      if (kw === undefined) { s += escapeByte(b); i++; continue; }

      if (b === TOKEN_BIN) {
        // BIN <binary digits> is still followed by the 5-byte value.
        let j = i + 1, digits = '';
        while (j < body.length && (body[j] === 0x30 || body[j] === 0x31)) {
          digits += String.fromCharCode(body[j]); j++;
        }
        s += 'BIN ' + digits;
        const next = readNumber(j, '%' + digits);
        i = next ?? j;
        continue;
      }

      // Separate a keyword from an adjacent name on either side, or it merges
      // into it: `TO L` + `STEP` must not come out as `TO LSTEP`.
      if (needsSpaceBefore(s, kw)) s += ' ';
      s += kw;
      const nxt = body[i + 1];
      if (tokenWantsTrailingSpace(b) && nxt !== undefined &&
          (isLetter(nxt) || isDigit(nxt) || nxt === 0x22 || nxt === 0x2e || nxt >= FIRST_TOKEN)) {
        s += ' ';
      }
      if (b === TOKEN_DEF_FN) {
        i = skipDefFnPlaceholders(body, i + 1, (t) => { s += t; });
        continue;
      }
      i++;
      continue;
    }

    // Identifier: consume letters and digits together so M1 stays one name.
    if (isLetter(b)) {
      let j = i;
      while (j < body.length && (isLetter(body[j]) || isDigit(body[j]))) {
        s += String.fromCharCode(body[j]); j++;
      }
      if (body[j] === 0x24) { s += '$'; j++; } // string variable suffix
      i = j;
      continue;
    }

    // Numeric literal.
    if (isDigit(b) || b === 0x2e) {
      let j = i, digits = '';
      while (j < body.length && (isDigit(body[j]) || body[j] === 0x2e)) {
        digits += String.fromCharCode(body[j]); j++;
      }
      if (body[j] === 0x45 || body[j] === 0x65) { // exponent
        let k = j + 1, e = 'E';
        if (body[k] === 0x2b || body[k] === 0x2d) { e += String.fromCharCode(body[k]); k++; }
        if (isDigit(body[k])) {
          while (k < body.length && isDigit(body[k])) { e += String.fromCharCode(body[k]); k++; }
          digits += e; j = k;
        }
      }
      s += digits;
      const next = readNumber(j, digits);
      if (next === null) {
        lineWarnings.push(`line ${lineNo}: literal "${digits}" has no 0x0E value marker`);
        i = j;
      } else {
        i = next;
      }
      continue;
    }

    // A stray value marker with no digits in front of it.
    if (b === NUMBER_MARKER) {
      lineWarnings.push(`line ${lineNo}: unexpected 0x0E value with no digits`);
      s += escapeBytes(body.subarray(i, i + 6));
      i += 6;
      continue;
    }

    s += escapeByte(b);
    i++;
  }

  return { text: s, lineOverrides, lineWarnings };
}

/**
 * In DEF FN each parameter name is followed by 0x0E and five zero bytes, a
 * placeholder the ROM fills in at call time. It is invisible in a listing and
 * zmakebas regenerates it, so we emit the names only.
 */
function skipDefFnPlaceholders(body: Uint8Array, start: number, emit: (t: string) => void): number {
  let i = start;
  while (i < body.length) {
    const b = body[i];
    if (b === 0x3d) { emit('='); return i + 1; } // '=' ends the parameter list
    if (b === NUMBER_MARKER) { i += 6; continue; }
    if (b === 0x0d) return i;
    emit(escapeByte(b));
    i++;
  }
  return i;
}
