import { defineConfig } from 'tsup';

export default defineConfig({
  // Two entry points: `bin.ts` for the executable installed under
  // `node_modules/.bin/crowi`, and `cli.ts` so the package can also be
  // required programmatically (handy for test harnesses).
  entry: ['src/bin.ts', 'src/cli.ts'],
  format: ['cjs'],
  dts: { entry: 'src/cli.ts' },
  splitting: false,
  sourcemap: true,
  clean: true,
  // @crowi/api-contract is bundled in: the CLI only consumes its REQUEST
  // Zod schemas + scope/grant constants (the "v2 floor"), never the
  // `createClient`-produced `CrowiApiClient` RPC client, so there is no
  // heavy runtime to externalise.
  // `open` stays external (ESM-only) and is loaded via dynamic import() at
  // call sites to avoid require() of an ESM module under cjs output.
  external: ['open'],
});
