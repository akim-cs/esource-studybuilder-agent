import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// Builds HTML pages only (side panel + options).
// root: 'src' ensures HTML outputs land at dist/sidepanel/ and dist/options/
// (not dist/src/sidepanel/) so manifest.json paths match.
// Background worker and content script are handled by build-scripts.mjs (esbuild).
export default defineConfig({
  plugins: [react()],
  root: 'src',
  publicDir: resolve(__dirname, 'public'),
  build: {
    rollupOptions: {
      input: {
        sidepanel: resolve(__dirname, 'src/sidepanel/index.html'),
        options: resolve(__dirname, 'src/options/index.html'),
      },
    },
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
  },
})
