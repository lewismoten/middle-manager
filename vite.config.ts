import { defineConfig } from 'vite';

// Dev: the UI runs on 6180 and proxies /api to the server on MM_PORT (default 6181).
// Ports 4747 (the real service) and 5173 are deliberately avoided.
const apiPort = process.env.MM_PORT ?? '6181';

export default defineConfig({
  root: 'web',
  publicDir: 'public',
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    assetsInlineLimit: 0,
  },
  server: {
    port: Number(process.env.MM_UI_PORT ?? 6180),
    strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${apiPort}` },
  },
  preview: { port: 6182, strictPort: true },
});
