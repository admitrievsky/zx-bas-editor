import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs, so the build works both at a domain root and under the
  // GitHub Pages project subpath (/zx-bas-editor/) without a hardcoded prefix.
  // Vite treats this as '/' during dev, so the dev server stays at the root.
  base: './',
  // The zmakebas build is a UMD Emscripten bundle with its .wasm embedded as
  // base64; esbuild must pre-bundle it so the CommonJS export interops.
  optimizeDeps: { include: ['zmakebas/dist/zmakebas.js'] },
  build: { target: 'es2022' },
  server: { port: 5173 },
});
