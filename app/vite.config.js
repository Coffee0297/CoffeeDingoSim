import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';

// Vite root is app/ (docs/interfaces.md §1). `npm run build` → app/dist, served by server/index.js.
// In dev the SPA runs on :5173 and proxies the WebSocket and REST to the Node server on :8787.
const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  plugins: [svelte()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true },
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
    },
  },
});
