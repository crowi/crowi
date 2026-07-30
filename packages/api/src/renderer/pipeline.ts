import type { MentionResponse, TocEntryResponse, WikiLinkResponse } from '@crowi/api-contract';
import type { RenderContext } from '@crowi/plugin-api';
import type { Root } from 'mdast';
import type { MongoCacheStorage } from './cache';
import { buildCorePlugins, buildPluginDispatchPlugins, makePreviewCodeBlockDispatch } from './core';
import { makeEmojiUnifiedPlugin, type RemarkEmojiFn } from './core/emoji';
import { type MentionUsernameResolver, makeMentionResolve } from './core/mention-resolve';
import { RendererRegistryImpl } from './registry';

/**
 * Output of a single pipeline run. The mdast tree itself is currently
 * only consumed by the pipeline (and discarded after metadata
 * extraction); Phase 3 will start using it for SSR HTML generation.
 */
export interface PipelineResult {
  tree: Root;
  metadata: PipelineMetadata;
}

/** Metadata collected during the transform phase. */
export interface PipelineMetadata {
  toc: TocEntryResponse[];
  wikiLinks: WikiLinkResponse[];
  mentions: MentionResponse[];
  codeBlockLanguages: string[];
  /**
   * feature-backlink-raw-space-metadata: verbatim `url` destinations of
   * every raw-space link `raw-space-links.ts` recovers, in the same
   * "core transform pushes into this bag" shape `wikiLinks` above uses
   * (see that transform's own doc comment). Replaces the old
   * `data.rawSpaceRecovered` AST marker that `Backlink.createBySavedPage`
   * used to find by walking the whole `renderedAst` on every save.
   */
  rawSpaceLinks: string[];
}

/**
 * A fresh, all-empty `PipelineMetadata` — a new object every call, so callers
 * never share arrays.
 *
 * Use this instead of writing the object literal out. `packages/api`'s
 * tsconfig excludes test files from `tsc`, and the shared base sets
 * `isolatedModules`, so ts-jest runs transpile-only: a test that hand-writes
 * the literal and misses a field does NOT fail to compile — it fails at
 * runtime, the day some transform starts pushing into that field. Routing
 * every construction through here means adding a field cannot leave a stale
 * literal behind.
 */
export const createEmptyPipelineMetadata = (): PipelineMetadata => ({
  toc: [],
  wikiLinks: [],
  mentions: [],
  codeBlockLanguages: [],
  rawSpaceLinks: [],
});

/**
 * Lazily-resolved ESM-only handles needed by the pipeline + core
 * plugins. unified, remark-parse, remark-gfm, github-slugger,
 * mdast-util-to-string, and shiki are all ESM-only; they are loaded
 * from CJS Express via a wrapped `Function('return import(...)')` call
 * so TypeScript with `module: commonjs` doesn't downlevel the import
 * to `require()` (which fails on ESM packages with `ERR_REQUIRE_ESM`).
 *
 * Loaded once and cached process-wide for the lifetime of the
 * Crowi instance.
 */
export interface PipelineEsmDeps {
  unified: () => UnifiedProcessor;
  remarkParse: unknown;
  remarkGfm: unknown;
  /**
   * GFM-compatible single-newline → `<br>` conversion. Crowi default;
   * matches GitHub's rendering. Plugged in between the core 4 and the
   * registry transforms so heading slugs (computed via `mdastToString`
   * in the headings transform) are unaffected by injected `break`
   * nodes — anchors stay byte-identical to the GFM-only build.
   */
  remarkBreaks: unknown;
  /**
   * `remark-emoji`'s default export (feature-renderer-core-util-dedup —
   * moved here from a module-level cache inside `core/emoji.ts`, which
   * was the exact anti-pattern this interface's own cross-instance
   * caching warning below is about). `core/emoji.ts`'s
   * `makeEmojiUnifiedPlugin` wraps this with the pipeline's baked-in
   * options.
   */
  remarkEmoji: RemarkEmojiFn;
  GithubSlugger: new () => { slug(text: string): string };
  /**
   * `mdast-util-to-string`'s `toString`. Called with no options (default
   * `includeHtml: true`), so the headings transform receives the raw heading
   * markup and strips only *known* HTML tags itself (`stripKnownHtmlTags`),
   * rather than asking `mdast-util-to-string` to blanket-drop any HTML node.
   */
  mdastToString: (node: unknown) => string;
  /**
   * Pre-warmed shiki highlighter bound to a **dual theme** (`github-light`
   * + `github-dark`) and the bundled language set. Lazily initialised on
   * first pipeline run; subsequent runs share the same instance.
   *
   * Emitted markup uses shiki's `defaultColor: false` mode, so each token
   * carries `--shiki-light` / `--shiki-dark` CSS variables (and the `<pre>`
   * carries `--shiki-light-bg` / `--shiki-dark-bg`) instead of a single
   * inlined colour. The web side (`globals.css` `.shiki` rules) then picks
   * the light or dark variable per `.dark` class — see the dark-mode
   * feature. Dynamic language loading is deferred to a later phase.
   */
  shikiHighlighter: ShikiHighlighter;
}

