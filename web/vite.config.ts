import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The Python backend serves both the JSON API and the HLS proxy on 8511. Both are proxied in dev so the app can always fetch same-origin paths, exactly as it will when the backend serves the built bundle. RT511_API points dev at something else, which is how the mock is run alongside a real backend already holding 8511.
// Declared locally rather than pulling in @types/node, which this project needs for nothing else and which would change type resolution across the whole app.
declare const process: { env: Record<string, string | undefined> };

const target = process.env.RT511_API ?? 'http://127.0.0.1:8511';

export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    // The wire contract lives next to the server that owns it, and both sides import the same file rather than describing the same shapes twice.
    // Resolved from this file's own URL rather than through node:url, so the web package still needs no Node types.
    alias: { '@rt511/shared': new URL('../shared/src/index.ts', import.meta.url).pathname },
  },
  server: {
    proxy: {
      '/api': { target, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // hls.js is lazily imported and lands in its own chunk. It is inherently large and there is nothing to split, so the warning would only ever be noise.
    chunkSizeWarningLimit: 700,
  },
});
