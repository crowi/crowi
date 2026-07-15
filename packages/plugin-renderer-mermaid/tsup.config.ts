import { defineConfig } from 'tsup';

export default defineConfig({
  // spec §10 — `render-worker.ts` is a second, independent `fork()`
  // entry point (not part of the plugin's public `index.ts` API
  // surface). `render-engine.ts` resolves the built CJS sibling
  // (`dist/render-worker.js`) at runtime via `__dirname`, never through
  // the `exports` map.
  entry: ['src/index.ts', 'src/render-worker.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
});
