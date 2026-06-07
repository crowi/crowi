import type { RenderContext } from '@crowi/plugin-api';
import type { Root } from 'mdast';
import type { TocEntryResponse, WikiLinkResponse, MentionResponse } from '@crowi/api-contract';
import type { MongoCacheStorage } from './cache';
import { buildCorePlugins, buildPluginDispatchPlugins } from './core';
import { makeMentionResolve, type MentionUsernameResolver } from './core/mention-resolve';
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
}

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
  GithubSlugger: new () => { slug(text: string): string };
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

/**
 * Subset of shiki's `Highlighter` we actually use. Bound to a
 * single theme so callers don't have to re-pass it at every call.
 */
export interface ShikiHighlighter {
  /** Synchronously render `code` to themed `<pre><code>...</code></pre>` HTML. */
  codeToHtml(code: string, lang: string): string;
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
    getLoadedLanguages(): string[];
  }>;
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
    const sluggerMod = jiti('github-slugger') as { default: new () => { slug(text: string): string } };
    const mdastToStringMod = jiti('mdast-util-to-string') as { toString: (node: unknown) => string };
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
      hasLang(lang) {
        return loadedLangs.has(lang);
      },
    };
    cached = {
      unified: unifiedMod.unified,
      remarkParse: remarkParseMod.default,
      remarkGfm: remarkGfmMod.default,
      remarkBreaks: remarkBreaksMod.default,
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
  const metadata: PipelineMetadata = {
    toc: [],
    wikiLinks: [],
    mentions: [],
    codeBlockLanguages: [],
  };

  if (!body) {
    return { tree: emptyRoot(), metadata };
  }

  const deps = await loadDeps();
  const { unified, remarkParse, remarkGfm, remarkBreaks } = deps;

  // Build the processor with parser + GFM tweaks first, then layer
  // the core 4 transform plugins (headings → wikilinks → mentions →
  // code-block-languages) bound to the metadata bag, and finally
  // every external plugin from the registry in registration order.
  let processor = unified().use(remarkParse).use(remarkGfm);

  // Each transform plugin is `(metadata) => (tree) => void`. unified's
  // `use(plugin, options)` invokes the plugin once with `options` and
  // gets back the actual transformer.
  for (const plugin of buildCorePlugins(deps)) {
    processor = processor.use(plugin as never, metadata);
  }

  // GFM-compatible single-newline → `<br>` (Crowi default). Runs
  // after the core 4 so heading slugs were computed against pristine
  // heading text; runs before registry plugins so external transforms
  // see the post-breaks tree.
  processor = processor.use(remarkBreaks as never);

  for (const plugin of registry.getTransformPlugins()) {
    // External plugins can be either factory `(opts) => Transformer`
    // or plain `Transformer`. We always pass `metadata` so external
    // plugins that want to push into it can; those that don't will
    // just ignore the option.
    processor = processor.use(plugin as never, metadata);
  }

  const tree = processor.parse(body) as Root;
  const transformed = processor.runSync(tree) as Root;

  // Phase 4 plugin-dispatch — embed-tag + url-inline-expand. These
  // need to be async (cache I/O + plugin render()) so they cannot
  // run inside the synchronous unified `runSync` phase. We post-
  // process the transformed tree in registration order:
  //   1. parse `@[tag](url)` from text nodes and dispatch to
  //      registered embed renderers.
  //   2. walk paragraph children for bare URLs and dispatch to the
  //      registered url-inline-expanders.
  // Skipped when no dispatch object is supplied (unit tests bypassing
  // Mongo) or `pageId` is null (orphan revision body) — `@[tag](url)`
  // stays as plain text.
  if (dispatch && dispatch.pageId) {
    const dispatchPlugins = buildPluginDispatchPlugins(registry, ctx, { cache: dispatch.cache, pageId: dispatch.pageId });
    for (const transform of dispatchPlugins) {
      await transform(transformed);
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
