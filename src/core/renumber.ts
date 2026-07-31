/**
 * Line renumbering for the text listing.
 *
 * Renumbering is only half the job: every reference to a line number has to
 * move with it. This program is a good example of why -- `RESTORE 820` and
 * `RESTORE 830` select which tune plays, so a renumber that misses them
 * produces a program that still runs and quietly plays the wrong notes.
 *
 * Works on the text rather than the tokenised form, so it needs no compile
 * step and cannot fail on a listing that is mid-edit.
 *
 * Two cases deserve care:
 *
 *  - `LINE` is the same keyword in `SAVE "x" LINE 10` (an autostart line) and
 *    in `INPUT LINE a$` (read a whole line of input). Only the first is a line
 *    reference, so a keyword is only treated as one when a plain integer
 *    follows it.
 *
 *  - A jump to a line that does not exist is legal: the ROM continues at the
 *    first line *after* the target. That has to be preserved, so such a
 *    reference is redirected to whichever line the interpreter would actually
 *    have reached.
 */

/** Keywords that can be followed by a line number, longest form first. */
const REF_KEYWORDS = [
  'GO TO', 'GOTO', 'GO SUB', 'GOSUB', 'RESTORE', 'LLIST', 'LIST', 'RUN', 'LINE',
];

export const MAX_LINE_NUMBER = 9999;

export interface RenumberOptions {
  start?: number;
  step?: number;
}

export interface RenumberResult {
  text: string;
  /** old line number -> new line number */
  mapping: Map<number, number>;
  /** number of references rewritten */
  rewritten: number;
  warnings: string[];
}

interface SourceLine {
  oldNumber: number | null; // null for blank/unnumbered lines, kept verbatim
  raw: string;
  body: string;             // text after the line number
}

function splitLines(text: string): SourceLine[] {
  return text.split('\n').map((raw) => {
    const m = /^\s*(\d+)\s?(.*)$/.exec(raw);
    if (!m) return { oldNumber: null, raw, body: raw };
    return { oldNumber: Number(m[1]), raw, body: m[2] };
  });
}

/**
 * Find every line-number reference in a line body, skipping string literals
 * and anything after REM.
 */
function findReferences(body: string): { at: number; length: number; value: number }[] {
  const found: { at: number; length: number; value: number }[] = [];
  const upper = body.toUpperCase();
  let inString = false;
  let i = 0;

  while (i < body.length) {
    const c = body[i];

    if (c === '"') { inString = !inString; i++; continue; }
    if (inString) { i++; continue; }

    // REM takes the rest of the line verbatim.
    if (upper.startsWith('REM', i) && !isWordChar(body[i - 1]) && !isWordChar(body[i + 3])) break;

    const kw = REF_KEYWORDS.find(
      (k) => upper.startsWith(k, i) && !isWordChar(body[i - 1]) && !isWordChar(body[i + k.length]),
    );
    if (!kw) { i++; continue; }

    let j = i + kw.length;
    while (body[j] === ' ') j++;
    const digits = /^\d+/.exec(body.slice(j));
    if (digits) {
      found.push({ at: j, length: digits[0].length, value: Number(digits[0]) });
      i = j + digits[0].length;
    } else {
      // No literal number: a computed target (GO TO x*10) or a different use of
      // the keyword (INPUT LINE a$). Either way there is nothing to rewrite.
      i = j;
    }
  }
  return found;
}

const isWordChar = (c: string | undefined) => c !== undefined && /[A-Za-z0-9$]/.test(c);

export function renumber(text: string, opts: RenumberOptions = {}): RenumberResult {
  const start = opts.start ?? 10;
  const step = opts.step ?? 10;
  const warnings: string[] = [];

  if (start < 1) throw new Error('start line must be at least 1');
  if (step < 1) throw new Error('step must be at least 1');

  const lines = splitLines(text);
  const numbered = lines.filter((l) => l.oldNumber !== null) as (SourceLine & { oldNumber: number })[];

  const last = start + step * Math.max(0, numbered.length - 1);
  if (last > MAX_LINE_NUMBER) {
    throw new Error(
      `${numbered.length} lines from ${start} by ${step} would reach ${last}, ` +
        `above the maximum line number ${MAX_LINE_NUMBER}`,
    );
  }

  const mapping = new Map<number, number>();
  numbered.forEach((l, i) => {
    if (mapping.has(l.oldNumber)) warnings.push(`duplicate line number ${l.oldNumber}`);
    mapping.set(l.oldNumber, start + i * step);
  });

  // Ascending list of the original numbers, for resolving jumps to gaps.
  const oldNumbers = numbered.map((l) => l.oldNumber).sort((a, b) => a - b);
  const lastNew = start + step * Math.max(0, numbered.length - 1);

  const resolve = (target: number, onLine: number): number => {
    const exact = mapping.get(target);
    if (exact !== undefined) return exact;
    const next = oldNumbers.find((n) => n > target);
    if (next !== undefined) {
      warnings.push(
        `line ${onLine}: reference to ${target}, which does not exist; ` +
          `retargeted to ${mapping.get(next)} (was the next line, ${next})`,
      );
      return mapping.get(next)!;
    }
    const beyond = Math.min(lastNew + step, MAX_LINE_NUMBER);
    warnings.push(
      `line ${onLine}: reference to ${target} is past the last line; ` +
        `set to ${beyond}, which still falls off the end`,
    );
    return beyond;
  };

  let rewritten = 0;
  const out = lines.map((l) => {
    if (l.oldNumber === null) return l.raw;
    const refs = findReferences(l.body);
    let body = l.body;
    // Rewrite right-to-left so earlier offsets stay valid.
    for (const r of [...refs].reverse()) {
      const to = resolve(r.value, l.oldNumber);
      if (to !== r.value) rewritten++;
      body = body.slice(0, r.at) + String(to) + body.slice(r.at + r.length);
    }
    return `${mapping.get(l.oldNumber)} ${body}`;
  });

  return { text: out.join('\n'), mapping, rewritten, warnings };
}

/**
 * Build the reference graph by line *index*, which renumbering must leave
 * unchanged. Used by the tests as the correctness invariant.
 */
export function referenceGraph(text: string): (number | null)[][] {
  const lines = splitLines(text).filter((l) => l.oldNumber !== null) as (SourceLine & { oldNumber: number })[];
  const numbers = lines.map((l) => l.oldNumber);
  const indexOfTarget = (t: number) => {
    const exact = numbers.indexOf(t);
    if (exact !== -1) return exact;
    const next = numbers.findIndex((n) => n > t);
    return next === -1 ? null : next;
  };
  return lines.map((l) => findReferences(l.body).map((r) => indexOfTarget(r.value)));
}
