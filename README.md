# ZX BASIC TAP editor

Browser-based editor for ZX Spectrum `.tap` files: load a tape, edit the BASIC
program as plain text, save it back as a `.tap`. Everything runs client-side —
no server, no upload.

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # unit + property tests
npm run test:tap -- path/to/file.tap    # round-trip a real tape
```

## Approach

Only half of this needed writing.

**Text → TAP** is handled by [zmakebas](https://github.com/stever/emscripten-zmakebas)
(Russell Marks, public domain), which ships on npm as a **prebuilt Emscripten
WASM** module. No Emscripten toolchain is required, and the `.wasm` is embedded
as base64 so the browser makes no extra fetch. This is the harder direction —
number encoding, `GO TO` vs `GOTO`, keywords inside strings, `DEF FN`
placeholders — and it has been correct for 25 years.

**TAP → text** did not exist in any published package, so `src/core/detokenize.ts`
implements it.

The container itself (`src/core/tap.ts`) is ~20 lines of length-prefixed blocks
and XOR checksums, which is not worth a dependency.

## Format notes

A TAP file is a bare sequence of `[u16 length LE][flag][payload][xor checksum]`,
where flag `0x00` introduces a 17-byte header and `0xFF` a data block. A BASIC
program is a run of lines, each `[u16 line number BIG-endian][u16 length LE][body][0x0D]`.

Four contexts decide how a body byte is read, and conflating them is what makes
a naive detokeniser emit garbage:

| context | rule |
|---|---|
| inside `"…"` | raw characters — no keyword or number decoding |
| after `REM` | raw characters to end of line |
| after a letter | digits belong to the identifier (`M1`, `J3`), not a literal |
| otherwise | a digit run is a literal, followed by `0x0E` + 5 bytes |

### Numeric literals are stored twice

Every numeric literal appears both as the ASCII digits a `LIST` shows *and* as a
5-byte binary value introduced by `0x0E`. **The interpreter only ever evaluates
the binary form.** The two are allowed to disagree, and protection schemes rely
on exactly that — a listing showing `LET a=0` whose stored value is really 27.

zmakebas regenerates the value from the digits, so a plain round-trip would
silently "correct" such a program and change its behaviour. `detokenize.ts`
therefore decodes each stored value, compares it against the digits, and records
any mismatch as a `FloatOverride`; `save.ts` writes those original bytes back
over zmakebas's output. The editor lists them under **Notes**.

### Header preservation

zmakebas writes `0x8000` as its "no autostart" sentinel, but real tapes carry
other values (`Piton3.tap` uses `0x8024`). Both mean the same thing, but `save.ts`
rebuilds the header with the original value so that loading and re-saving an
untouched file is byte-for-byte identical — which is what makes the
**Verify round-trip** button meaningful.

### Text syntax

The listing uses zmakebas's escape syntax, so files interoperate with existing
tooling. The table was established empirically against the WASM build:

| escape | byte | meaning |
|---|---|---|
| `\\` | `0x5C` | literal backslash |
| `\*` | `0x7F` | © |
| `\<l><r>` | `0x80`–`0x8F` | block graphics; each column char is `' '`, `'` (top), `.` (bottom) or `:` (both) |
| `\a`…`\u` | `0x90`–`0xA4` | UDGs A–U |
| `\{0xNN}` | any | arbitrary byte — the lossless fallback |

Whitespace between tokens is discarded by zmakebas, so the listing is formatted
for readability without affecting the output bytes. A space *is* inserted before
a keyword that would otherwise merge into a preceding name (`TO L` + `STEP` must
not become `TO LSTEP`).

## Pasting a listing

**Paste BASIC…** builds a tape from a listing pasted as text — from a magazine
scan, a forum post, another tool — with no `.tap` needed. Set the tape name and
optional autostart line, paste, and it compiles into a normal editing session.

Pasted text is normalised first, because the realistic failure modes are ones
zmakebas *accepts*, producing a tape that builds and is wrong:

| in the paste | what happens uncorrected |
|---|---|
| CRLF line endings | a literal `0x0D` is embedded in every line |
| smart quotes `“ ”` | not string delimiters at all — the line compiles to mojibake with no string in it |
| non-breaking space | looks exactly like a space, isn't one |

Each fix is reported rather than applied silently, so you can see what your
source actually contained. Problems that cannot be fixed automatically — lines
with no line number, or non-ASCII characters needing `\{0xNN}` — are flagged,
and a missing line number blocks the build rather than producing a bad tape.

