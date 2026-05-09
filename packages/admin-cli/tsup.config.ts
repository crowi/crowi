import { defineConfig } from 'tsup';

export default defineConfig({
  // Two entry points: `bin.ts` for the executable installed under
  // `node_modules/.bin/crowi-admin`, and `cli.ts` so the package can
  // also be required programmatically (handy for future test
  // harnesses).
  entry: ['src/bin.ts', 'src/cli.ts'],
  format: ['cjs'],
  dts: { entry: 'src/cli.ts' },
  splitting: false,
  sourcemap: true,
  clean: true,
  // Don't pre-bundle @crowi/api — it has heavy deps (mongoose, redis,
  // express) that we want to resolve from the runner's node_modules at
  // runtime, the same way the dev / prod boot does.
  external: ['@crowi/api'],
});
