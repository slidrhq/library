import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * The library's server on Node (`server/host/node/cli.ts`), with everything it imports, the app's
 * packages of `vendor/` among them, in one file: `dist/node/library.mjs`, which the image runs
 * (docker/Dockerfile; docs/PLAN.md P11). Only Node's own modules stay outside it.
 */
export default defineConfig({
  clearScreen: false,
  resolve: {
    alias: { '@desktop': fileURLToPath(new URL('vendor/desktop/src', import.meta.url)) },
  },
  ssr: { noExternal: true, target: 'node' },
  build: {
    ssr: 'server/host/node/cli.ts',
    outDir: 'dist/node',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    sourcemap: true,
    rollupOptions: {
      output: { entryFileNames: 'library.mjs', inlineDynamicImports: true },
    },
  },
});
