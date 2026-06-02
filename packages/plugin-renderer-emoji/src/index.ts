import { createJiti } from 'jiti';
import type { CrowiPlugin } from '@crowi/plugin-api';

/**
 * @crowi/plugin-renderer-emoji
 *
 * Replaces `:smile:` and other known shortcodes with Unicode emoji via
 * `remark-emoji`. No I/O, no cache. Code blocks (` ``` `) and inline
 * code (`` ` ``) are intentionally skipped — remark-emoji's default
 * walker stays in phrasing text content.
 *
 * Unknown shortcodes (`:not-emoji:`) are passed through verbatim, so
 * an author who writes `:typo:` won't see surprise corruption.
 *
 * `remark-emoji` is ESM-only (depends on unified@^11), so the plugin
 * loads it through `jiti` on the first `registerRenderer` call —
 * mirroring the Phase 5 `@crowi/plugin-renderer-crowi-legacy` pattern.
 */

/**
 * Options passed to `remark-emoji`. Phase 6 bakes the defaults in at
 * registration time:
 *   - `accessible: true` wraps the emoji in `<span role="img" aria-label="smile">`,
 *     for screen-reader UX. Spec OQ recommended ON.
 *   - `emoticon: false` skips the legacy ASCII (`:)`, `:D`) → emoji
 *     pass — Crowi authors tend to type Unicode directly when they
 *     want a smiley, and turning emoticon on can swallow code-like
 *     punctuation patterns.
 *   - `padSpaceAfter: false` keeps tight inline rendering (`hi :smile:!`
 *     stays `hi 😀!`, not `hi 😀 !`).
 */
const REMARK_EMOJI_OPTIONS = {
  accessible: true,
  emoticon: false,
  padSpaceAfter: false,
} as const;

/**
 * Cached factory closure. The first call jiti-loads `remark-emoji` and
 * the cached body is reused for every subsequent boot of the same
 * process. Test-only export.
 */
type RemarkEmojiFn = (...args: unknown[]) => (...inner: unknown[]) => void;
let remarkEmojiCache: RemarkEmojiFn | null = null;

export function loadRemarkEmoji(): RemarkEmojiFn {
  if (remarkEmojiCache !== null) return remarkEmojiCache;
  const jiti = createJiti(__filename, { interopDefault: true });
  const mod = jiti('remark-emoji') as { default: RemarkEmojiFn };
  remarkEmojiCache = mod.default;
  return remarkEmojiCache;
}

/**
 * The unified-plugin factory we hand to `registry.addUnifiedPlugin`.
 * unified's `.use(plugin, opts)` calls `plugin.call(processor, opts)`,
 * so the plugin must be invoked with the unified processor as `this`.
 * We pass the loaded `remark-emoji` reference through with our baked-
 * in options instead of the metadata that the api passes — `.apply()`
 * preserves the `this` binding so remark-emoji's internal
 * `this.parser` access works.
 *
 * The api's `addUnifiedPlugin` path passes `PipelineMetadata` as the
 * second argument; we ignore it and substitute our REMARK_EMOJI_OPTIONS
 * instead.
 */
function emojiUnifiedPlugin(this: unknown, _passedOptions?: unknown): unknown {
  const remarkEmoji = loadRemarkEmoji();
  return (remarkEmoji as (...args: unknown[]) => unknown).apply(this, [REMARK_EMOJI_OPTIONS]);
}

const plugin: CrowiPlugin = {
  name: '@crowi/plugin-renderer-emoji',
  version: '0.1.0-dev',
  adminPlacement: {
    section: 'renderer',
    label: 'Emoji shortcodes',
    icon: 'smile',
  },
  registerRenderer: (registry, ctx) => {
    registry.addUnifiedPlugin(emojiUnifiedPlugin, { phase: 'transform' });
    ctx.log.debug('registered remark-emoji on the transform phase (`:smile:` → 😀)');
  },
};

export default plugin;
