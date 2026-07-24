import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  // feature-renderer-plugin-boundary Phase 2 §2.1 — copy `katex`'s own
  // CSS + fonts into `dist/assets/` so the plugin self-serves them via
  // `registerRoutes` (see `scripts/copy-katex-assets.mjs` + `src/index.ts`
  // `resolveAssetsDir()`). Runs after every successful build, including
  // `tsup --watch --no-clean` (the `dev` script).
  onSuccess: 'node scripts/copy-katex-assets.mjs',
});
