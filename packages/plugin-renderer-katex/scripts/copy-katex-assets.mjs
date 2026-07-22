#!/usr/bin/env node
/**
 * tsup `onSuccess` hook (see `../tsup.config.ts`) — copies `katex.min.css`
 * and every font file it `@font-face`-references from the installed
 * `katex` package's own `dist/` into this plugin's `dist/assets/`, so the
 * built package self-serves those CSS/font bytes without a runtime
 * `katex` resolve (feature-renderer-plugin-boundary Phase 2 §2.1 design
 * decision: "package-local asset" ownership).
 *
 * Runs after every `tsup` build (including `tsup --watch --no-clean`, the
 * `dev` script), so `dist/assets/` always matches the `katex` version this
 * plugin was built against. `src/index.ts`'s `resolveAssetsDir()` reads
 * from the directory this script writes.
 */
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

const katexPackageJsonPath = require.resolve('katex/package.json');
const katexDistDir = path.join(path.dirname(katexPackageJsonPath), 'dist');

const outDir = path.join(import.meta.dirname, '..', 'dist', 'assets');
const outFontsDir = path.join(outDir, 'fonts');
mkdirSync(outFontsDir, { recursive: true });

copyFileSync(path.join(katexDistDir, 'katex.min.css'), path.join(outDir, 'katex.min.css'));

const fontFilenames = readdirSync(path.join(katexDistDir, 'fonts')).filter((name) => /\.(?:woff2|woff|ttf)$/.test(name));
for (const filename of fontFilenames) {
  copyFileSync(path.join(katexDistDir, 'fonts', filename), path.join(outFontsDir, filename));
}

console.log(`[copy-katex-assets] copied katex.min.css + ${fontFilenames.length} font files -> ${outDir}`);
