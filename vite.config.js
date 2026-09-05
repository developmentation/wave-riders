import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  base: './',
  server: { port: 5173, open: false },
  build: {
    target: 'esnext',
    outDir: 'dist',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      input: {
        // The boat game is the front door; the original ocean explorer stays
        // reachable at /explore.html.
        main: resolve(__dirname, 'index.html'),
        explore: resolve(__dirname, 'explore.html'),
      },
    },
  },
  // .glsl / .wgsl are imported with ?raw
  assetsInclude: ['**/*.glsl', '**/*.wgsl'],
});
