/**
 * Session persistence.
 *
 * Without this the app looks like it survives a reload but does not: browsers
 * restore a <textarea>'s contents by themselves, so the listing reappears while
 * every button stays disabled and no in-memory state exists behind it. Rather
 * than suppress that restoration, we persist enough to genuinely resume.
 *
 * The original tape is stored verbatim. Everything derived from it -- header
 * fields, trailing blocks, the pristine listing used for the "was this edited?"
 * comparison -- is recomputed on restore by re-parsing, so only three things
 * need saving: the file, the current text, and the stored-value overrides
 * (which renumbering can move away from their original line numbers).
 */

import type { FloatOverride } from './detokenize.ts';

const KEY = 'zx-bas-editor:session';
const VERSION = 1;

/** localStorage is a ~5MB string store; base64 costs 4 bytes per 3. */
const MAX_TAP_BYTES = 2 * 1024 * 1024;

interface StoredOverride {
  line: number;
  index: number;
  digits: string;
  value: number;
  bytes: number[];
}

interface StoredSession {
  version: number;
  filename: string;
  tap: string; // base64
  text: string;
  overrides: StoredOverride[];
  savedAt: number;
}

export interface Session {
  filename: string;
  tap: Uint8Array;
  text: string;
  overrides: FloatOverride[];
  savedAt: Date;
}

/* Chunked to avoid blowing the argument limit on large tapes. */
function toBase64(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function saveSession(s: Omit<Session, 'savedAt'>): { ok: boolean; reason?: string } {
  if (s.tap.length > MAX_TAP_BYTES) {
    return { ok: false, reason: `tape is ${(s.tap.length / 1024 / 1024).toFixed(1)}MB, too large to keep` };
  }
  const stored: StoredSession = {
    version: VERSION,
    filename: s.filename,
    tap: toBase64(s.tap),
    text: s.text,
    overrides: s.overrides.map((o) => ({
      line: o.line, index: o.index, digits: o.digits, value: o.value,
      bytes: Array.from(o.bytes),
    })),
    savedAt: Date.now(),
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(stored));
    return { ok: true };
  } catch (e) {
    // Quota exceeded, or storage disabled (private browsing, blocked cookies).
    return { ok: false, reason: (e as Error).message };
  }
}

export function loadSession(): Session | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return null; // storage unavailable
  }
  if (!raw) return null;

  try {
    const s = JSON.parse(raw) as StoredSession;
    if (s.version !== VERSION) return null;
    return {
      filename: s.filename,
      tap: fromBase64(s.tap),
      text: s.text,
      overrides: s.overrides.map((o) => ({
        line: o.line, index: o.index, digits: o.digits, value: o.value,
        bytes: new Uint8Array(o.bytes),
      })),
      savedAt: new Date(s.savedAt),
    };
  } catch {
    clearSession(); // corrupt entry helps nobody
    return null;
  }
}

export function clearSession() {
  try { localStorage.removeItem(KEY); } catch { /* nothing to do */ }
}

export function describeAge(when: Date): string {
  const mins = Math.floor((Date.now() - when.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
