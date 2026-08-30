// Builds background service worker (ESM) and content script (IIFE) using esbuild.
// Run after vite build (which handles HTML pages) so dist/ already exists.
import { build } from 'esbuild'

await build({
  entryPoints: ['src/background/worker.ts'],
  bundle: true,
  format: 'esm',
  outfile: 'dist/background/worker.js',
  platform: 'browser',
  target: 'chrome120',
})

// Content script must be IIFE — no dynamic module imports in content script context.
await build({
  entryPoints: ['src/content/index.ts'],
  bundle: true,
  format: 'iife',
  outfile: 'dist/content/index.js',
  platform: 'browser',
  target: 'chrome120',
})

console.log('[build-scripts] background/worker.js and content/index.js built')
