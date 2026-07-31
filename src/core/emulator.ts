/**
 * JSSpeccy 3 integration (GPL-3.0, vendored under public/jsspeccy).
 *
 * The emulator is loaded lazily: its bundle plus WASM core is ~480KB, and most
 * editing sessions never run the tape.
 *
 * Feeding it an in-memory tape needs a small trick. `emu.openFile(File)` exists
 * but is not part of the public API surface, and the public `openUrl()` picks a
 * parser purely by `filename.endsWith('.tap')` -- which a bare blob: URL never
 * satisfies. Appending a `#name.tap` fragment makes the sniff succeed while
 * leaving the fetch unaffected, because the blob URL store lookup ignores the
 * fragment.
 */

export interface JSSpeccyHandle {
  setMachine(model: number): void;
  setZoom(zoom: number): void;
  openUrl(url: string): void;
  onReady(cb: () => void): void;
  exit(): void;
}

type JSSpeccyFactory = (container: HTMLElement, opts: Record<string, unknown>) => JSSpeccyHandle;

declare global {
  interface Window { JSSpeccy?: JSSpeccyFactory }
}

// Base-relative, so a deployment under a subpath (GitHub Pages) still resolves.
// JSSpeccy loads its own ROMs against `document.currentScript.src`, so getting
// this one URL right is enough for the vendored assets beside it.
const SCRIPT_URL = `${import.meta.env.BASE_URL}jsspeccy/jsspeccy.js`;
let loading: Promise<JSSpeccyFactory> | null = null;

function loadRuntime(): Promise<JSSpeccyFactory> {
  if (window.JSSpeccy) return Promise.resolve(window.JSSpeccy);
  if (loading) return loading;

  loading = new Promise<JSSpeccyFactory>((resolve, reject) => {
    const el = document.createElement('script');
    el.src = SCRIPT_URL;
    el.onload = () => {
      if (window.JSSpeccy) resolve(window.JSSpeccy);
      else reject(new Error('jsspeccy.js loaded but did not define window.JSSpeccy'));
    };
    el.onerror = () => reject(new Error(`could not load ${SCRIPT_URL}`));
    document.head.appendChild(el);
  });
  loading.catch(() => { loading = null; }); // allow a retry after a failure
  return loading;
}

export interface RunOptions {
  /** 48, 128 or 5 (Pentagon). */
  machine?: number;
  zoom?: number;
  /** Tape name, used only to give the blob URL a .tap extension. */
  name?: string;
}

export class EmulatorSession {
  private handle: JSSpeccyHandle | null = null;
  private objectUrl: string | null = null;

  constructor(private container: HTMLElement) {}

  get running() { return this.handle !== null; }

  async run(tap: Uint8Array, opts: RunOptions = {}) {
    const JSSpeccy = await loadRuntime();
    this.stop(); // a fresh machine per run, so state never leaks between takes

    const blob = new Blob([tap as BlobPart], { type: 'application/octet-stream' });
    const safeName = (opts.name || 'tape').replace(/[^\w.-]/g, '_').replace(/\.tap$/i, '');
    this.objectUrl = URL.createObjectURL(blob);

    this.handle = JSSpeccy(this.container, {
      machine: opts.machine ?? 48,
      zoom: opts.zoom ?? 2,
      autoStart: true,
      autoLoadTapes: true,
      openUrl: `${this.objectUrl}#${safeName}.tap`,
      sandbox: true,
    });
  }

  stop() {
    if (this.handle) {
      try { this.handle.exit(); } catch { /* already torn down */ }
      this.handle = null;
    }
    this.container.innerHTML = '';
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }
}