The tests assert the real property: CRLF, lone-CR and smart-quote inputs all
compile **byte-identical to the equivalent clean source** once normalised.

There is a *Read clipboard* button, but Firefox only permits programmatic
clipboard reads behind its own paste prompt, so pasting into the box with
Cmd/Ctrl+V is the reliable path and the button falls back to telling you so.

## Session persistence

The tape, the current listing and any stored-value overrides are kept in
`localStorage`, so closing and reopening the tab resumes where you left off.

This exists because the failure mode without it is actively misleading rather
than merely inconvenient: browsers restore a `<textarea>`'s contents on their
own, so the listing would reappear after a reload while every button stayed
disabled and no state existed behind it — the app looked alive but was not. The
textarea is now marked `autocomplete="off"` so the browser stops half-restoring
it, and the app restores itself properly instead.

Only three things are persisted: the original tape bytes, the current text, and
the overrides. Header fields, trailing blocks and the pristine listing used for
the "was this edited?" check are always recomputed by re-parsing the tape, so a
restored session cannot drift from what a fresh load of the same file gives.
Storage being unavailable (private browsing, blocked cookies, quota exceeded) is
handled quietly — the editor still works, it just will not resume.

## Renumbering

**Renumber…** takes a start and a step, previews the result, and rewrites every
line number *and every reference to one*: `GO TO`, `GO SUB`, `RESTORE`, `RUN`,
`LIST`, `LLIST` and `SAVE … LINE`.

Rewriting the references is the whole job. `Piton3.tap` selects which tune plays
with `RESTORE 820` versus `RESTORE 830`, so a renumber that moves the lines but
not the references yields a program that still runs and quietly plays the wrong
music. Three cases the implementation handles:

- **`LINE` is ambiguous.** It is a line reference in `SAVE "x" LINE 10` but not
  in `INPUT LINE a$`. A keyword only counts as a reference when a plain integer
  follows it, which also leaves computed jumps like `GO TO x*10` alone (with a
  warning rather than a silent wrong answer).
- **Jumps into gaps are legal.** `GO TO 35` where line 35 does not exist
  continues at the first line *after* it. Such references are retargeted to
  wherever the ROM would actually have landed, and the redirect is reported.
- **Strings and `REM` are inert.** `PRINT "GO TO 999"` is left untouched.

Stored-value overrides are keyed by line number, so they are remapped too —
otherwise renumbering would silently discard them on the next save.

The correctness property the tests assert is that renumbering preserves the
*reference graph by line index*: whatever line N jumped to before, it still
jumps to the same line afterwards. Renumbering is also idempotent, and
composing two renumbers equals doing the final one directly.

Note that renumbering upward grows the file slightly. Line numbers themselves
are always two bytes, but a *reference* is stored as ASCII digits plus its
5-byte value — so `Piton3.tap` renumbered to 1000/10 gains exactly 51 bytes for
its 50 references.

## Running the tape

**Run ▶** boots [JSSpeccy 3](https://github.com/gasman/jsspeccy3) with the tape
built from the *current listing*, not the file on disk — so an edit can be tried
without saving first. 48K / 128K / Pentagon are selectable; changing the machine
re-runs. Escape or a click outside closes it.

The emulator is vendored under `public/jsspeccy` (~480KB including ROMs) and
loaded lazily on first use, since most editing sessions never run the tape.

Two integration details worth knowing:

- The npm package ships **source only**. `public/jsspeccy` was produced by
  running its AssemblyScript + webpack build (`npm run build:release`); the
  957KB sourcemap was dropped.
- JSSpeccy picks a tape parser by `filename.endsWith('.tap')`, and its
  `openFile(File)` method is not on the public API surface. An in-memory tape is
  therefore passed as a blob URL with a `#name.tap` fragment appended: the
  fragment satisfies the extension sniff, and the blob URL store lookup ignores
  it, so the fetch still resolves.

## Licence

GPL-3.0-or-later — see `LICENSE`. The copyleft comes from JSSpeccy 3, which is
GPL-3.0 and is bundled in `public/jsspeccy`. zmakebas is public domain.

## Status

Scope is BASIC programs. Non-program blocks are listed and passed through
untouched, byte for byte; they are not yet editable.

Verified against `Piton3.tap` (5910 bytes, 86 lines): load → text → save
reproduces the original file exactly, header and checksums included.

Not yet done: hex / `SCREEN$` editing for `CODE` blocks.
