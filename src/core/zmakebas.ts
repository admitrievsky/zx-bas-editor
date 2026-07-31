/**
 * Text -> TAP via the zmakebas WASM build.
 *
 * We deliberately bypass the package's own index.js wrapper: it hardcodes
 * `-a 0` and leaves the tape filename blank, which would clobber the header we
 * are trying to preserve. The Emscripten glue itself is flexible -- it writes
 * Module.input to "input.bas", runs with Module.arguments, and resolves with
 * the contents of "output.tap" -- so we drive it directly.
 *
 * The build targets the web and embeds its .wasm as base64, so it runs in the
 * browser with no extra fetch and no Emscripten toolchain.
 */

// Typed via src/vite-env.d.ts; the factory itself ships no declarations.
import ModuleFactory from 'zmakebas/dist/zmakebas.js';

export interface TokenizeOptions {
  /** Spectrum filename for the tape header (max 10 chars). */
  name?: string;
  /** Autostart line; omit or pass >= 32768 for none. */
  autostart?: number;
  /** Emit a raw headerless file instead of a .tap. */
  raw?: boolean;
}

export class ZmakebasError extends Error {
  diagnostics: string[];
  constructor(message: string, diagnostics: string[]) {
    super(message);
    this.name = 'ZmakebasError';
    this.diagnostics = diagnostics;
  }
}

interface Diag { type: 'out' | 'err'; text: string }

export async function textToTap(source: string, opts: TokenizeOptions = {}): Promise<Uint8Array> {
  const args: string[] = [];
  if (opts.name) args.push('-n', opts.name.trimEnd().slice(0, 10));
  if (opts.autostart !== undefined && opts.autostart < 32768) {
    args.push('-a', String(opts.autostart));
  }
  if (opts.raw) args.push('-r');
  // The glue's postRun only ever reads back "output.tap".
  args.push('-o', 'output.tap', 'input.bas');

  // zmakebas requires a trailing newline to see the final line.
  const input = source.endsWith('\n') ? source : source + '\n';
  const diagnostics: Diag[] = [];

  return new Promise<Uint8Array>((resolve, reject) => {
    ModuleFactory({
      arguments: args,
      input,
      out: diagnostics,
      resolve: (tap: Uint8Array) => resolve(new Uint8Array(tap)),
      reject: () => reject(buildError(diagnostics)),
      print: (text: string) => diagnostics.push({ type: 'out', text }),
      printErr: (text: string) => diagnostics.push({ type: 'err', text }),
    }).catch?.((e: unknown) => reject(e instanceof Error ? e : buildError(diagnostics)));
  });
}

function buildError(diagnostics: Diag[]): ZmakebasError {
  const lines = diagnostics.map((d) => d.text).filter(Boolean);
  const first = lines.find((l) => /line \d+|error|too|bad|missing|not/i.test(l));
  return new ZmakebasError(first ?? 'zmakebas produced no output', lines);
}

/** Pull a `line <n>:` prefix out of a zmakebas diagnostic, if present. */
export function diagnosticLineNumber(message: string): number | undefined {
  const m = /line (\d+)/.exec(message);
  return m ? Number(m[1]) : undefined;
}
