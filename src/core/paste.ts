/**
 * Cleaning up a pasted BASIC listing.
 *
 * Pasted text fails in ways that are worse than an error, because zmakebas
 * accepts them and produces a tape that is quietly wrong:
 *
 *   - CRLF line endings leave a literal 0x0D inside every line.
 *   - Smart quotes from a web page or PDF are not string delimiters at all, so
 *     `PRINT “hi”` compiles to mojibake with no string in it.
 *   - Non-breaking spaces look identical to spaces and are not.
 *
 * Everything here is reported, never silently applied, so the user can see what
 * their source actually contained.
 */

export interface PasteIssue {
  kind: 'line-endings' | 'smart-punctuation' | 'non-ascii' | 'missing-line-number';
  message: string;
  count: number;
  /** Fixed automatically by normalizeListing. */
  fixed: boolean;
}

export interface NormalizeResult {
  text: string;
  issues: PasteIssue[];
}

/** Characters a word processor or web page substitutes for ASCII ones. */
const SMART: Record<string, string> = {
  '“': '"', '”': '"', '„': '"', '«': '"', '»': '"',
  '‘': "'", '’': "'", '‚': "'",
  '–': '-', '—': '-', '−': '-',
  ' ': ' ', ' ': ' ', ' ': ' ',
  '…': '...',
};

export function normalizeListing(input: string): NormalizeResult {
  const issues: PasteIssue[] = [];
  let text = input;

  // A BOM would otherwise become part of the first line number.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const crlf = (text.match(/\r\n?/g) ?? []).length;
  if (crlf > 0) {
    text = text.replace(/\r\n?/g, '\n');
    issues.push({
      kind: 'line-endings',
      message: `converted ${crlf} Windows/Mac line ending${crlf === 1 ? '' : 's'} — left as-is these embed a stray byte in every line`,
      count: crlf,
      fixed: true,
    });
  }

  let smart = 0;
  text = text.replace(/[“”„«»‘’‚–—−   …]/g,
    (c) => { smart++; return SMART[c]; });
  if (smart > 0) {
    issues.push({
      kind: 'smart-punctuation',
      message: `replaced ${smart} smart quote${smart === 1 ? '' : 's'}/dash${smart === 1 ? '' : 'es'} with ASCII — curly quotes do not delimit strings and compile to garbage`,
      count: smart,
      fixed: true,
    });
  }

  // Anything still outside printable ASCII cannot be represented directly; the
  // listing syntax needs \{0xNN} for those.
  const stray = new Map<string, number>();
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c === 0x0a) continue;
    if (c < 0x20 || c > 0x7e) stray.set(ch, (stray.get(ch) ?? 0) + 1);
  }
  if (stray.size > 0) {
    const total = [...stray.values()].reduce((a, b) => a + b, 0);
    const sample = [...stray.keys()].slice(0, 6)
      .map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`)
      .join(', ');
    issues.push({
      kind: 'non-ascii',
      message: `${total} non-ASCII character${total === 1 ? '' : 's'} left (${sample}) — use \\{0xNN} to encode a specific byte`,
      count: total,
      fixed: false,
    });
  }

  const unnumbered = text.split('\n')
    .map((l, i) => [l, i + 1] as const)
    .filter(([l]) => l.trim() !== '' && !/^\s*\d+/.test(l));
  if (unnumbered.length > 0) {
    const where = unnumbered.slice(0, 3).map(([, n]) => n).join(', ');
    issues.push({
      kind: 'missing-line-number',
      message: `${unnumbered.length} line${unnumbered.length === 1 ? '' : 's'} without a line number (at ${where}${unnumbered.length > 3 ? ', …' : ''}) — every BASIC line needs one`,
      count: unnumbered.length,
      fixed: false,
    });
  }

  return { text, issues };
}

/** A tape name must be at most 10 characters the Spectrum can display. */
export function sanitizeTapeName(name: string): string {
  const cleaned = [...name].filter((c) => {
    const v = c.codePointAt(0)!;
    return v >= 0x20 && v <= 0x7e;
  }).join('');
  return (cleaned.trim() || 'PROGRAM').slice(0, 10);
}
