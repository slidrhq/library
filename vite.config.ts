import { fileURLToPath } from 'node:url';
import { cloudflare } from '@cloudflare/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** The app's readers of the media library, copied from `desktop/src` (vendor/README.md). */
const desktop = fileURLToPath(new URL('vendor/desktop/src', import.meta.url));

export default defineConfig({
  // The Worker of `wrangler.jsonc` runs inside the dev server and is built beside the page.
  plugins: [react(), cloudflare()],
  clearScreen: false,
  // The app's readers ask `__SLIDR_MEDIA_PATH__` where the library is served on this page's own
  // origin (`@slidr/media-library`): a library on a machine names `/media/` to the page
  // (server/host/node/server.ts); on Cloudflare it names nothing, and they read the published site.
  define: { __SLIDR_MEDIA_PATH__: 'globalThis.__slidrMediaPath' },
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
