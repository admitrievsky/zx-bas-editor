/// <reference types="vite/client" />
declare module 'zmakebas/dist/zmakebas.js' {
  const factory: (opts: Record<string, unknown>) => Promise<unknown>;
  export default factory;
}