/** RFC-0023 — one themed style variant of a shiki token (wire shape of `ShikiTokenStyleSchema`). */
export interface CrowiShikiTokenStyle {
  color: string;
  bgColor?: string;
  fontStyle?: Array<'italic' | 'bold' | 'underline' | 'strikethrough'>;
}
/** RFC-0023 — a single shiki token carrying both theme variants (wire shape of `ShikiTokenSchema`). */
export interface CrowiShikiToken {
  content: string;
  light: CrowiShikiTokenStyle;
  dark: CrowiShikiTokenStyle;
}
export type CrowiShikiTokenLine = CrowiShikiToken[];

/**
 * Subset of shiki's `Highlighter` we actually use. Bound to a
 * single theme so callers don't have to re-pass it at every call.
 */
export interface ShikiHighlighter {
  /** Synchronously render `code` to themed `<pre><code>...</code></pre>` HTML. */
  codeToHtml(code: string, lang: string): string;
  /**
   * RFC-0023 — themed token lines (light/dark variants) for the
   * `data.crowiCode` sidecar. Same theme pair / language set as
   * `codeToHtml`. Throws propagate to the caller (the sidecar producer
   * treats a throw as "no tokens" — the html output is unaffected).
   */
  codeToTokens(code: string, lang: string): CrowiShikiTokenLine[];
  /** Best-effort check; cheap, does NOT throw on unknown langs. */
  hasLang(lang: string): boolean;
}

interface UnifiedProcessor {
  use(plugin: unknown, options?: unknown): UnifiedProcessor;
  parse(input: string): Root;
  runSync(tree: Root): Root;
}

/**
 * Loader for the ESM-only pipeline deps. Node 22 supports synchronous
 * `require()` of ESM modules natively (`--experimental-require-module`
 * default-on since 22.12), so from a CJS module we can just `require`
 * unified, remark-parse, remark-gfm, github-slugger, and
 * mdast-util-to-string. The `Function('return require(...)')` wrapper
 * dodges the `transformIgnorePatterns` jest cache that sometimes
 * routes plain require() into ts-jest's resolver.
 *
 * Each `Renderer` instance owns its own cache (via
 * `createPipelineEsmDepsLoader()` in renderer/index.ts); sharing a
 * module-level cache across Crowi instances breaks under jest where
 * each test file boots a fresh `Crowi`.
 */
export type LoadPipelineEsmDeps = () => Promise<PipelineEsmDeps>;

// `createJiti` lets us synchronously `require()` ESM-only packages
// (`unified`, `remark-*`, `mdast-*`, `github-slugger`) from CJS Express.
// We can't use Node 22's native sync require-of-ESM because jest's
// runtime intercepts `require` and throws `Unexpected token 'export'`
// for ESM packages; we can't use `await import()` because under jest's
// `--experimental-vm-modules` flag the import callback intermittently
// fires after the test environment was torn down. jiti has its own
// loader that bypasses both, so all paths agree.
import { createJiti } from 'jiti';

// Bundled language set for shiki. Covers the languages we actually
// see in Crowi pages without dragging in the full ~150-language pack;
// unknown languages fall through unhighlighted and the web client
// renders them as plain `<pre><code>` (parity with Phase 2 behaviour).
// Add to this list when a new language shows up in real content.
const SHIKI_BUNDLED_LANGS = [
  'ts',
  'tsx',
  'js',
  'jsx',
  'python',
  'ruby',
  'php',
  'json',
  'yaml',
  'toml',
  'shell',
  'bash',
  'html',
  'css',
  'markdown',
  'sql',
  'go',
  'rust',
  'java',
  'c',
  'cpp',
  'csharp',
  'dockerfile',
  'diff',
] as const;

// Dual theme: light + dark are both compiled into the highlighter and
// emitted together via `defaultColor: false` so a single render carries
// both colour sets as CSS variables. The web client switches between
// them with the `.dark` class — no re-render / second pipeline run.
const SHIKI_THEMES = {
  light: 'github-light',
  dark: 'github-dark',
} as const;

