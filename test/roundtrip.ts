/**
 * Round-trip check: TAP -> text -> TAP, asserting the program data comes back
 * byte-identical. Run with:  node --experimental-strip-types test/roundtrip.ts [file.tap ...]
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { detokenizeProgram } from '../src/core/detokenize.ts';
import { FileType, parseTap, describeBlock, type TapBlock } from '../src/core/tap.ts';
import { textToTap } from '../src/core/zmakebas.ts';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: roundtrip.ts <file.tap> ...');
  process.exit(2);
}

let failures = 0;

for (const file of files) {
  console.log(`\n=== ${basename(file)} ===`);
  const buf = new Uint8Array(readFileSync(file));
  let blocks: TapBlock[];
  try {
    blocks = parseTap(buf);
  } catch (e) {
    console.log(`  PARSE FAILED: ${(e as Error).message}`);
    failures++;
    continue;
  }

  for (const b of blocks) {
    console.log(`  ${describeBlock(b)}${b.checksumOk ? '' : '  [BAD CHECKSUM]'}`);
  }

  for (let i = 0; i < blocks.length; i++) {
    const h = blocks[i];
    if (h.kind !== 'header' || h.type !== FileType.Program) continue;
    const d = blocks[i + 1];
    if (!d || d.kind !== 'data') continue;

    const original = d.payload;
    const { text, overrides, warnings, lineCount } = detokenizeProgram(original, h.param2);
    console.log(`  -> ${lineCount} BASIC lines, ${text.length} chars of text`);
    for (const w of warnings.slice(0, 10)) console.log(`     warn: ${w}`);
    if (overrides.length) {
      console.log(`     ${overrides.length} literal(s) whose stored value != digits:`);
      for (const o of overrides.slice(0, 10)) {
        console.log(`       line ${o.line}: "${o.digits}" actually ${o.value}`);
      }
    }

    let rebuilt: Uint8Array;
    try {
      rebuilt = await textToTap(text, { name: h.name, autostart: h.param1 });
    } catch (e) {
      console.log(`  RETOKENIZE FAILED: ${(e as Error).message}`);
      failures++;
      continue;
    }

    const rb = parseTap(rebuilt);
    const newData = rb.find((x) => x.kind === 'data') as Extract<TapBlock, { kind: 'data' }> | undefined;
    if (!newData) { console.log('  RETOKENIZE produced no data block'); failures++; continue; }

    const got = newData.payload;
    if (got.length === original.length && got.every((v, k) => v === original[k])) {
      console.log(`  ROUND-TRIP: byte-exact (${got.length} bytes)`);
    } else {
      failures++;
      console.log(`  ROUND-TRIP: MISMATCH (orig ${original.length} vs new ${got.length} bytes)`);
      reportDiff(original, got);
    }
  }
}

function reportDiff(a: Uint8Array, b: Uint8Array) {
  const n = Math.min(a.length, b.length);
  let shown = 0;
  for (let i = 0; i < n && shown < 8; i++) {
    if (a[i] !== b[i]) {
      const from = Math.max(0, i - 12);
      console.log(`     @${i}: orig ${hex(a.subarray(from, i + 12))}`);
      console.log(`          new  ${hex(b.subarray(from, i + 12))}`);
      console.log(`          orig text ${JSON.stringify(txt(a.subarray(from, i + 12)))}`);
      console.log(`          new  text ${JSON.stringify(txt(b.subarray(from, i + 12)))}`);
      shown++;
      i += 12;
    }
  }
}
function hex(u: Uint8Array) {
  return Array.from(u, (x) => x.toString(16).padStart(2, '0')).join(' ');
}
function txt(u: Uint8Array) {
  return Array.from(u, (x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : '.')).join('');
}

process.exit(failures ? 1 : 0);
