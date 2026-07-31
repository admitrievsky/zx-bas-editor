/**
 * Unit + property tests for the pieces that have no external reference to lean
 * on. Run with: node --experimental-strip-types test/units.ts
 */
import { detokenizeProgram } from '../src/core/detokenize.ts';
import { decodeZXFloat, encodeZXFloat } from '../src/core/float.ts';
import { normalizeListing, sanitizeTapeName } from '../src/core/paste.ts';
import { renumber, referenceGraph } from '../src/core/renumber.ts';
import { parseTap } from '../src/core/tap.ts';
import { textToTap } from '../src/core/zmakebas.ts';

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' -- ' + detail : ''}`); }
}

function programData(tap: Uint8Array): Uint8Array {
  const d = parseTap(tap).find((b) => b.kind === 'data');
  if (!d || d.kind !== 'data') throw new Error('no data block');
  return d.payload;
}

/* ---------------------------------------------------- 5-byte number format */

console.log('ZX float encode/decode');
for (const v of [0, 1, -1, 27, 255, 256, 32767, -32768, 65535, -65535,
                 0.5, 0.0625, 0.1, -0.1, 3.14159265, 1e10, -1e-10, 1 / 3]) {
  const round = decodeZXFloat(encodeZXFloat(v));
  const ok = Math.abs(round - v) <= Math.abs(v) * 1e-9 + 1e-12;
  check(`round-trip ${v}`, ok, `got ${round}`);
}
// Integers in range must use the compact small-integer form, as the ROM does.
check('small ints use integer form', encodeZXFloat(1000)[0] === 0);
check('non-integers use float form', encodeZXFloat(0.5)[0] !== 0);
check('0.0625 matches ROM bytes',
  Array.from(encodeZXFloat(0.0625)).join(',') === '125,0,0,0,0');

/* -------------------------------------------------- byte escaping fidelity */

console.log('escape fidelity: every byte survives a REM');
{
  // 0x0D terminates a BASIC line so it cannot appear inside one.
  const bytes = Array.from({ length: 256 }, (_, i) => i).filter((b) => b !== 0x0d);
  const src = '10 REM ' + bytes.map((b) => `\\{0x${b.toString(16).padStart(2, '0')}}`).join('') + '\n';
  const data = programData(await textToTap(src, { name: 'ESC' }));
  const body = data.subarray(4, data.length - 1); // strip line header and 0x0D
  const got = Array.from(body.subarray(1)); // strip REM token
  check('all 255 bytes encode exactly', got.length === bytes.length && got.every((v, i) => v === bytes[i]),
    `got ${got.length} of ${bytes.length}`);

  // ...and detokenising them must reproduce the same source bytes.
  const { text } = detokenizeProgram(data, data.length);
  const again = programData(await textToTap(text, { name: 'ESC' }));
  check('detokenise -> retokenise is stable',
    again.length === data.length && again.every((v, i) => v === data[i]),
    `${again.length} vs ${data.length} bytes`);
}

/* -------------------------------------------------------- language corners */

console.log('language corners');
const corners: [string, string][] = [
  ['keyword after variable', '10 FOR q=1 TO l STEP 2\n20 NEXT q\n'],
  ['DEF FN', '10 DEF FN s(x)=x*x\n20 PRINT FN s(4)\n'],
  ['string with quotes', '10 LET a$="say ""hi"" now"\n'],
  ['block graphics', '10 PRINT "\\::\\  \\\'.\\.\'"\n'],
  ['UDGs', '10 PRINT "\\a\\b\\c\\u"\n'],
  ['BIN', '10 LET a=BIN 10101010\n'],
  ['exponent literals', '10 LET a=1.5E10:LET b=2E-5\n'],
  ['negative numbers', '10 LET a=-1:LET b=-32768\n'],
  ['comparison tokens', '10 IF a<=1 AND b>=2 OR c<>3 THEN STOP\n'],
  ['REM to end of line', '10 REM PRINT "not a token" 123\n'],
  ['empty REM', '10 REM \n'],
  ['PRINT with channels', '10 PRINT #0;AT 0,0;"x"\n'],
  ['nested parens + functions', '10 LET a=INT (RND*10)+LEN STR$ 42\n'],
  ['variable names with digits', '10 LET m1=1:LET m2=m1+1:LET j3=.0625\n'],
];

for (const [name, src] of corners) {
  let data: Uint8Array;
  try {
    data = programData(await textToTap(src, { name: 'T' }));
  } catch (e) {
    check(name, false, `compile failed: ${(e as Error).message}`);
    continue;
  }
  const { text, warnings } = detokenizeProgram(data, data.length);
  let again: Uint8Array;
  try {
    again = programData(await textToTap(text, { name: 'T' }));
  } catch (e) {
    check(name, false, `recompile failed: ${(e as Error).message}\n       listing: ${JSON.stringify(text)}`);
    continue;
  }
  const same = again.length === data.length && again.every((v, i) => v === data[i]);
  check(name, same && warnings.length === 0,
    same ? `warnings: ${warnings.join('; ')}`
         : `listing ${JSON.stringify(text.trimEnd())}\n       orig ${hex(data)}\n       new  ${hex(again)}`);
}

/* ------------------------------------------------------------ renumbering */

console.log('renumbering');
{
  const prog = [
    '10 GO SUB 100:GO TO 30',
    '20 RESTORE 60:PRINT "GO TO 999"',
    '30 IF a=1 THEN GO TO 20',
    '40 REM GO TO 999',
    '50 INPUT LINE a$',
    '60 DATA 1,2,3',
    '100 SAVE "x" LINE 10',
    '110 RETURN',
  ].join('\n') + '\n';

  const before = referenceGraph(prog);
  for (const [start, step] of [[10, 10], [1, 1], [500, 7]] as [number, number][]) {
    const r = renumber(prog, { start, step });
    check(`graph preserved at ${start}/${step}`,
      JSON.stringify(referenceGraph(r.text)) === JSON.stringify(before));
    check(`no spurious warnings at ${start}/${step}`, r.warnings.length === 0,
      r.warnings.join('; '));
  }

  const a = renumber(prog, { start: 10, step: 10 });
  check('idempotent', renumber(a.text, { start: 10, step: 10 }).text === a.text);
  check('composition equals direct',
    renumber(renumber(prog, { start: 900, step: 3 }).text, { start: 10, step: 10 }).text === a.text);

  // Content that merely looks like a reference must survive untouched.
  check('string content untouched', a.text.includes('PRINT "GO TO 999"'));
  check('REM content untouched', a.text.includes('REM GO TO 999'));
  check('INPUT LINE not renumbered', /INPUT LINE a\$/.test(a.text));
  check('SAVE ... LINE is renumbered', /SAVE "x" LINE 10\b/.test(a.text));

  // A jump into a gap must land where the ROM would have continued.
  const gap = renumber('10 GO TO 35\n20 PRINT "a"\n40 PRINT "c"\n', { start: 100, step: 100 });
  check('gap jump retargeted', gap.text.startsWith('100 GO TO 300'), gap.text.split('\n')[0]);
  check('gap jump warned', gap.warnings.length === 1);

  // Overflowing the line-number ceiling must be refused, not silently wrapped.
  let threw = false;
  try { renumber(prog, { start: 9990, step: 10 }); } catch { threw = true; }
  check('rejects overflow past 9999', threw);
}

/* --------------------------------------------------------- pasted listings */

console.log('pasted listing normalisation');
{
  const clean = programData(await textToTap('10 PRINT "hi"\n20 GO TO 10\n', { name: 'T' }));

  // CRLF silently embeds a stray 0x0D in each line unless normalised.
  const crlf = normalizeListing('10 PRINT "hi"\r\n20 GO TO 10\r\n');
  check('CRLF reported', crlf.issues.some((i) => i.kind === 'line-endings'));
  const crlfData = programData(await textToTap(crlf.text, { name: 'T' }));
  check('CRLF normalised matches clean source',
    crlfData.length === clean.length && crlfData.every((v, i) => v === clean[i]),
    `${crlfData.length} vs ${clean.length} bytes`);

  const cr = normalizeListing('10 PRINT "hi"\r20 GO TO 10\r');
  const crData = programData(await textToTap(cr.text, { name: 'T' }));
  check('lone CR normalised matches clean source',
    crData.length === clean.length && crData.every((v, i) => v === clean[i]),
    `${crData.length} vs ${clean.length} bytes`);

  // Smart quotes compile without error but produce no string at all.
  const smart = normalizeListing('10 PRINT “hi”\n20 GO TO 10\n');
  check('smart quotes reported', smart.issues.some((i) => i.kind === 'smart-punctuation'));
  const smartData = programData(await textToTap(smart.text, { name: 'T' }));
  check('smart quotes normalised matches clean source',
    smartData.length === clean.length && smartData.every((v, i) => v === clean[i]),
    `${smartData.length} vs ${clean.length} bytes`);

  // A non-breaking space is invisible and is not a space.
  const nb = normalizeListing('10 PRINT "hi"\n');
  check('nbsp replaced', !nb.text.includes(' '));

  // Unfixable problems must be reported rather than quietly passed through.
  const bad = normalizeListing('PRINT "hi"\nGO TO 10\n');
  check('missing line numbers reported',
    bad.issues.some((i) => i.kind === 'missing-line-number' && i.count === 2 && !i.fixed));
  const cyr = normalizeListing('10 REM Привет\n');
  check('remaining non-ASCII reported',
    cyr.issues.some((i) => i.kind === 'non-ascii' && !i.fixed));

  check('clean input reports nothing', normalizeListing('10 PRINT "hi"\n').issues.length === 0);
  check('BOM stripped', !normalizeListing('﻿10 PRINT "hi"\n').text.startsWith('﻿'));

  check('tape name truncated to 10', sanitizeTapeName('VERYLONGNAMEINDEED').length === 10);
  check('tape name falls back', sanitizeTapeName('   ') === 'PROGRAM');
  check('tape name strips non-ASCII', sanitizeTapeName('ПитонX') === 'X');
}

/* ------------------------------------------------------------- persistence */

console.log('session persistence');
{
  // Node has no localStorage; the module only needs get/set/removeItem.
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  };
  const { saveSession, loadSession, clearSession } = await import('../src/core/session.ts');

  check('nothing stored yet', loadSession() === null);

  // A tape with every byte value, to catch any base64/latin1 mangling.
  const tap = new Uint8Array(1024);
  for (let i = 0; i < tap.length; i++) tap[i] = i & 0xff;
  const overrides = [{
    line: 60, index: 2, digits: '0', value: 27, bytes: new Uint8Array([0, 0, 27, 0, 0]),
  }];

  const w = saveSession({ filename: 'Piton3.tap', tap, text: '10 REM hi\n', overrides });
  check('save reports ok', w.ok, w.reason ?? '');

  const back = loadSession();
  check('restores', back !== null);
  if (back) {
    check('filename survives', back.filename === 'Piton3.tap');
    check('text survives', back.text === '10 REM hi\n');
    check('tape bytes survive exactly',
      back.tap.length === tap.length && back.tap.every((v, i) => v === tap[i]));
    check('override survives', back.overrides.length === 1
      && back.overrides[0].value === 27
      && Array.from(back.overrides[0].bytes).join() === '0,0,27,0,0');
    check('timestamp is a Date', back.savedAt instanceof Date);
  }

  clearSession();
  check('clear removes it', loadSession() === null);

  // A corrupt entry must not wedge startup.
  store.set('zx-bas-editor:session', '{not json');
  check('corrupt entry returns null', loadSession() === null);
  check('corrupt entry is cleared', !store.has('zx-bas-editor:session'));

  // Storage being unavailable (private mode, blocked) must not throw.
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('denied'); },
    removeItem: () => { throw new Error('denied'); },
  };
  let threw = false;
  try {
    check('load survives blocked storage', loadSession() === null);
    check('save reports failure not throw', saveSession({ filename: 'x', tap, text: '', overrides: [] }).ok === false);
  } catch { threw = true; }
  check('blocked storage never throws', !threw);
}

function hex(u: Uint8Array) {
  return Array.from(u, (x) => x.toString(16).padStart(2, '0')).join(' ');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