/** Raw token shape from shiki's `codeToTokensWithThemes` (per-theme variants keyed by our `light` / `dark`). */
interface ShikiRawVariantToken {
  content: string;
  variants: Record<string, { color?: string; bgColor?: string; fontStyle?: number }>;
}

interface ShikiCreateHighlighter {
  (opts: {
    themes: string[];
    langs: readonly string[];
  }): Promise<{
    codeToHtml(
      code: string,
      opts: {
        lang: string;
        themes: { light: string; dark: string };
        defaultColor: false;
      },
    ): string;
    codeToTokensWithThemes(
      code: string,
      opts: {
        lang: string;
        themes: { light: string; dark: string };
      },
    ): ShikiRawVariantToken[][];
    getLoadedLanguages(): string[];
  }>;
}

/** shiki's `FontStyle` bitmask → the wire enum array (RFC-0023 §10). */
function fontStyleToArray(fontStyle: number | undefined): Array<'italic' | 'bold' | 'underline' | 'strikethrough'> | undefined {
  if (fontStyle === undefined || fontStyle <= 0) return undefined;
  const out: Array<'italic' | 'bold' | 'underline' | 'strikethrough'> = [];
  if (fontStyle & 1) out.push('italic');
  if (fontStyle & 2) out.push('bold');
  if (fontStyle & 4) out.push('underline');
  if (fontStyle & 8) out.push('strikethrough');
  return out.length > 0 ? out : undefined;
}

function toCrowiTokenStyle(variant: { color?: string; bgColor?: string; fontStyle?: number } | undefined): CrowiShikiTokenStyle {
  const fontStyle = fontStyleToArray(variant?.fontStyle);
  return {
    color: variant?.color ?? '',
    ...(variant?.bgColor !== undefined ? { bgColor: variant.bgColor } : {}),
    ...(fontStyle !== undefined ? { fontStyle } : {}),
  };
}

export function createPipelineEsmDepsLoader(): LoadPipelineEsmDeps {
  let cached: PipelineEsmDeps | null = null;
  return async () => {
    if (cached) return cached;
    // Sync `require`-of-ESM via jiti. Wrapped in async so the call
    // site signature stays Promise<PipelineEsmDeps> (Phase 3 may go
    // back to `await import()` once jest catches up to native ESM).
    const jiti = createJiti(__filename, { interopDefault: true });
    const unifiedMod = jiti('unified') as { unified: () => UnifiedProcessor };
    const remarkParseMod = jiti('remark-parse') as { default: unknown };
    const remarkGfmMod = jiti('remark-gfm') as { default: unknown };
    // remark-breaks is ESM-only (`type: module`); like the rest of
    // the pipeline deps, we read `.default` ourselves because the
    // package doesn't carry the `__esModule` marker jiti needs for
    // its `interopDefault` unwrap.
    const remarkBreaksMod = jiti('remark-breaks') as { default: unknown };
    // remark-emoji is ESM-only too (feature-renderer-core-util-dedup —
    // resolved here, per-Renderer-instance, instead of the module-level
    // cache `core/emoji.ts` used to keep on its own).
    const remarkEmojiMod = jiti('remark-emoji') as { default: RemarkEmojiFn };
    const sluggerMod = jiti('github-slugger') as { default: new () => { slug(text: string): string } };
    const mdastToStringMod = jiti('mdast-util-to-string') as {
      toString: (node: unknown) => string;
    };
    // shiki is ESM-only too; its bundled core entry exposes
    // `createHighlighter` (^1.x and ^2.x and ^4.x). We init once with
    // the dual (light + dark) theme + language set so per-block calls
    // don't pay the cold-load every time.
    const shikiMod = jiti('shiki') as { createHighlighter: ShikiCreateHighlighter };
    const rawHighlighter = await shikiMod.createHighlighter({
      themes: [SHIKI_THEMES.light, SHIKI_THEMES.dark],
      langs: [...SHIKI_BUNDLED_LANGS],
    });
    const loadedLangs = new Set(rawHighlighter.getLoadedLanguages());
    const shikiHighlighter: ShikiHighlighter = {
      codeToHtml(code, lang) {
        // `defaultColor: false` → tokens carry `--shiki-light` /
        // `--shiki-dark` (and the `<pre>` `--shiki-light-bg` /
        // `--shiki-dark-bg`) CSS variables instead of a single inlined
        // colour, so `.dark` can switch them client-side.
        return rawHighlighter.codeToHtml(code, {
          lang,
          themes: SHIKI_THEMES,
          defaultColor: false,
        });
      },
      codeToTokens(code, lang) {
        // RFC-0023 §10 — the sidecar's themed token lines. Same theme
        // pair as `codeToHtml`; `htmlStyle` / `htmlAttrs` are never
        // emitted (Crowi uses no shiki transformers).
        const lines = rawHighlighter.codeToTokensWithThemes(code, { lang, themes: SHIKI_THEMES });
        return lines.map((line) =>
          line.map((token) => ({
            content: token.content,
            light: toCrowiTokenStyle(token.variants.light),
            dark: toCrowiTokenStyle(token.variants.dark),
          })),
        );
      },
      hasLang(lang) {
        return loadedLangs.has(lang);
      },
    };
    cached = {
      unified: unifiedMod.unified,
      remarkParse: remarkParseMod.default,
      remarkGfm: remarkGfmMod.default,
      remarkBreaks: remarkBreaksMod.default,
      remarkEmoji: remarkEmojiMod.default,
      GithubSlugger: sluggerMod.default,
      mdastToString: mdastToStringMod.toString,
      shikiHighlighter,
    };
    return cached;
  };
}

