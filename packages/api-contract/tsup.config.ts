import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/generated/openapi.ts'],
  format: ['cjs', 'esm'],
  dts: process.env.CROWI_TSUP_DTS !== '0',
  splitting: false,
  sourcemap: true,
  clean: true,
});
