import { detokenizeProgram, type FloatOverride } from './core/detokenize.ts';
import { EmulatorSession } from './core/emulator.ts';
import { normalizeListing, sanitizeTapeName } from './core/paste.ts';
import { renumber } from './core/renumber.ts';
import { clearSession, describeAge, loadSession, saveSession } from './core/session.ts';
import { buildTap } from './core/save.ts';
import { FileType, describeBlock, parseTap, type TapBlock, type TapHeader } from './core/tap.ts';
import { ZmakebasError, textToTap } from './core/zmakebas.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const els = {
  open: $<HTMLButtonElement>('open'),
  save: $<HTMLButtonElement>('save'),
  verify: $<HTMLButtonElement>('verify'),
  file: $<HTMLInputElement>('file'),
  code: $<HTMLTextAreaElement>('code'),
  gutter: $<HTMLPreElement>('gutter'),
  blocks: $<HTMLUListElement>('blocks'),
  header: $<HTMLDListElement>('header'),
  notes: $<HTMLDivElement>('notes'),
  status: $<HTMLDivElement>('status'),
  drop: $<HTMLDivElement>('drop'),
  run: $<HTMLButtonElement>('run'),
  emu: $<HTMLDivElement>('emu'),
  emuHost: $<HTMLDivElement>('emu-host'),
  emuTitle: $<HTMLSpanElement>('emu-title'),
  emuMachine: $<HTMLSelectElement>('emu-machine'),
  emuReload: $<HTMLButtonElement>('emu-reload'),
  emuClose: $<HTMLButtonElement>('emu-close'),
  renumber: $<HTMLButtonElement>('renumber'),
  renum: $<HTMLDivElement>('renum'),
  renumStart: $<HTMLInputElement>('renum-start'),
  renumStep: $<HTMLInputElement>('renum-step'),
  renumPreview: $<HTMLParagraphElement>('renum-preview'),
  renumWarnings: $<HTMLDivElement>('renum-warnings'),
  renumApply: $<HTMLButtonElement>('renum-apply'),
  renumCancel: $<HTMLButtonElement>('renum-cancel'),
  paste: $<HTMLButtonElement>('paste'),
  pasteDlg: $<HTMLDivElement>('paste-dlg'),
  pasteText: $<HTMLTextAreaElement>('paste-text'),
  pasteName: $<HTMLInputElement>('paste-name'),
  pasteAutostart: $<HTMLInputElement>('paste-autostart'),
  pastePreview: $<HTMLParagraphElement>('paste-preview'),
  pasteIssues: $<HTMLDivElement>('paste-issues'),
  pasteCreate: $<HTMLButtonElement>('paste-create'),
  pasteCancel: $<HTMLButtonElement>('paste-cancel'),
  pasteClipboard: $<HTMLButtonElement>('paste-clipboard'),
};

const emulator = new EmulatorSession(els.emuHost);

interface Loaded {
  filename: string;
  blocks: TapBlock[];
  header: TapHeader;
  originalData: Uint8Array;
  originalTap: Uint8Array;
  overrides: FloatOverride[];
  trailing: TapBlock[];
}

let loaded: Loaded | null = null;

/* ---------------------------------------------------------------- loading */

async function loadFile(file: File) {
  const buf = new Uint8Array(await file.arrayBuffer());
  if (adoptTap(buf, file.name)) persist();
}

/**
 * Take a tape into the editor. `resume` carries state from a previous session:
 * the edited text and its overrides. Everything else is always recomputed from
 * the tape bytes, so restoring cannot drift from what a fresh load would give.
 */
