import { createJiti } from 'jiti';
import type { CrowiPlugin } from '@crowi/plugin-api';

/**
 * `remark-breaks` is ESM-only (`type: module`, exports `./index.js`) and
 * depends on unified@^11 which is also ESM-only. The api package runs as
 * CJS Express + ts-jest under jest, so we cannot rely on a top-level
 * `import remarkBreaks from 'remark-breaks'` — TypeScript with
 * `module: commonjs` downlevels it to `require()`, which throws
 * `ERR_REQUIRE_ESM` on the jest path.
 *
 * Mirror the Phase 2 pattern from
 * `apps/crowi-api/src/renderer/pipeline.ts:createPipelineEsmDepsLoader` and
 * use `jiti` (which bundles its own ESM loader) to synchronously load the
 * package the first time `registerRenderer` runs. Caching is per-plugin-
 * activation; a fresh `Crowi` instance gets a fresh load.
 *
 * `addUnifiedPlugin` accepts an opaque `unknown` and unified resolves it
 * at `processor.use()` time, so passing the loaded module reference here
 * is enough — we don't need to await or wrap.
 */
type RemarkBreaksPlugin = unknown;

let remarkBreaksCache: RemarkBreaksPlugin | null = null;

/**
 * Load `remark-breaks` synchronously via jiti and cache the result.
 * Exported for the in-package test only; production code paths reach
 * this through `registerRenderer` below.
 *
 * Why `.default` rather than relying on `interopDefault: true`: jiti's
 * `interopDefault` only unwraps when the loaded module has shape
 * `{ default: X, __esModule: true }`. ESM-only packages like
 * remark-breaks expose `{ default: <function> }` without the
 * `__esModule` marker (it's set by transpilers for CJS interop, not by
 * the spec), so jiti leaves it wrapped. Matching the api package's
 * `pipeline.ts` pattern, we read `.default` ourselves.
 */
export function loadRemarkBreaks(): RemarkBreaksPlugin {
  if (remarkBreaksCache !== null) return remarkBreaksCache;
  const jiti = createJiti(__filename, { interopDefault: true });
  const mod = jiti('remark-breaks') as { default: RemarkBreaksPlugin };
  remarkBreaksCache = mod.default;
  return remarkBreaksCache;
}

/**
 * Crowi v1 compatibility renderer.
 *
 * Phase 5 of RFC-0002 ships a single feature: single-newline → `<br>`
 * (the v1 "Markdown Fixer" behaviour) via `remark-breaks` on the
 * transform phase. Other v1 quirks (H1 → title extraction, PHP-style
 * include, Crowi-specific tokens) are intentionally out of scope and
 * may be added under Phase 5.1+ as individual config-toggleable
 * features.
 *
 * The plugin is bundled in the monorepo but is **NOT** activated by
 * default — operators add `@crowi/plugin-renderer-crowi-legacy` to their
 * runner's `crowi.config.json:plugins` array to opt in. Migrated v1
 * installs should enable it; fresh v2 installs typically leave it off so
 * single newlines stay as soft-breaks (CommonMark default).
 *
 * Renderer pipeline order: registry-stored transforms run AFTER the
 * core 4 (headings → wikilinks → mentions → code-block-languages), so
 * heading slugs are computed before `remark-breaks` inserts `break`
 * nodes — anchor IDs are unaffected.
 */
const plugin: CrowiPlugin = {
  name: '@crowi/plugin-renderer-crowi-legacy',
  version: '0.1.0-dev',
  // No configSchema: Phase 5 ships exactly one quirk and there's
  // nothing to tune per-install. Phase 5.1+ may split breaks /
  // fixHeadings / etc. into individual booleans once more quirks land.

  // adminPlacement: the Phase 4-landed admin plugin list reads this
  // to surface a sensible label + section in `/admin/plugins`. We use
  // 'shared' because Phase 5 plugins have no register* hook the admin
  // sidebar derives sections from (only registerRenderer, which is
  // not part of the section auto-derive map).
  adminPlacement: {
    section: 'shared',
    label: 'Crowi v1 互換レンダラー',
    icon: 'wand-2',
  },

  registerRenderer: (registry, ctx) => {
    const remarkBreaks = loadRemarkBreaks();
    registry.addUnifiedPlugin(remarkBreaks, { phase: 'transform' });
    ctx.log.debug('registered remark-breaks on the transform phase (v1 single-newline → <br>)');
  },
};

export default plugin;
