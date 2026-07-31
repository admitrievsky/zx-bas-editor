import { defineConfig } from 'vite';

export default defineConfig({
  // The zmakebas build is a UMD Emscripten bundle with its .wasm embedded as
  // base64; esbuild must pre-bundle it so the CommonJS export interops.
  optimizeDeps: { include: ['zmakebas/dist/zmakebas.js'] },
  build: { target: 'es2022' },
  server: { port: 5173 },
});