function adoptTap(
  buf: Uint8Array,
  filename: string,
  resume?: { text: string; overrides: FloatOverride[] },
): boolean {
  let blocks: TapBlock[];
  try {
    blocks = parseTap(buf);
  } catch (e) {
    setStatus(`Could not parse ${filename}: ${(e as Error).message}`, 'bad');
    return false;
  }

  renderBlocks(blocks);

  const idx = blocks.findIndex((b) => b.kind === 'header' && b.type === FileType.Program);
  if (idx === -1) {
    setStatus(`${filename} contains no BASIC program block — nothing to edit.`, 'warn');
    els.code.value = '';
    setEnabled(false);
    loaded = null;
    updateGutter();
    return false;
  }

  const header = blocks[idx] as TapHeader;
  const data = blocks[idx + 1];
  if (!data || data.kind !== 'data') {
    setStatus('Program header is not followed by a data block.', 'bad');
    return false;
  }

  const { text, overrides, warnings, lineCount } = detokenizeProgram(data.payload, header.param2);

  loaded = {
    filename,
    blocks,
    header,
    originalData: data.payload,
    originalTap: buf,
    overrides: resume?.overrides ?? overrides,
    trailing: blocks.slice(idx + 2),
  };

  els.code.value = resume?.text ?? text;
  // The snapshot is always the pristine listing, so "was this edited?" stays
  // meaningful across a reload.
  loadedTextSnapshot = text;
  setEnabled(true);
  renderHeader(header);
  renderNotes(warnings, loaded.overrides);
  updateGutter();
  setStatus(`Loaded ${filename} — ${lineCount} BASIC lines, ${data.payload.length} bytes.`, 'ok');

  // An unedited file should re-save to the exact same bytes; prove it up front.
  void verify(true);
  return true;
}

function setEnabled(on: boolean) {
  els.save.disabled = els.verify.disabled = els.run.disabled = els.renumber.disabled = !on;
}

/* ------------------------------------------------------------- persistence */

let persistTimer: number | undefined;

function persist() {
  if (!loaded) return;
  const r = saveSession({
    filename: loaded.filename,
    tap: loaded.originalTap,
    text: els.code.value,
    overrides: loaded.overrides,
  });
  if (!r.ok) els.status.title = `Not saved for next time: ${r.reason}`;
  else els.status.title = '';
}

/** Coalesce keystrokes; writing the whole tape on every character is wasteful. */
function persistSoon() {
  window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(persist, 400);
}

function restoreSession() {
  const s = loadSession();
  if (!s) {
    // The browser may have refilled the textarea on its own; without state
    // behind it that is just a dead listing, so clear it.
    els.code.value = '';
    updateGutter();
    return;
  }
  if (!adoptTap(s.tap, s.filename, { text: s.text, overrides: s.overrides })) {
    clearSession();
    return;
  }
  const edited = els.code.value !== loadedTextSnapshot;
  setStatus(
    `Restored ${s.filename} from ${describeAge(s.savedAt)}${edited ? ' (with unsaved edits)' : ''}.`,
    'ok',
  );
}

/* ------------------------------------------------------------------ saving */

async function currentTap() {
  if (!loaded) throw new Error('nothing loaded');
  return buildTap(els.code.value, {
    name: loaded.header.name,
    autostart: loaded.header.param1,
    overrides: loaded.overrides,
    trailingBlocks: loaded.trailing,
  });
}

