/**
 * TAP container: a bare sequence of
 *   [u16 length LE][flag][...payload...][xor checksum]
 * where flag 0x00 introduces a 17-byte header and 0xFF a data block.
 */

export const FileType = {
  Program: 0, NumberArray: 1, CharArray: 2, Code: 3,
} as const;
export type FileType = (typeof FileType)[keyof typeof FileType];

export interface TapHeader {
  kind: 'header';
  type: FileType;
  name: string;        // 10 chars, space padded
  dataLength: number;
  param1: number;      // Program: autostart line (>=32768 => none). Code: load address.
  param2: number;      // Program: offset of the variables area.
  raw: Uint8Array;     // full block incl. flag+checksum, for byte-exact passthrough
  checksumOk: boolean;
}

export interface TapData {
  kind: 'data';
  flag: number;
  payload: Uint8Array; // without flag and checksum
  raw: Uint8Array;
  checksumOk: boolean;
}

export type TapBlock = TapHeader | TapData;

const latin1 = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join('');

export function xorChecksum(bytes: Uint8Array): number {
  let x = 0;
  for (const b of bytes) x ^= b;
  return x;
}

export function parseTap(buf: Uint8Array): TapBlock[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const blocks: TapBlock[] = [];
  let p = 0;
  while (p + 2 <= buf.length) {
    const len = dv.getUint16(p, true);
    p += 2;
    if (len < 2 || p + len > buf.length) {
      throw new Error(`truncated TAP: block at offset ${p - 2} claims ${len} bytes`);
    }
    const raw = buf.subarray(p, p + len);
    p += len;
    const checksumOk = xorChecksum(raw.subarray(0, len - 1)) === raw[len - 1];
    const flag = raw[0];

    if (flag === 0x00 && len === 19) {
      const h = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      blocks.push({
        kind: 'header',
        type: raw[1] as FileType,
        name: latin1(raw.subarray(2, 12)),
        dataLength: h.getUint16(12, true),
        param1: h.getUint16(14, true),
        param2: h.getUint16(16, true),
        raw,
        checksumOk,
      });
    } else {
      blocks.push({ kind: 'data', flag, payload: raw.subarray(1, len - 1), raw, checksumOk });
    }
  }
  return blocks;
}

/** Wrap flag+payload into a full length-prefixed block with a fresh checksum. */
export function makeBlock(flag: number, payload: Uint8Array): Uint8Array {
  const body = new Uint8Array(1 + payload.length + 1);
  body[0] = flag;
  body.set(payload, 1);
  body[body.length - 1] = xorChecksum(body.subarray(0, body.length - 1));
  const out = new Uint8Array(2 + body.length);
  out[0] = body.length & 0xff;
  out[1] = (body.length >> 8) & 0xff;
  out.set(body, 2);
  return out;
}

export function makeProgramHeader(
  name: string,
  dataLength: number,
  autostart: number,
  varsOffset: number,
): Uint8Array {
  const p = new Uint8Array(17);
  p[0] = FileType.Program;
  const padded = (name + '          ').slice(0, 10);
  for (let i = 0; i < 10; i++) p[1 + i] = padded.charCodeAt(i) & 0xff;
  const dv = new DataView(p.buffer);
  dv.setUint16(11, dataLength, true);
  dv.setUint16(13, autostart, true);
  dv.setUint16(15, varsOffset, true);
  return makeBlock(0x00, p);
}

export function concatBlocks(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, x) => n + x.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const x of parts) { out.set(x, o); o += x.length; }
  return out;
}

export function describeBlock(b: TapBlock): string {
  if (b.kind === 'header') {
    const names = ['Program', 'Number array', 'Char array', 'Code'];
    const t = names[b.type] ?? `type ${b.type}`;
    const extra =
      b.type === FileType.Program
        ? `, autostart ${b.param1 >= 32768 ? 'none' : b.param1}, vars@${b.param2}`
        : b.type === FileType.Code
          ? `, load @${b.param1}`
          : '';
    return `${t} "${b.name.trimEnd()}" (${b.dataLength} bytes${extra})`;
  }
  return `Data block, ${b.payload.length} bytes (flag 0x${b.flag.toString(16).padStart(2, '0')})`;
}
