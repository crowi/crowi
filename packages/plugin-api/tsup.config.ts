import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  // `resolve` so the emitted `.d.ts` inlines the private package's types too.
  // `noExternal` below only inlines runtime JS — without this the declaration
  // file keeps `export { ... } from '@crowi/svg-sanitize'`, which no consumer
  // of the published tarball can resolve.
  dts: { resolve: ['@crowi/svg-sanitize'] },
  splitting: false,
  sourcemap: true,
  clean: true,
  // `@crowi/svg-sanitize` is private and never published — inline it here
  // rather than leaving an external `require`/`import` this tarball's own
  // dependencies cannot declare. This is the single inlining site: core and
  // the renderer plugins take the sanitizer from this SDK (see src/svg.ts).
  noExternal: ['@crowi/svg-sanitize'],
  // Keep the published `.map` files free of the inlined package's original
  // source text, which `sourcesContent` would otherwise embed verbatim.
  // `sources` (file paths) and the line mappings are unaffected, so
  // `--enable-source-maps` still resolves.
  esbuildOptions(options) {
    options.sourcesContent = false;
  },
});
