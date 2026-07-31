/**
 * Text -> TAP, preserving everything zmakebas cannot express.
 *
 * Two fixups are applied on top of zmakebas's output:
 *
 * 1. Header fields. zmakebas writes its own "no autostart" sentinel, but the
 *    original file may use a different value (a real tape often has 32804
 *    rather than 32768). Both mean "no autostart", yet keeping the original
 *    makes the save byte-identical, which is what lets a user verify that an
 *    unedited load/save is a no-op.
 *
 * 2. Numeric literals whose stored 5-byte value disagrees with their digits.
 *    zmakebas always regenerates the value from the digits, so any deliberate
 *    mismatch would be silently "corrected" and the program's behaviour would
 *    change. We write the original bytes back.
 */

import type { FloatOverride } from './detokenize.ts';
import { NUMBER_MARKER, FIRST_TOKEN, TOKEN_REM } from './tokens.ts';
import { concatBlocks, makeBlock, makeProgramHeader, parseTap, type TapBlock } from './tap.ts';
import { textToTap } from './zmakebas.ts';

export interface SaveOptions {
  name: string;
  /** Original header autostart field, preserved verbatim when no real line is set. */
  autostart: number;
  overrides?: FloatOverride[];
  /** Blocks from the source file that follow the program, passed through untouched. */
  trailingBlocks?: TapBlock[];
}

export interface SaveResult {
  tap: Uint8Array;
  programData: Uint8Array;
  appliedOverrides: number;
  unappliedOverrides: FloatOverride[];
}

export async function buildTap(text: string, opts: SaveOptions): Promise<SaveResult> {
  const produced = await textToTap(text, { name: opts.name, autostart: opts.autostart });
  const blocks = parseTap(produced);
  const data = blocks.find((b) => b.kind === 'data');
  if (!data || data.kind !== 'data') throw new Error('zmakebas returned no data block');

  const programData = new Uint8Array(data.payload);
  const { applied, unapplied } = applyOverrides(programData, opts.overrides ?? []);

  const parts: Uint8Array[] = [
    makeProgramHeader(opts.name, programData.length, opts.autostart, programData.length),
    makeBlock(0xff, programData),
  ];
  for (const b of opts.trailingBlocks ?? []) {
    parts.push(prefixLength(b.raw));
  }

  return {
    tap: concatBlocks(parts),
    programData,
    appliedOverrides: applied,
    unappliedOverrides: unapplied,
  };
}

function prefixLength(raw: Uint8Array): Uint8Array {
  const out = new Uint8Array(2 + raw.length);
  out[0] = raw.length & 0xff;
  out[1] = (raw.length >> 8) & 0xff;
  out.set(raw, 2);
  return out;
}

function applyOverrides(data: Uint8Array, overrides: FloatOverride[]) {
  if (overrides.length === 0) return { applied: 0, unapplied: [] as FloatOverride[] };

  const byLine = new Map<number, FloatOverride[]>();
  for (const o of overrides) {
    const list = byLine.get(o.line) ?? [];
    list.push(o);
    byLine.set(o.line, list);
  }

  let applied = 0;
  const unapplied: FloatOverride[] = [];
  const seen = new Set<FloatOverride>();

  for (const [line, positions] of locateLiterals(data)) {
    const wanted = byLine.get(line);
    if (!wanted) continue;
    for (const o of wanted) {
      const at = positions[o.index];
      if (at === undefined) continue;
      data.set(o.bytes, at + 1); // skip the 0x0E marker
      applied++;
      seen.add(o);
    }
  }
  for (const o of overrides) if (!seen.has(o)) unapplied.push(o);
  return { applied, unapplied };
}

/**
 * Map each BASIC line number to the offsets of its 0x0E value markers, in
 * order. Mirrors the context rules in detokenize.ts: string and REM content
 * cannot contain a literal.
 */
function locateLiterals(data: Uint8Array): Map<number, number[]> {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out = new Map<number, number[]>();
  let p = 0;
  while (p + 4 <= data.length) {
    const lineNo = (data[p] << 8) | data[p + 1];
    const len = dv.getUint16(p + 2, true);
    p += 4;
    if (p + len > data.length) break;
    const positions: number[] = [];
    let inString = false;
    for (let i = p; i < p + len; i++) {
      const b = data[i];
      if (b === 0x22) { inString = !inString; continue; }
      if (inString) continue;
      if (b === TOKEN_REM) break;
      if (b === NUMBER_MARKER) { positions.push(i); i += 5; continue; }
      if (b >= FIRST_TOKEN) continue;
    }
    out.set(lineNo, positions);
    p += len;
  }
  return out;
}
