import { defineConfig } from 'tsup';

/**
 * A self-contained bundle for the Node SEA single-file binary
 * (`scripts/build-sea.mjs`). Unlike the publish build (`tsup.config.ts`),
 * which externalises `dependencies` so npm resolves them at install time, the
 * SEA bundle must inline EVERYTHING that is not a Node builtin — the embedded
 * SEA loader can only `require()` builtins, not files on disk. So we force
 * `commander` + `@crowi/api-contract` into the bundle via `noExternal`.
 *
 * `open` stays external: it is ESM-only and loaded via a dynamic `import()`
 * that `openBrowser()` catches and degrades from (the SEA binary prints the
 * URL instead of launching a browser — use `crowi login --device`).
 */
export default defineConfig({
  entry: { 'bin.sea': 'src/bin.ts' },
  format: ['cjs'],
  dts: false,
  splitting: false,
  sourcemap: false,
  clean: false,
  // Inline every dependency so the output is standalone for SEA.
  noExternal: [/^(?!open$).*/],
  external: ['open'],
});
