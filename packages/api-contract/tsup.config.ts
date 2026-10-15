import { defineConfig } from 'tsup';

const dts = process.env.CROWI_TSUP_DTS !== '0';

// `clean` is off in both configs: the package `build` script removes `dist`
// once up front, because two configs sharing one `dist` would otherwise wipe
// each other's output.
export default defineConfig([
  {
    entry: ['src/index.ts', 'src/generated/openapi.ts'],
    format: ['cjs', 'esm'],
    dts,
    splitting: false,
    sourcemap: true,
    clean: false,
  },
  {
    // Browser-safe entry: HAST parsing/sanitizing only. Bundling its deps
    // (VFile's browser build, hast-util-*) keeps Node built-ins out of the
    // Web bundle and leaves the root/openapi entries' externals unchanged.
    entry: ['src/html-sanitizer.ts'],
    format: ['cjs', 'esm'],
    dts,
    splitting: false,
    sourcemap: true,
    clean: false,
    platform: 'browser',
    noExternal: [/.*/],
  },
]);