/**
 * Run the parse → transform pipeline against `body` and return the
 * mdast tree plus the collected metadata. The transform order is
 * fixed: registry-stored plugins run AFTER core registrations, in
 * registration order; node renderers fire after each transformer-driven
 * plugin completes.
 *
 * Phase 2 does NOT render to HTML — callers receive `metadata` and
 * (optionally) the tree. The body's HTML is still generated by
 * react-markdown on the web client.
 */
/**
 * Phase 4 plugin-dispatch options. Threaded through `runPipeline` so
 * the embed-tag + url-inline-expand transforms can reach the cache
 * storage and know which page they are rendering for.
 *
 * - `cache`: MongoDB-backed `CacheStorage`. The dispatch transforms
 *   per-plugin scope this internally.
 * - `pageId`: the embed cache key is `(pluginName, pluginCacheVersion,
 *   pageId, embedKey)`. When unknown (e.g. on-the-fly fallback for an
 *   orphan revision body or unit tests bypassing Mongo), the dispatch
 *   transforms degrade to no-op — `@[tag](url)` stays as plain text.
 */
export interface PipelinePluginDispatch {
  cache: MongoCacheStorage;
  pageId: string | null;
  /**
   * Phase 2 mention existence resolver — batch-checks which `@username`
   * mentions belong to real users. Built from the `User` model by
   * `createRenderer`'s `crowi` closure. When supplied AND the render is
   * in `mode: 'save'`, the mention-resolve transform demotes unknown-user
   * mention link nodes to plain text. Absent (unit tests, non-save runs)
   * → every `@username` keeps its link node, matching pre-Phase-2
   * behaviour. This is `pageId`-independent (orphan revision bodies are
   * still resolved).
   */
  resolveMentionUsernames?: MentionUsernameResolver;
}

