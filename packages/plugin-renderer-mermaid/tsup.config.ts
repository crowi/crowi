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
  // `@crowi/svg-sanitize` is private (never published) — inline it into
  // this package's dist instead of leaving it an external `require`/
  // `import` the published tarball's own dependencies don't declare
  // (packages/svg-sanitize/README.md).
  noExternal: ['@crowi/svg-sanitize'],
  // Keep the published `.map` files free of the bundled workspace
  // package's original source text (it otherwise embeds every inlined
  // file's pre-bundle source — including its own `import` line and doc
  // comments — verbatim in `sourcesContent`). `sources` (file paths) and
  // the line mappings themselves are unaffected, so local debugging via
  // `--enable-source-maps` still resolves; only the published tarball's
  // copy of the private package's source text is dropped.
  esbuildOptions(options) {
    options.sourcesContent = false;
  },
});
