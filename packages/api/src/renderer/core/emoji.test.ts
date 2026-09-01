import type { Root } from 'mdast';
import { createPipelineEsmDepsLoader } from '../pipeline';
import { makeEmojiUnifiedPlugin } from './emoji';

/**
 * Unit tests for the core emoji transform (feature-renderer-plugin-
 * boundary Phase 3, revised by feature-renderer-core-util-dedup) —
 * moved + adapted from the previous standalone emoji renderer plugin's
 * own test suite. The `CrowiPlugin.registerRenderer` wrapper-call
 * assertions from that file are dropped: emoji is no longer a
 * registry-registered plugin, it is a direct `pipeline.ts` `.use()`
 * call (see `pipeline.test.ts`'s "emoji (core, post-remarkBreaks
 * transform)" describe block for the `runPipeline`-level integration
 * coverage of that — no registry registration required, applied
 * unconditionally, ordered before external registry transforms).
 *
 * `remark-emoji` itself is no longer loaded by a module-level cache
 * owned by this file — that WAS the exact module-level-singleton-
 * shared-across-Crowi-instances anti-pattern `pipeline.ts`'s
 * `PipelineEsmDeps` doc comment warns against, which
 * feature-renderer-core-util-dedup removed. It is resolved through
 * `createPipelineEsmDepsLoader()` instead (one closure-local cache per
 * `createPipelineEsmDepsLoader()` call, i.e. per `Renderer` instance);
 * the describe block below asserts THAT property directly, replacing
 * the removed singleton assertion.
 */

interface UnifiedProcessor {
  use(plugin: unknown, options?: unknown): UnifiedProcessor;
  parse(input: string): Root;
  runSync(tree: Root): Root;
}

// One loader for the render-behaviour tests below — same instance
// reused across `buildEmojiProcessor()` calls, matching how a single
// `Renderer` reuses its own `LoadPipelineEsmDeps` across runs.
const loadDeps = createPipelineEsmDepsLoader();

/**
 * Build a unified processor + remark-parse processor and apply the
 * emoji transform through the actual `makeEmojiUnifiedPlugin` factory
 * (not a hand-rolled `.use(remarkEmoji, options)` call), then parse +
 * runSync the body. Returns the transformed mdast tree. Sources
 * `unified` / `remarkParse` / `remarkEmoji` from the SAME
 * `PipelineEsmDeps` loader `pipeline.ts` uses in production, rather
 * than a separate hand-rolled jiti load, so these tests exercise the
 * real per-instance-cached resolution path.
 */
async function buildEmojiProcessor(): Promise<UnifiedProcessor> {
  const deps = await loadDeps();
  return (deps.unified() as UnifiedProcessor).use(deps.remarkParse).use(makeEmojiUnifiedPlugin(deps.remarkEmoji));
}

type NodeShape = { type?: string; value?: string; data?: { hName?: string; hProperties?: Record<string, unknown> }; children?: NodeShape[] };

/**
 * Walk an mdast tree depth-first (document order) and collect every
 * node matching `predicate`. Shared by every assertion below that
 * needs to inspect the transformed tree, so the walk itself is written
 * once.
 */
function collectNodes(tree: Root, predicate: (node: NodeShape) => boolean): NodeShape[] {
  const out: NodeShape[] = [];
  const stack: NodeShape[] = [tree as NodeShape];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (predicate(node)) out.push(node);
    if (Array.isArray(node.children)) {
      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push(node.children[i]);
      }
    }
  }
  return out;
}

/**
 * Collect every `text` node's value. The remark-emoji transform
 * mutates text nodes in place, so the concatenated values describe
 * what users would see after the transform runs.
 */
function collectTextValues(tree: Root): string[] {
  return collectNodes(tree, (n) => n.type === 'text' && typeof n.value === 'string').map((n) => n.value as string);
}