async function save() {
  if (!loaded) return;
  try {
    const { tap, programData } = await currentTap();
    const blob = new Blob([tap as BlobPart], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = loaded.filename.replace(/\.tap$/i, '') + '.tap';
    a.click();
    URL.revokeObjectURL(a.href);
    setStatus(`Saved ${a.download} — ${programData.length} bytes of BASIC, ${tap.length} bytes total.`, 'ok');
  } catch (e) {
    reportBuildError(e);
  }
}

/* ------------------------------------------------------------------ paste */

function previewPaste() {
  const raw = els.pasteText.value;
  els.pasteIssues.innerHTML = '';
  if (raw.trim() === '') {
    els.pastePreview.className = 'renum-preview';
    els.pastePreview.textContent = '—';
    els.pasteCreate.disabled = true;
    return null;
  }

  const { text, issues } = normalizeListing(raw);
  const lines = text.split('\n').filter((l) => l.trim() !== '').length;
  const blocking = issues.some((i) => i.kind === 'missing-line-number');

  els.pastePreview.className = 'renum-preview' + (blocking ? ' bad' : '');
  els.pastePreview.textContent = `${lines} line${lines === 1 ? '' : 's'} ready to compile`;
  if (issues.length) {
    els.pasteIssues.innerHTML = issues
      .map((i) => `<span class="${i.fixed ? 'fixed' : ''}">${i.fixed ? '✓ ' : '! '}${escapeHtml(i.message)}</span>`)
      .join('<br>');
  }
  els.pasteCreate.disabled = blocking;
  return text;
}

async function createFromPaste() {
  const text = previewPaste();
  if (text === null) return;

  const name = sanitizeTapeName(els.pasteName.value);
  const autoRaw = els.pasteAutostart.value.trim();
  const autostart = autoRaw === '' ? 32768 : Number(autoRaw);

  let tap: Uint8Array;
  try {
    tap = await textToTap(text, { name, autostart });
  } catch (e) {
    const msg = e instanceof ZmakebasError ? e.message : (e as Error).message;
    els.pastePreview.className = 'renum-preview bad';
    els.pastePreview.textContent = `Cannot compile: ${msg}`;
    return;
  }

  els.pasteDlg.hidden = true;
  if (adoptTap(tap, `${name}.tap`)) {
    persist();
    setStatus(`Created ${name}.tap from pasted listing — ${tap.length} bytes.`, 'ok');
  }
}

async function readClipboardIntoPaste() {
  try {
    const t = await navigator.clipboard.readText();
    if (t) { els.pasteText.value = t; previewPaste(); }
  } catch {
    // Firefox only allows this behind a paste prompt, and it may be refused.
    els.pastePreview.className = 'renum-preview bad';
    els.pastePreview.textContent =
      'Clipboard read was refused — click in the box below and paste with Cmd/Ctrl+V instead.';
    els.pasteText.focus();
  }
}

/* ------------------------------------------------------------- renumbering */

function renumberSettings() {
  return {
    start: Number(els.renumStart.value) || 10,
    step: Number(els.renumStep.value) || 10,
  };
}

/** Recompute the dialog preview without touching the editor. */
function previewRenumber() {
  els.renumWarnings.innerHTML = '';
  let result;
  try {
    result = renumber(els.code.value, renumberSettings());
  } catch (e) {
    els.renumPreview.className = 'renum-preview bad';
    els.renumPreview.textContent = (e as Error).message;
    els.renumApply.disabled = true;
    return null;
  }

  const numbers = [...result.mapping.values()];
  els.renumPreview.className = 'renum-preview';
  els.renumPreview.textContent =
    `${result.mapping.size} lines -> ${numbers[0] ?? 0}..${numbers.at(-1) ?? 0}, ` +
    `${result.rewritten} reference${result.rewritten === 1 ? '' : 's'} rewritten`;
  if (result.warnings.length) {
    els.renumWarnings.innerHTML = result.warnings.map(escapeHtml).join('<br>');
  }
  els.renumApply.disabled = false;
  return result;
}

function applyRenumber() {
  const result = previewRenumber();
  if (!result || !loaded) return;

  els.code.value = result.text;
  // Stored-value overrides are keyed by line number, so they move too --
  // otherwise a renumber would quietly drop them on the next save.
  loaded.overrides = loaded.overrides.map((o) => ({
    ...o,
    line: result.mapping.get(o.line) ?? o.line,
  }));

  updateGutter();
  persist();
  els.renum.hidden = true;
  setStatus(
    `Renumbered ${result.mapping.size} lines, rewriting ${result.rewritten} reference(s).` +
      (result.warnings.length ? ` ${result.warnings.length} warning(s) — see Notes.` : ''),
    result.warnings.length ? 'warn' : 'ok',
  );
  if (result.warnings.length) {
    result.warnings.forEach((w) => appendNote(w, 'warn'));
  }
}

/* --------------------------------------------------------------- emulator */

async function runInEmulator() {
  if (!loaded) return;
  els.emu.hidden = false;
  els.emuTitle.textContent = `Running ${loaded.header.name.trimEnd() || loaded.filename}`;
  try {
    const { tap } = await currentTap();
    await emulator.run(tap, {
      machine: Number(els.emuMachine.value),
      name: loaded.header.name.trimEnd() || 'tape',
    });
    setStatus(`Running in emulator — ${tap.length} bytes sent to the tape deck.`, 'ok');
  } catch (e) {
    closeEmulator();
    reportBuildError(e);
  }
}

function closeEmulator() {
  emulator.stop();
  els.emu.hidden = true;
}

async function verify(quiet = false) {
  if (!loaded) return;
  try {
    const { tap, appliedOverrides, unappliedOverrides } = await currentTap();
    const orig = loaded.originalTap;
    const identical = tap.length === orig.length && tap.every((v, i) => v === orig[i]);
    const edited = els.code.value !== lastLoadedText();

    if (identical) {
      setStatus('Round-trip verified: re-saving reproduces the original file byte for byte.', 'ok');
    } else if (edited) {
      const extra = appliedOverrides ? ` ${appliedOverrides} stored value(s) preserved.` : '';
      setStatus(
        `Compiles cleanly — ${tap.length} bytes (original ${orig.length}). Differs because the listing was edited.${extra}`,
        'ok',
      );
    } else {
      setStatus(
        `Warning: no edits made, yet the rebuilt file differs from the original (${tap.length} vs ${orig.length} bytes). ` +
          'Saving would not be a faithful copy.',
        'warn',
      );
    }
    if (unappliedOverrides.length && !quiet) {
      appendNote(
        `${unappliedOverrides.length} stored value(s) could not be re-applied because their line changed.`,
        'warn',
      );
    }
  } catch (e) {
    reportBuildError(e);
  }
}

function reportBuildError(e: unknown) {
  if (e instanceof ZmakebasError) {
    setStatus(`Cannot compile: ${e.message}`, 'bad');
    if (e.diagnostics.length > 1) {
      els.notes.innerHTML =
        '<p class="bad">' + e.diagnostics.map(escapeHtml).join('<br>') + '</p>';
    }
  } else {
    setStatus(`Cannot compile: ${(e as Error).message}`, 'bad');
  }
}

/* --------------------------------------------------------------- rendering */

let loadedTextSnapshot = '';
const lastLoadedText = () => loadedTextSnapshot;

function renderBlocks(blocks: TapBlock[]) {
  els.blocks.innerHTML = '';
  blocks.forEach((b, i) => {
    const li = document.createElement('li');
    if (b.kind === 'header' && b.type === FileType.Program) li.classList.add('program');
    if (!b.checksumOk) li.classList.add('bad');
    li.innerHTML =
      `${i}. ${escapeHtml(describeBlock(b))}` +
      (b.checksumOk ? '' : '<span class="sub">checksum mismatch</span>');
    els.blocks.appendChild(li);
  });
}

function renderHeader(h: TapHeader) {
  const rows: [string, string][] = [
    ['Name', h.name.trimEnd() || '(blank)'],
    ['Length', `${h.dataLength} bytes`],
    ['Autostart', h.param1 >= 32768 ? `none (${h.param1})` : String(h.param1)],
    ['Variables', h.param2 >= h.dataLength ? 'none' : `at ${h.param2}`],
  ];
  els.header.innerHTML = rows
    .map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`)
    .join('');
}

function renderNotes(warnings: string[], overrides: FloatOverride[]) {
  const parts: string[] = [];
  if (overrides.length) {
    parts.push(
      `<p class="warn">${overrides.length} numeric literal(s) store a value that differs from the digits shown. ` +
        'The stored value is what the Spectrum uses, and it is preserved on save:</p>',
    );
    parts.push(
      '<p>' +
        overrides
          .slice(0, 12)
          .map((o) => `line ${o.line}: <code>${escapeHtml(o.digits)}</code> &rarr; ${o.value}`)
          .join('<br>') +
        '</p>',
    );
  }
  if (warnings.length) {
    parts.push('<p class="warn">' + warnings.slice(0, 12).map(escapeHtml).join('<br>') + '</p>');
  }
  if (!parts.length) {
    parts.push('<p>Listing decoded with no anomalies.</p>');
  }
  els.notes.innerHTML = parts.join('');
}

function appendNote(msg: string, cls = '') {
  els.notes.insertAdjacentHTML('beforeend', `<p class="${cls}">${escapeHtml(msg)}</p>`);
}

function setStatus(msg: string, cls = '') {
  els.status.className = 'status ' + cls;
  els.status.textContent = msg;
}

function updateGutter() {
  const n = els.code.value.split('\n').length;
  els.gutter.textContent = Array.from({ length: n }, (_, i) => String(i + 1)).join('\n');
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/* ------------------------------------------------------------------ wiring */

els.open.addEventListener('click', () => els.file.click());
els.file.addEventListener('change', () => {
  const f = els.file.files?.[0];
  if (f) void loadFile(f);
  els.file.value = '';
});
els.save.addEventListener('click', () => void save());
els.verify.addEventListener('click', () => void verify());
els.run.addEventListener('click', () => void runInEmulator());
els.paste.addEventListener('click', () => {
  els.pasteDlg.hidden = false;
  previewPaste();
  els.pasteText.focus();
});
els.pasteText.addEventListener('input', previewPaste);
els.pasteText.addEventListener('paste', () => window.setTimeout(previewPaste, 0));
els.pasteCreate.addEventListener('click', () => void createFromPaste());
els.pasteClipboard.addEventListener('click', () => void readClipboardIntoPaste());
els.pasteCancel.addEventListener('click', () => { els.pasteDlg.hidden = true; });
els.pasteDlg.addEventListener('click', (e) => { if (e.target === els.pasteDlg) els.pasteDlg.hidden = true; });
els.renumber.addEventListener('click', () => { els.renum.hidden = false; previewRenumber(); });
els.renumStart.addEventListener('input', previewRenumber);
els.renumStep.addEventListener('input', previewRenumber);
els.renumApply.addEventListener('click', applyRenumber);
els.renumCancel.addEventListener('click', () => { els.renum.hidden = true; });
els.renum.addEventListener('click', (e) => { if (e.target === els.renum) els.renum.hidden = true; });
els.emuReload.addEventListener('click', () => void runInEmulator());
els.emuMachine.addEventListener('change', () => { if (!els.emu.hidden) void runInEmulator(); });
els.emuClose.addEventListener('click', closeEmulator);
els.emu.addEventListener('click', (e) => { if (e.target === els.emu) closeEmulator(); });
window.addEventListener('keydown', (e) => {
  // The emulator grabs most keys for the Spectrum keyboard; Escape stays ours.
  if (e.key !== 'Escape') return;
  if (!els.emu.hidden) closeEmulator();
  else if (!els.renum.hidden) els.renum.hidden = true;
  else if (!els.pasteDlg.hidden) els.pasteDlg.hidden = true;
});

els.code.addEventListener('input', () => { updateGutter(); persistSoon(); });
els.code.addEventListener('scroll', () => { els.gutter.scrollTop = els.code.scrollTop; });

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); if (++dragDepth === 1) els.drop.classList.add('on'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; els.drop.classList.remove('on'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  els.drop.classList.remove('on');
  const f = e.dataTransfer?.files?.[0];
  if (f) void loadFile(f);
});

restoreSession();
