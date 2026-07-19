/**
 * Phase 4 AC (spec Phase 4 — "runner/Docker配線 + ドキュメント"): every
 * OTHER test in this package forks `render-engine.ts`'s
 * `resolveWorkerEntryPath()` result under `ts-jest`, where `__dirname`
 * is always this package's `src/` directory — `src/render-worker.js`
 * never exists there, so `resolveWorkerEntryPath()` always falls back to
 * `render-worker.ts` (Node 24's native TS stripping). The production
 * path — `@crowi/runner` `require()`s the built CJS `dist/index.js`,
 * whose real `__dirname` IS `dist/`, so `resolveWorkerEntryPath()`
 * there finds and `fork()`s the real sibling `dist/render-worker.js` —
 * has never been exercised by any test until this file.
 *
 * Round 1 review (2026-07-18, NEEDS_WORK) found the original version of
 * this file insufficient: it only `createRequire.resolve()`d the plugin
 * name from `apps/crowi-runner` (proving a PATH resolves, not that
 * `@crowi/runner`'s actual boot-time loader — `resolvePlugins()` /
 * `PluginManager.bootstrap()` — successfully imports + registers it),
 * and it never verified the production-only (`pnpm deploy --prod`)
 * dependency tree the real Docker image ships, only the dev workspace's
 * symlinked `node_modules`. This revision closes both gaps:
 *
 *   - "boots via @crowi/runner's resolvePlugins()" below calls the
 *     REAL `resolvePlugins()` (the exact function
 *     `packages/api/src/plugin/plugin-manager.ts`'s `bootstrap()` calls
 *     at every api boot) against the real `apps/crowi-runner` project,
 *     then drives the returned plugin through `registerRenderer()` +
 *     `render()` — the full boot→register→render path, not just a
 *     path resolution.
 *   - "pnpm-deployed production tree" below runs the literal
 *     `pnpm deploy --legacy --filter=@crowi/runner-app --prod` command
 *     `packages/api/Dockerfile`'s `deployer` stage uses, into a throwaway
 *     directory, then repeats the same boot→register→render path
 *     rooted at THAT directory (mirroring the Docker `runtime` stage's
 *     `WORKDIR=/app` + `COPY --from=deployer /deploy /app`) — proving
 *     the worker file AND its production-only runtime deps (`mermaid`,
 *     `jsdom`, no `devDependencies`) are actually present and functional
 *     in the exact tree the shipped image contains, without needing a
 *     Docker daemon in the test environment.
 *
 * This suite needs BOTH this package's own fresh `dist/` AND the whole
 * `apps/crowi-runner` dependency graph (`@crowi/runner`,
 * `@crowi/plugin-api`, every sibling plugin, ...) built first — turbo's
 * default `^build` only covers a package's own dependency chain, not
 * (a) its own build or (b) an unrelated app's graph, so `turbo.json`
 * declares an explicit `@crowi/plugin-renderer-mermaid#test` override
 * depending on `build` (own package) and `@crowi/runner-app#build`
 * (mirroring the existing `@crowi/collab#test` → `@crowi/api#build`
 * override); `apps/crowi-runner/package.json` carries a no-op `build`
 * script so turbo has a task node to hang that second dependency on.
 *
 * This package used to cover both needs itself: a `pretest` hook
 * (`pnpm build`) rebuilt its own `dist/`, and this suite's `beforeAll`
 * ran a raw `pnpm --filter @crowi/runner-app... build` for the rest.
 * Both were invisible to turbo's scheduler, so either could run
 * CONCURRENTLY with (and clobber the in-progress output of) turbo's own
 * build of those same packages for other tasks in the same `turbo run
 * test` invocation — e.g. `@crowi/api#test` (which imports this
 * package's built `dist/index.js` for its own mermaid e2e test) racing
 * this package's `pretest` rebuild. Declaring both dependencies in
 * `turbo.json` instead makes turbo build this whole graph exactly once,
 * before this suite's `jest` process even starts — for every task that
 * needs it, not just this one.
 *
 * Consequence: this suite is no longer self-contained under a raw
 * `pnpm --filter @crowi/plugin-renderer-mermaid test` (bypasses turbo,
 * so neither dependency above is guaranteed built). Use `pnpm turbo run
 * test --filter=@crowi/plugin-renderer-mermaid` to run this package's
 * tests in isolation.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PACKAGE_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(PACKAGE_ROOT, '..', '..');
const DIST_INDEX_PATH = path.join(PACKAGE_ROOT, 'dist', 'index.js');
const DIST_WORKER_PATH = path.join(PACKAGE_ROOT, 'dist', 'render-worker.js');
// The exact runner project `@crowi/plugin-renderer-mermaid` is wired
// into (spec §10 — `apps/crowi-runner/package.json` dependency +
// `crowi.config.json` plugins entry, Phase 4). `@crowi/runner`'s
// `resolvePlugins()`/`importPlugin()` (`packages/runner/src/resolve-
// plugins.ts`) resolve every declared plugin name with a `createRequire`
// rooted at THIS project's `package.json`, exactly like the second test
// below does for just this one plugin — without needing every other
// bundled plugin (storage/search/slack/...) built too.
const RUNNER_APP_DIR = path.join(REPO_ROOT, 'apps', 'crowi-runner');

// A minimal `node -e`-style script, run OUTSIDE Jest's module graph, that
// resolves + boots the mermaid plugin through `@crowi/runner`'s real
// `resolvePlugins()` (rooted at `projectDir`), registers its
// `CodeBlockRenderer` through a capturing `RendererRegistry` stub (mirrors
// the api's real dispatch registration), and renders one diagram through
// it. `__dirname` inside the resolved module is only genuinely `dist/`
// when this runs as a real subprocess (under ts-jest it is always `src/`
// — the exact gap this whole file exists to close).
const bootScript = (projectDir: string): string =>
  [
    // The script file itself lives under the OS tmpdir, not `projectDir`
    // — a naive `require('@crowi/runner')` would resolve relative to the
    // script's own location instead. `createRequire(projectDir/package.json)`
    // is the exact same rooting `resolvePlugins()` itself uses internally
    // for the plugin names it loads, so this mirrors real boot resolution.
    `const { createRequire } = require('node:module');`,
    `const path = require('node:path');`,
    `const projectRequire = createRequire(path.join(${JSON.stringify(projectDir)}, 'package.json'));`,
    `const { resolvePlugins } = projectRequire('@crowi/runner');`,
    `const noopLog = { debug(){}, info(){}, warn(){}, error(){} };`,
    `async function main() {`,
    `  const { plugins } = await resolvePlugins(${JSON.stringify(projectDir)});`,
    `  const mermaidPlugin = plugins.find((p) => p.name === '@crowi/plugin-renderer-mermaid');`,
    `  if (!mermaidPlugin) { console.error('PLUGIN_NOT_LOADED:' + JSON.stringify(plugins.map((p) => p.name))); process.exit(1); }`,
    `  let captured = null;`,
    `  const registry = {`,
    `    addUnifiedPlugin: () => undefined,`,
    `    addNodeRenderer: () => undefined,`,
    `    addCodeBlockRenderer: (lang, renderer) => { if (lang === 'mermaid') captured = renderer; },`,
    `    addEmbedTag: () => undefined,`,
    `    addUrlInlineExpander: () => undefined,`,
    `  };`,
    `  const pluginCtx = { config: () => undefined, dependencyConfig: () => { throw new Error('not used'); }, setConfig: async () => undefined, pageMetadata: { get: async () => null, set: async () => undefined, remove: async () => undefined }, model: () => undefined, log: noopLog };`,
    `  mermaidPlugin.registerRenderer?.(registry, pluginCtx);`,
    `  if (!captured) { console.error('CODE_BLOCK_RENDERER_NOT_REGISTERED'); process.exit(1); }`,
    `  const renderCtx = { mode: 'save', log: noopLog, actor: { kind: 'system' } };`,
    `  const result = await captured.render({ lang: 'mermaid', source: 'flowchart TD\\n  A[Start] --> B[End]' }, renderCtx);`,
    `  const { _shutdownSingletonForTest } = projectRequire('@crowi/plugin-renderer-mermaid');`,
    `  await _shutdownSingletonForTest();`,
    `  if (result.error) { console.error('RENDER_ERROR:' + JSON.stringify(result.error)); process.exit(1); }`,
    `  if (typeof result.html !== 'string' || !result.html.includes('<img')) { console.error('NO_IMG:' + JSON.stringify(result)); process.exit(1); }`,
    `  console.log('OK');`,
    `  process.exit(0);`,
    `}`,
    `main().catch(async (err) => {`,
    `  try { await projectRequire('@crowi/plugin-renderer-mermaid')._shutdownSingletonForTest(); } catch {}`,
    `  console.error('THROWN:' + (err && err.stack ? err.stack : err));`,
    `  process.exit(1);`,
    `});`,
  ].join('\n');

/** Writes `bootScript(projectDir)` to a temp `.js` file and runs it with `node`, cwd=`projectDir`. */
const runBootScript = (projectDir: string): string => {
  const scriptPath = path.join(mkdtempSync(path.join(tmpdir(), 'crowi-mermaid-boot-')), 'boot.js');
  writeFileSync(scriptPath, bootScript(projectDir));
  try {
    return execFileSync(process.execPath, [scriptPath], { cwd: projectDir, encoding: 'utf8', timeout: 30_000 }).trim();
  } finally {
    rmSync(path.dirname(scriptPath), { recursive: true, force: true });
  }
};