describe('core emoji transform', () => {
  it('makeEmojiUnifiedPlugin returns a unified-plugin-shaped function', async () => {
    const { remarkEmoji } = await loadDeps();
    expect(typeof makeEmojiUnifiedPlugin(remarkEmoji)).toBe('function');
  });

  it('end-to-end: `:smile:` is replaced with the unicode emoji', async () => {
    const processor = await buildEmojiProcessor();
    const tree = processor.runSync(processor.parse('Hi :smile: there!'));
    const texts = collectTextValues(tree).join('|');
    expect(texts).toContain('😄');
  });

  it('end-to-end: unknown shortcode `:not-emoji:` is preserved verbatim', async () => {
    const processor = await buildEmojiProcessor();
    const tree = processor.runSync(processor.parse('try :not-emoji: maybe'));
    const texts = collectTextValues(tree).join('');
    expect(texts).toContain(':not-emoji:');
  });

  it('end-to-end: `:smile:` inside a fenced code block is NOT replaced', async () => {
    const processor = await buildEmojiProcessor();
    const md = ['```', ':smile:', '```'].join('\n');
    const tree = processor.runSync(processor.parse(md));
    // The code block is a leaf with `value` carrying the raw source.
    const codeNode = tree.children[0] as { type: string; value?: string };
    expect(codeNode.type).toBe('code');
    expect(codeNode.value).toBe(':smile:');
  });

  it('end-to-end: `:smile:` inside inline code is NOT replaced', async () => {
    const processor = await buildEmojiProcessor();
    const tree = processor.runSync(processor.parse('live `:smile:` and bare :smile: end.'));
    // Collect inlineCode text + regular text — the inlineCode value
    // should still be `:smile:`, only the bare one was substituted.
    const inlineCodeValues = collectNodes(tree, (n) => n.type === 'inlineCode' && typeof n.value === 'string').map((n) => n.value as string);
    expect(inlineCodeValues).toContain(':smile:');
    // And the bare one was replaced in text nodes.
    expect(collectTextValues(tree).join('')).toContain('😄');
  });

  it('end-to-end: accessible:true stamps mdast-to-hast props (role=img + aria-label) on the emoji text node', async () => {
    // remark-emoji's accessible mode does NOT emit an html node — it
    // attaches `data.hName='span'` + `data.hProperties={role,ariaLabel}`
    // to the text node, which mdast-util-to-hast / hast-util-to-html
    // turns into `<span role="img" aria-label="smile emoji">😄</span>`
    // at HTML emission. We assert the mdast-level stamp here.
    const processor = await buildEmojiProcessor();
    const tree = processor.runSync(processor.parse(':smile:'));
    const stamped = collectNodes(tree, (n) => n.type === 'text' && n.data?.hName === 'span' && n.data.hProperties?.role === 'img')[0] ?? null;
    expect(stamped).not.toBeNull();
    const ariaLabel = stamped?.data?.hProperties?.ariaLabel;
    expect(typeof ariaLabel).toBe('string');
    expect(ariaLabel).toMatch(/smile/);
  });
});

describe('remark-emoji resolution is per-Renderer-instance (feature-renderer-core-util-dedup)', () => {
  it('same loader instance: a second loadDeps() call does not re-resolve remark-emoji (memoized)', async () => {
    const first = await loadDeps();
    const second = await loadDeps();
    // `createPipelineEsmDepsLoader()`'s closure-local `cached` gate
    // means the whole `PipelineEsmDeps` bundle (and therefore
    // `remarkEmoji`) is the SAME object on a repeat call — no reload.
    expect(second).toBe(first);
    expect(second.remarkEmoji).toBe(first.remarkEmoji);
  });

  it('different loader instances do not share a cache — each createPipelineEsmDepsLoader() resolves independently', async () => {
    // Spy on `jiti`'s `createJiti` factory IN PLACE on the real module
    // object (rather than `jest.mock`-replacing the whole module) — this
    // repo's test setup (`src/test/setup.ts`) boots a real `Crowi`
    // instance before this test file's own body runs, which has already
    // required `pipeline.ts` (binding it to the real, unmocked `jiti`
    // module object). A `jest.mock('jiti', ...)` registered from THIS
    // file would only affect requires that happen after it, missing
    // `pipeline.ts`'s already-bound reference entirely. `jest.spyOn`
    // instead mutates `createJiti` on that SAME already-shared module
    // object, so `pipeline.ts`'s calls are observed too. `require` (not
    // `import`), specifically to get the exact module object every
    // other `require('jiti')` call (including `pipeline.ts`'s) already
    // shares.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const jitiModule = require('jiti') as typeof import('jiti');
    const createJitiSpy = jest.spyOn(jitiModule, 'createJiti');

    // try/finally so the spy is restored even if an assertion or a
    // loader call throws partway through — leaving `createJiti` spied
    // (and its mock state accumulating) would bleed into every test
    // that runs afterwards in this file/process.
    try {
      const loaderA = createPipelineEsmDepsLoader();
      const loaderB = createPipelineEsmDepsLoader();

      await loaderA();
      expect(createJitiSpy).toHaveBeenCalledTimes(1);

      // If `remarkEmoji` (or any other ESM dep) were resolved through a
      // shared module-level cache instead of `loaderB`'s OWN closure —
      // the exact bug removed from `emoji.ts`'s old `remarkEmojiCache` —
      // this second, independent loader would short-circuit and never
      // call `createJiti` again. It must call it again.
      await loaderB();
      expect(createJitiSpy).toHaveBeenCalledTimes(2);

      // A loader that's already warm must not reload on a repeat call —
      // this is `loaderA`'s OWN cache being reused, not `loaderB`'s.
      await loaderA();
      expect(createJitiSpy).toHaveBeenCalledTimes(2);
    } finally {
      createJitiSpy.mockRestore();
    }
  });
});
