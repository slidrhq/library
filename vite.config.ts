import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The app's repository (github.com/slidrhq/app), checked out beside this one: its packages
 * (`package.json`) and the readers of the media library in `apps/desktop/src` (`@desktop`) draw
 * the library as the app draws it.
 */
const app = fileURLToPath(new URL('../app/', import.meta.url));

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  resolve: {
    alias: { '@desktop': `${app}apps/desktop/src` },
    // The app's modules import React from the app's own install: one copy for the whole page.
    dedupe: ['react', 'react-dom'],
  },
  server: {
    // The address the studio links to (its `VITE_SLIDR_LIBRARY_URL`).
    host: '127.0.0.1',
    port: 5176,
    strictPort: true,
    fs: { allow: ['.', app] },
  },
  preview: { host: '127.0.0.1', port: 5176, strictPort: true },
  build: {
    target: 'chrome120',
    // The renderer and the app's readers are large.
    chunkSizeWarningLimit: 2000,
  },
});
