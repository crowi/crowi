import { createJiti } from 'jiti';

/**
 * Emoji shortcode transform — core Markdown feature
 * (feature-renderer-plugin-boundary Phase 3).
 *
 * Replaces `:smile:` and other known shortcodes with Unicode emoji via
 * `remark-emoji`. No I/O, no cache. Code blocks (` ``` `) and inline
 * code (`` ` ``) are intentionally skipped — remark-emoji's default
 * walker stays in phrasing text content.
 *
 * Unknown shortcodes (`:not-emoji:`) are passed through verbatim, so
 * an author who writes `:typo:` won't see surprise corruption.
 *
 * Moved verbatim from `@crowi/plugin-renderer-emoji` (the package
 * itself stays in the workspace until Phase 4 deletes it — see spec
 * §4/§5): emoji is no longer a registry-registered plugin transform,
 * it is a hard-coded `pipeline.ts` `.use()` call inserted directly
 * between `remarkBreaks` and the registry's external transform loop.
 * `remark-emoji` is ESM-only (depends on unified@^11), so this module
 * still loads it through `jiti` on first use — `createJiti(__filename,
 * …)` keeps working unchanged since it re-resolves relative to THIS
 * file's own location.
 */

/**
 * Options passed to `remark-emoji`. Baked in — Crowi does not expose
 * these as admin-configurable:
 *   - `accessible: true` wraps the emoji in `<span role="img" aria-label="smile">`,
 *     for screen-reader UX.
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
 * The unified-plugin factory `pipeline.ts` hands to `processor.use(...)`.
 * unified's `.use(plugin, opts)` calls `plugin.call(processor, opts)`,
 * so the plugin must be invoked with the unified processor as `this`.
 * We pass the loaded `remark-emoji` reference through with our baked-
 * in options instead of whatever the caller passed (the pipeline always
 * passes `PipelineMetadata`, which this transform has no use for)
 * — `.apply()` preserves the `this` binding so remark-emoji's internal
 * `this.parser` access works.
 */
export function emojiUnifiedPlugin(this: unknown, _passedOptions?: unknown): unknown {
  const remarkEmoji = loadRemarkEmoji();
  return (remarkEmoji as (...args: unknown[]) => unknown).apply(this, [REMARK_EMOJI_OPTIONS]);
}
