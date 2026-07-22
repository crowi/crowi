/**
 * feature-renderer-plugin-boundary Phase 2 (§1, §9 "dependency boundary")
 * — a repository-lint-style test (jest, no external `rg` binary
 * dependency — CI must not rely on ripgrep being installed) asserting
 * `packages/api` and `packages/web` carry no import/dependency on any
 * optional renderer package (`@crowi/plugin-renderer-{katex,plantuml,
 * mermaid}`), and that `@crowi/web` specifically carries no `katex`
 * npm-package dependency or CSS `@import` either (spec §4's "`@crowi/web`
 * から `katex` と `@crowi/plugin-renderer-mermaid` ... を除去する" AC).
 *
 * Scoped to `packages/api` + `packages/web` only — the allowlisted
 * legitimate references (`apps/crowi-runner`, `packages/e2e`, each
 * optional-renderer plugin package's own source, `apps/crowi-site` docs)
 * are simply never scanned; per spec §1's own inventory those are the
 * "operator install the plugin" ownership layer, not core→plugin
 * coupling.
 *
 * A literal string mention of a plugin's npm name — e.g. this repo's own
 * `registry.test.ts` asserting an `addStylesheet(...)` namespace-
 * validation path like `'/api/v2/plugins/@crowi/plugin-renderer-katex/
 * katex.css'` — is NOT a violation; only an actual `import`/`require`
 * of the package is. `importsPackage` below matches only those forms.
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

const OPTIONAL_RENDERER_PACKAGES = ['@crowi/plugin-renderer-katex', '@crowi/plugin-renderer-plantuml', '@crowi/plugin-renderer-mermaid'] as const;

const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.turbo', 'coverage', '__snapshots__']);
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css']);
/** This file itself, excluded from the scan — its own detector self-check deliberately embeds every import/require FORM as literal test fixture text. */
const SELF_PATH = path.resolve(__filename);

/** Recursively list every file under `dir` whose extension is in `SCAN_EXTENSIONS`, skipping build/dependency directories and this file itself. */
function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...listSourceFiles(path.join(dir, entry.name)));
      continue;
    }
    if (!SCAN_EXTENSIONS.has(path.extname(entry.name))) continue;
    const fullPath = path.join(dir, entry.name);
    if (path.resolve(fullPath) === SELF_PATH) continue;
    out.push(fullPath);
  }
  return out;
}

/**
 * True when `source` contains an ESM `import ... from '<pkg>'` / bare
 * `import '<pkg>'`, a dynamic `import('<pkg>')`, or a CJS
 * `require('<pkg>')` of `pkg` (optionally with a `/subpath`). Deliberately
 * does NOT match `pkg`'s name appearing as an unrelated string-literal
 * argument or inside a comment — see the file doc comment.
 */
function importsPackage(source: string, pkg: string): boolean {
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b(?:from|require|import)\\s*\\(?\\s*['"]${escaped}(?:/[^'"]*)?['"]`);
  return re.test(source);
}

/** True when `source` (a CSS file) `@import`s the bare `katex` npm package. */
function importsBareKatexCss(source: string): boolean {
  return /@import\s+["']katex\//.test(source);
}

function readPackageJsonDependencyNames(packageJsonPath: string): Set<string> {
  const raw = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  return new Set([...Object.keys(raw.dependencies ?? {}), ...Object.keys(raw.devDependencies ?? {}), ...Object.keys(raw.peerDependencies ?? {})]);
}

const TARGETS = [
  { label: '@crowi/api', dir: path.join(REPO_ROOT, 'packages', 'api') },
  { label: '@crowi/web', dir: path.join(REPO_ROOT, 'packages', 'web') },
];

describe('dependency boundary — packages/api & packages/web carry no optional renderer package coupling', () => {
  for (const target of TARGETS) {
    describe(target.label, () => {
      it('package.json declares no dependency/devDependency/peerDependency on any optional renderer package', () => {
        const names = readPackageJsonDependencyNames(path.join(target.dir, 'package.json'));
        const found = OPTIONAL_RENDERER_PACKAGES.filter((pkg) => names.has(pkg));
        expect(found).toEqual([]);
      });

      for (const pkg of OPTIONAL_RENDERER_PACKAGES) {
        it(`no source file imports/requires ${pkg}`, () => {
          const files = listSourceFiles(path.join(target.dir, 'src'));
          const offenders = files.filter((file) => importsPackage(fs.readFileSync(file, 'utf8'), pkg));
          expect(offenders.map((f) => path.relative(REPO_ROOT, f))).toEqual([]);
        });
      }
    });
  }

  describe('@crowi/web — katex (the raw npm package, not a Crowi plugin) is fully self-served by @crowi/plugin-renderer-katex now', () => {
    const webDir = path.join(REPO_ROOT, 'packages', 'web');

    it('package.json declares no dependency/devDependency/peerDependency on katex', () => {
      const names = readPackageJsonDependencyNames(path.join(webDir, 'package.json'));
      expect(names.has('katex')).toBe(false);
    });

    it('no CSS file under src/ @imports the katex package', () => {
      const cssFiles = listSourceFiles(path.join(webDir, 'src')).filter((f) => f.endsWith('.css'));
      const offenders = cssFiles.filter((file) => importsBareKatexCss(fs.readFileSync(file, 'utf8')));
      expect(offenders.map((f) => path.relative(REPO_ROOT, f))).toEqual([]);
    });

    it('no source file imports/requires the katex package', () => {
      const files = listSourceFiles(path.join(webDir, 'src'));
      const offenders = files.filter((file) => importsPackage(fs.readFileSync(file, 'utf8'), 'katex'));
      expect(offenders.map((f) => path.relative(REPO_ROOT, f))).toEqual([]);
    });
  });

  // Self-check — importsPackage must not false-positive on the
  // legitimate literal-string mentions this repo's own test suites
  // already contain (registry.test.ts's addStylesheet namespace-
  // validation cases, doc-comment prose, etc.), and must positively
  // detect the import forms it exists to catch.
  describe('importsPackage — detector self-check', () => {
    it('matches ESM named/type import, bare side-effect import, dynamic import, and CJS require', () => {
      expect(importsPackage(`import katexPlugin from '@crowi/plugin-renderer-katex';`, '@crowi/plugin-renderer-katex')).toBe(true);
      expect(importsPackage(`import type { X } from '@crowi/plugin-renderer-katex';`, '@crowi/plugin-renderer-katex')).toBe(true);
      expect(importsPackage(`import '@crowi/plugin-renderer-katex';`, '@crowi/plugin-renderer-katex')).toBe(true);
      expect(importsPackage(`const x = import('@crowi/plugin-renderer-katex');`, '@crowi/plugin-renderer-katex')).toBe(true);
      expect(importsPackage(`const x = require('@crowi/plugin-renderer-katex');`, '@crowi/plugin-renderer-katex')).toBe(true);
      expect(importsPackage(`import x from '@crowi/plugin-renderer-katex/dist/index.js';`, '@crowi/plugin-renderer-katex')).toBe(true);
    });

    it('does NOT match a plugin name appearing as an unrelated string-literal argument or comment', () => {
      const source = `
        // reads (\`@crowi/plugin-renderer-katex\`) for context only.
        reg.addStylesheet('/api/v2/plugins/@crowi/plugin-renderer-katex/katex.css', '@crowi/plugin-renderer-katex');
      `;
      expect(importsPackage(source, '@crowi/plugin-renderer-katex')).toBe(false);
    });
  });
});
