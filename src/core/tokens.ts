/**
 * ZX Spectrum BASIC keyword tokens.
 *
 * 48K BASIC uses 0xA5..0xFF. 0xA3/0xA4 are SPECTRUM/PLAY on a 128K only; in a
 * 48K program those byte values appear as UDGs T and U instead, so we do not
 * treat them as keywords here (see charset.ts).
 */
export const FIRST_TOKEN = 0xa5;

export const TOKENS: Record<number, string> = {
  0xa5: 'RND', 0xa6: 'INKEY$', 0xa7: 'PI', 0xa8: 'FN', 0xa9: 'POINT',
  0xaa: 'SCREEN$', 0xab: 'ATTR', 0xac: 'AT', 0xad: 'TAB', 0xae: 'VAL$',
  0xaf: 'CODE', 0xb0: 'VAL', 0xb1: 'LEN', 0xb2: 'SIN', 0xb3: 'COS',
  0xb4: 'TAN', 0xb5: 'ASN', 0xb6: 'ACS', 0xb7: 'ATN', 0xb8: 'LN',
  0xb9: 'EXP', 0xba: 'INT', 0xbb: 'SQR', 0xbc: 'SGN', 0xbd: 'ABS',
  0xbe: 'PEEK', 0xbf: 'IN', 0xc0: 'USR', 0xc1: 'STR$', 0xc2: 'CHR$',
  0xc3: 'NOT', 0xc4: 'BIN', 0xc5: 'OR', 0xc6: 'AND', 0xc7: '<=',
  0xc8: '>=', 0xc9: '<>', 0xca: 'LINE', 0xcb: 'THEN', 0xcc: 'TO',
  0xcd: 'STEP', 0xce: 'DEF FN', 0xcf: 'CAT', 0xd0: 'FORMAT', 0xd1: 'MOVE',
  0xd2: 'ERASE', 0xd3: 'OPEN #', 0xd4: 'CLOSE #', 0xd5: 'MERGE', 0xd6: 'VERIFY',
  0xd7: 'BEEP', 0xd8: 'CIRCLE', 0xd9: 'INK', 0xda: 'PAPER', 0xdb: 'FLASH',
  0xdc: 'BRIGHT', 0xdd: 'INVERSE', 0xde: 'OVER', 0xdf: 'OUT', 0xe0: 'LPRINT',
  0xe1: 'LLIST', 0xe2: 'STOP', 0xe3: 'READ', 0xe4: 'DATA', 0xe5: 'RESTORE',
  0xe6: 'NEW', 0xe7: 'BORDER', 0xe8: 'CONTINUE', 0xe9: 'DIM', 0xea: 'REM',
  0xeb: 'FOR', 0xec: 'GO TO', 0xed: 'GO SUB', 0xee: 'INPUT', 0xef: 'LOAD',
  0xf0: 'LIST', 0xf1: 'LET', 0xf2: 'PAUSE', 0xf3: 'NEXT', 0xf4: 'POKE',
  0xf5: 'PRINT', 0xf6: 'PLOT', 0xf7: 'RUN', 0xf8: 'SAVE', 0xf9: 'RANDOMIZE',
  0xfa: 'IF', 0xfb: 'CLS', 0xfc: 'DRAW', 0xfd: 'CLEAR', 0xfe: 'RETURN',
  0xff: 'COPY',
};

export const TOKEN_REM = 0xea;
export const TOKEN_BIN = 0xc4;
export const TOKEN_DEF_FN = 0xce;
export const NUMBER_MARKER = 0x0e;

/** Keywords that are followed by an operator/symbol rather than a name. */
const NO_TRAILING_SPACE = new Set([0xc7, 0xc8, 0xc9, 0xd3, 0xd4]);

export function tokenText(b: number): string | undefined {
  return TOKENS[b];
}

export function tokenWantsTrailingSpace(b: number): boolean {
  return !NO_TRAILING_SPACE.has(b);
}