export async function runPipeline(
  body: string,
  registry: RendererRegistryImpl,
  ctx: RenderContext,
  loadDeps: LoadPipelineEsmDeps,
  dispatch?: PipelinePluginDispatch,
): Promise<PipelineResult> {
  const metadata: PipelineMetadata = createEmptyPipelineMetadata();

  if (!body) {
    return { tree: emptyRoot(), metadata };
  }

  const deps = await loadDeps();
  const { unified, remarkParse, remarkGfm, remarkBreaks, remarkEmoji } = deps;

  // Build the processor with parser + GFM tweaks first, then layer
  // the core 4 transform plugins (headings → wikilinks → mentions →
  // code-block-languages) bound to the metadata bag, and finally
  // every external plugin from the registry in registration order.
  let processor = unified().use(remarkParse).use(remarkGfm);

  // Each transform plugin is `(metadata) => (tree) => void`. unified's
  // `use(plugin, options)` invokes the plugin once with `options` and
  // gets back the actual transformer.
  for (const plugin of buildCorePlugins(deps, body)) {
    processor = processor.use(plugin as never, metadata);
  }

  // GFM-compatible single-newline → `<br>` (Crowi default). Runs
  // after the core 4 so heading slugs were computed against pristine
  // heading text; runs before registry plugins so external transforms
  // see the post-breaks tree.
  processor = processor.use(remarkBreaks as never);

  // Emoji shortcode transform (feature-renderer-plugin-boundary Phase 3
  // — moved from a registry-registered plugin to a hard-coded core
  // transform). Deliberately NOT a `buildCorePlugins()` entry: that
  // list's factories are all `(metadata) => (tree) => void`, bound to
  // this run's `PipelineMetadata` bag, and emoji needs no metadata —
  // `makeEmojiUnifiedPlugin` returns unified's own `(this, opts) =>
  // Transformer` shape instead, bound to this loader's per-instance-
  // cached `remarkEmoji` (feature-renderer-core-util-dedup). Runs after
  // `remarkBreaks` (same position external plugin transforms occupied
  // when emoji was still plugin-registered) and before the registry's
  // external transforms, so it is applied unconditionally — no plugin
  // install / registration required.
  processor = processor.use(makeEmojiUnifiedPlugin(remarkEmoji) as never);

  for (const plugin of registry.getTransformPlugins()) {
    // External plugins can be either factory `(opts) => Transformer`
    // or plain `Transformer`. We always pass `metadata` so external
    // plugins that want to push into it can; those that don't will
    // just ignore the option.
    processor = processor.use(plugin as never, metadata);
  }

  const tree = processor.parse(body) as Root;
  const transformed = processor.runSync(tree) as Root;

  // Phase 4 plugin-dispatch — embed-tag + url-inline-expand + code-block
  // dispatch. These need to be async (cache I/O + plugin render()) so
  // they cannot run inside the synchronous unified `runSync` phase. Two
  // branches, both post-processing the transformed tree:
  //   - `dispatch.pageId` truthy (save / on-the-fly read/view) — the
  //     full 3-stage pipeline in registration order: (1) parse
  //     `@[tag](url)` from text nodes and dispatch to registered embed
  //     renderers, (2) walk paragraph children for bare URLs and
  //     dispatch to the registered url-inline-expanders, (3) code-block
  //     dispatch (PlantUML / Mermaid / …) via `cachedRender` /
  //     `cachedRenderOrPending` (Mongo-cached).
  //   - `dispatch` present but `pageId` is null/absent (feature-plugin-
  //     renderer-mermaid spec §7 item 3 — the editor live-preview call,
  //     `POST /pages/preview`) — embed-tags and url-inline-expand stay
  //     fully skipped, exactly as before this feature (a bare
  //     `@[tag](url)` / URL has no `pageId` to key an embed-cache row
  //     against, so there is nothing safe to dispatch to). Only
  //     `previewPolicy: 'server-render'` code-block registrations
  //     dispatch, through the non-persistent `makePreviewCodeBlockDispatch`
  //     — no `PluginRenderCache` write ever happens for preview content.
  // `dispatch` itself omitted entirely (unit tests bypassing Mongo) →
  // neither branch runs; `@[tag](url)` / code fences stay as plain text.
  if (dispatch) {
    if (dispatch.pageId) {
      const dispatchPlugins = buildPluginDispatchPlugins(registry, ctx, { cache: dispatch.cache, pageId: dispatch.pageId });
      for (const transform of dispatchPlugins) {
        await transform(transformed);
      }
    } else {
      await makePreviewCodeBlockDispatch(registry, ctx, { cache: dispatch.cache })(transformed);
    }
  }

  // Phase 2 mention resolution — demote `@username` link nodes whose
  // username does not belong to a real user back to plain text. Runs
  // only at save-time (`mode: 'save'`) so the persisted `renderedAst`
  // is already correct; read / view paths reuse it without re-querying.
  // `pageId`-independent: an orphan revision body still gets resolved.
  if (dispatch?.resolveMentionUsernames && ctx.mode === 'save') {
    await makeMentionResolve(dispatch.resolveMentionUsernames)(transformed);
  }

  // After all transforms, fire registered NodeRenderers for any
  // mdast type they registered for. Phase 2 has no bundled
  // NodeRenderer (the core 4 transforms touch the AST themselves);
  // this loop exists for external plugins.
  await runNodeRenderers(transformed, registry, ctx);

  return { tree: transformed, metadata };
}

interface MdastLikeNode {
  type?: string;
  children?: MdastLikeNode[];
}

async function runNodeRenderers(tree: Root, registry: RendererRegistryImpl, ctx: RenderContext): Promise<void> {
  const types = registry.getRegisteredNodeTypes();
  if (types.length === 0) return;
  const matchers = new Set(types);

  const stack: MdastLikeNode[] = [tree];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type && matchers.has(node.type)) {
      for (const renderer of registry.getNodeRenderers(node.type)) {
        await renderer(node, ctx);
      }
    }
    if (node.children) {
      for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
    }
  }
}

function emptyRoot(): Root {
  return { type: 'root', children: [] };
}
