import { defineConfig } from 'vite';

// `base: './'` makes every asset URL relative, so the build works from any
// sub-path (for example https://<user>.github.io/<repo>/).
export default defineConfig({
  base: './',
  // maplibre-gl 6 loads its web worker via import.meta.url. Pre-bundling it in
  // dev breaks that URL ("504 Outdated Optimize Dep", "Worker failed to load").
  optimizeDeps: { exclude: ['maplibre-gl'] },
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: { input: { main: 'index.html', trace: 'trace.html' } },
  },
});