describe('render-worker.js — real dist build boot (spec Phase 4 AC 5: "Docker/build-output boot test")', () => {
  // `@crowi/runner`, `@crowi/plugin-api`, and every sibling plugin this
  // suite's later blocks resolve through `apps/crowi-runner` are built
  // by turbo before this suite's `jest` process starts — see the
  // `@crowi/plugin-renderer-mermaid#test` override in `turbo.json`.

  it('dist/index.js and dist/render-worker.js exist after the turbo-scheduled build (production CJS output — not merely the .ts source every other test in this package falls back to)', () => {
    expect(existsSync(DIST_INDEX_PATH)).toBe(true);
    expect(existsSync(DIST_WORKER_PATH)).toBe(true);
  });

  it('requiring the real built dist/index.js (the exact CJS entry @crowi/runner require()s at boot) and rendering one diagram forks the real dist/render-worker.js and returns a genuine SVG <img> — closes the ts-jest .ts-fallback-only gap', () => {
    // Runs the render in a separate `node -e` subprocess, deliberately
    // OUTSIDE Jest's module graph — this is the only way `__dirname`
    // inside the bundled `resolveWorkerEntryPath()` is genuinely the
    // real `dist/` directory (under ts-jest it is always `src/`, the
    // exact gap this file exists to close). `_shutdownSingletonForTest`
    // (re-exported at the package's public entry specifically so
    // consumers who only ever import the built `dist/index.js` — see
    // its own doc comment, which names `mermaid.e2e.test.ts` as the
    // reference case this mirrors) tears down the forked worker before
    // the subprocess exits, so no `render-worker` process is leaked.
    const script = [
      `const { createMermaidRenderer, _shutdownSingletonForTest } = require(${JSON.stringify(DIST_INDEX_PATH)});`,
      `const ctx = { mode: 'save', log: { debug(){}, info(){}, warn(){}, error(){} }, actor: { kind: 'system' } };`,
      `const renderer = createMermaidRenderer();`,
      `Promise.resolve(renderer.render({ lang: 'mermaid', source: 'flowchart TD\\n  A[Start] --> B[End]' }, ctx))`,
      `  .then(async (result) => {`,
      `    await _shutdownSingletonForTest();`,
      `    if (result.error) { console.error('RENDER_ERROR:' + JSON.stringify(result.error)); process.exit(1); }`,
      `    if (typeof result.html !== 'string' || !result.html.includes('<img')) { console.error('NO_IMG:' + JSON.stringify(result)); process.exit(1); }`,
      `    console.log('OK');`,
      `    process.exit(0);`,
      `  })`,
      `  .catch(async (err) => {`,
      `    await _shutdownSingletonForTest().catch(() => undefined);`,
      `    console.error('THROWN:' + (err && err.stack ? err.stack : err));`,
      `    process.exit(1);`,
      `  });`,
    ].join('\n');

    const output = execFileSync(process.execPath, ['-e', script], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(output.trim()).toBe('OK');
  }, 35_000);

  it("resolves from the REAL apps/crowi-runner project (spec §10 wiring: package.json dependency + crowi.config.json plugins entry) to this same built dist/index.js — the exact resolution @crowi/runner's resolvePlugins()/importPlugin() performs at api boot", () => {
    const runnerRequire = createRequire(path.join(RUNNER_APP_DIR, 'package.json'));
    const resolved = runnerRequire.resolve('@crowi/plugin-renderer-mermaid');
    // Compare real paths — pnpm links this package into the runner's
    // node_modules as a symlink.
    expect(realpathSync(resolved)).toBe(realpathSync(DIST_INDEX_PATH));
  });

  describe("boots via @crowi/runner's real resolvePlugins() (spec §10 boot path, not merely a path resolution)", () => {
    it('resolvePlugins(apps/crowi-runner) loads @crowi/plugin-renderer-mermaid, registerRenderer() registers its mermaid CodeBlockRenderer, and render() through that registered instance forks the built worker and returns a genuine <img>', () => {
      // This is the exact call `packages/api/src/plugin/plugin-manager.ts`'s
      // `bootstrap(projectDir)` makes at every api boot
      // (`resolvePlugins(projectDir)`), run here against the real
      // `apps/crowi-runner` project — not a stand-in — then driven
      // through `registerRenderer()`/`render()` exactly as the api's own
      // dispatch layer would.
      const output = runBootScript(RUNNER_APP_DIR);
      expect(output).toBe('OK');
    }, 35_000);
  });

  describe('pnpm-deployed production tree (packages/api/Dockerfile "deployer" stage equivalent — no Docker daemon required)', () => {
    let deployDir: string;

    beforeAll(() => {
      deployDir = mkdtempSync(path.join(tmpdir(), 'crowi-runner-deploy-'));
      // The literal command `packages/api/Dockerfile`'s `deployer` stage
      // runs (`RUN pnpm deploy --legacy --filter=${RUNNER_APP} --prod
      // /deploy`), into a throwaway directory instead of the image's
      // `/deploy`. Resolves `workspace:` deps to real files and installs
      // production-only (`--prod`) `node_modules` — no `devDependencies`
      // (so this is the first test anywhere in the suite exercising
      // Mermaid's runtime deps, `mermaid` + `jsdom`, WITHOUT any
      // dev-only package propping them up).
      execFileSync('pnpm', ['deploy', '--legacy', `--filter=@crowi/runner-app`, '--prod', deployDir], {
        cwd: REPO_ROOT,
        stdio: 'pipe',
        timeout: 120_000,
      });
    }, 150_000);

    afterAll(() => {
      if (deployDir) rmSync(deployDir, { recursive: true, force: true });
    });

    it("the deployed tree contains crowi.config.json (with @crowi/plugin-renderer-mermaid listed) and the plugin's dist/index.js + dist/render-worker.js under its production node_modules", () => {
      const deployedConfig = JSON.parse(readFileSync(path.join(deployDir, 'crowi.config.json'), 'utf8')) as { plugins: string[] };
      expect(deployedConfig.plugins).toContain('@crowi/plugin-renderer-mermaid');

      const deployedRequire = createRequire(path.join(deployDir, 'package.json'));
      const deployedIndex = deployedRequire.resolve('@crowi/plugin-renderer-mermaid');
      expect(existsSync(deployedIndex)).toBe(true);
      expect(existsSync(path.join(path.dirname(deployedIndex), 'render-worker.js'))).toBe(true);
    });

    it('resolvePlugins(deployDir) — the same call the container makes with WORKDIR=/app as its cwd/projectDir after `COPY --from=deployer /deploy /app` — loads @crowi/plugin-renderer-mermaid from the production-only tree and renders a real diagram through it', () => {
      const output = runBootScript(deployDir);
      expect(output).toBe('OK');
    }, 35_000);
  });
});
