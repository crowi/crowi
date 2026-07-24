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
 * Moved verbatim from the previous standalone emoji renderer plugin
 * (deleted from the workspace in Phase 4 — see spec §4/§5): emoji is
 * no longer a registry-registered plugin transform, it is a
 * hard-coded `pipeline.ts` `.use()` call inserted directly between
 * `remarkBreaks` and the registry's external transform loop.
 * `remark-emoji` is ESM-only (depends on unified@^11); its resolution
 * lives in `PipelineEsmDeps` / `createPipelineEsmDepsLoader()`
 * (`../pipeline.ts`) alongside the pipeline's other ESM-only deps, so
 * it is cached per-`Renderer`-instance instead of by a module-level
 * singleton in this file (feature-renderer-core-util-dedup — a
 * module-level cache here would reintroduce the exact anti-pattern
 * `createPipelineEsmDepsLoader`'s own doc comment warns against: a
 * cache shared across Crowi instances breaks under jest, where each
 * test file boots a fresh `Crowi`).
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

/** Shape of `remark-emoji`'s default export, as `PipelineEsmDeps` resolves it via jiti. */
export type RemarkEmojiFn = (...args: unknown[]) => (...inner: unknown[]) => void;

/**
 * Build the unified-plugin factory `pipeline.ts` hands to
 * `processor.use(...)`, bound to an already-resolved `remark-emoji`
 * (`deps.remarkEmoji`, per-`Renderer`-instance — see the module doc
 * comment above). unified's `.use(plugin, opts)` calls
 * `plugin.call(processor, opts)`, so the returned function must be
 * invoked with the unified processor as `this`. We pass the loaded
 * `remark-emoji` reference through with our baked-in options instead
 * of whatever the caller passed (the pipeline always passes
 * `PipelineMetadata`, which this transform has no use for) —
 * `.apply()` preserves the `this` binding so remark-emoji's internal
 * `this.parser` access works.
 */
export function makeEmojiUnifiedPlugin(remarkEmoji: RemarkEmojiFn): (this: unknown, _passedOptions?: unknown) => unknown {
  return function emojiUnifiedPlugin(this: unknown, _passedOptions?: unknown): unknown {
    return (remarkEmoji as (...args: unknown[]) => unknown).apply(this, [REMARK_EMOJI_OPTIONS]);
  };
}
