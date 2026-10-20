import { fileURLToPath } from 'node:url';
import { cloudflare } from '@cloudflare/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** The app's readers of the media library, copied from `apps/desktop/src` (vendor/README.md). */
const desktop = fileURLToPath(new URL('vendor/apps/desktop/src', import.meta.url));

export default defineConfig({
  // The Worker of `wrangler.jsonc` runs inside the dev server and is built beside the page.
  plugins: [react(), cloudflare()],
  clearScreen: false,
  resolve: {
    alias: { '@desktop': desktop },
  },
  server: {
    // The address the studio links to (its `VITE_SLIDR_LIBRARY_URL`).
    host: '127.0.0.1',
    port: 5176,
    strictPort: true,
  },
  preview: { host: '127.0.0.1', port: 5176, strictPort: true },
  build: {
    target: 'chrome120',
    // The renderer and the app's readers are large.
    chunkSizeWarningLimit: 2000,
  },
});
