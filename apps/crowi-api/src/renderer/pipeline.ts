import type { RenderContext } from '@crowi/plugin-api';
import type { Root } from 'mdast';
import type { TocEntryResponse, WikiLinkResponse, MentionResponse } from '@crowi/api-contract';
import type { MongoCacheStorage } from './cache';
import { buildCorePlugins, buildPluginDispatchPlugins } from './core';
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
  GithubSlugger: new () => { slug(text: string): string };
  mdastToString: (node: unknown) => string;
  /**
   * Pre-warmed shiki highlighter bound to a fixed theme (`github-light`
   * for Phase 3) and the bundled language set. Lazily initialised on
   * first pipeline run; subsequent runs share the same instance.
   * Theme switching / dynamic language loading is deferred to Phase 6+.
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

// Phase 3: bundled language set for shiki. Picked to cover the
// common cases (TS / JS / Python / shell / config files / Go /
// Rust / Java / SQL / HTML / CSS / Markdown) without dragging in the
// full ~150-language pack. Unknown languages fall through unhighlighted
// and the web client renders them as plain `<pre><code>` (parity with
// Phase 2 behaviour).
const SHIKI_BUNDLED_LANGS = [
  'ts',
  'tsx',
  'js',
  'jsx',
  'python',
  'json',
  'yaml',
  'shell',
  'bash',
  'html',
  'css',
  'markdown',
  'sql',
  'go',
  'rust',
  'java',
] as const;

const SHIKI_THEME = 'github-light';

interface ShikiCreateHighlighter {
  (opts: {
    themes: string[];
    langs: readonly string[];
  }): Promise<{
    codeToHtml(code: string, opts: { lang: string; theme: string }): string;
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
    const sluggerMod = jiti('github-slugger') as { default: new () => { slug(text: string): string } };
    const mdastToStringMod = jiti('mdast-util-to-string') as { toString: (node: unknown) => string };
    // shiki is ESM-only too; its bundled core entry exposes
    // `createHighlighter` (^1.x and ^2.x and ^4.x). We init once with
    // the fixed Phase 3 theme + language set so per-block calls don't
    // pay the cold-load every time.
    const shikiMod = jiti('shiki') as { createHighlighter: ShikiCreateHighlighter };
    const rawHighlighter = await shikiMod.createHighlighter({
      themes: [SHIKI_THEME],
      langs: [...SHIKI_BUNDLED_LANGS],
    });
    const loadedLangs = new Set(rawHighlighter.getLoadedLanguages());
    const shikiHighlighter: ShikiHighlighter = {
      codeToHtml(code, lang) {
        return rawHighlighter.codeToHtml(code, { lang, theme: SHIKI_THEME });
      },
      hasLang(lang) {
        return loadedLangs.has(lang);
      },
    };
    cached = {
      unified: unifiedMod.unified,
      remarkParse: remarkParseMod.default,
      remarkGfm: remarkGfmMod.default,
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
  const { unified, remarkParse, remarkGfm } = deps;

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
