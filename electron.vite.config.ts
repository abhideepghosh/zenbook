import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

// Runtime libraries live in devDependencies, so electron-vite bundles them into
// out/ and no node_modules folder ships with the app (see docs/SPEC.md, bloat budget).
export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [react()],
    // Minify only the renderer: less JavaScript to parse at startup. Main and preload
    // stay readable so stack traces in crash reports make sense.
    build: { minify: true },
  },
})
