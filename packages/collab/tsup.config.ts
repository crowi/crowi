import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  dts: { entry: 'src/index.ts' },
  splitting: false,
  sourcemap: true,
  clean: true,
  // Keep @crowi/api unbundled — we resolve dist/* paths dynamically via
  // `require.resolve('@crowi/api/package.json')` so the workspace
  // symlink (dev) or installed copy (prod) is honoured. Heavy deps stay
  // external for the same reason.
  external: ['@crowi/api', '@crowi/api-contract', '@hocuspocus/server', 'mongoose', 'yjs', 'y-protocols'],
});
