import type { PluginLogger, RenderContext } from '@crowi/plugin-api';
import { crowi } from 'src/test/setup';
import { createMongoCacheStorage, scopeForPlugin } from '../cache';
import { createPipelineEsmDepsLoader, runPipeline } from '../pipeline';
import { RendererRegistryImpl, createAuthContextStub, makeRendererScope } from '../registry';
import { fakeMathRenderer, fakeMathUnifiedPlugin, FAKE_MATH_NODE_TYPE } from './fake-math-embed';

/**
 * e2e (real pipeline) coverage for a parse+render optional-plugin
 * registration shape — `addUnifiedPlugin({ phase: 'transform' })`
 * introducing a custom mdast node type at parse time, plus
 * `addNodeRenderer` mutating that node type to `html` — the SAME two
 * registry/pipeline extension points `@crowi/plugin-renderer-katex`
 * combines. feature-renderer-plugin-boundary Phase 2 (§1/§4) converted
 * this suite off the real `katex`/`remark-math` packages onto
 * `fake-math-embed.ts`; the real KaTeX math rendering + CSS/font
 * self-serving now live in the plugin's own `index.test.ts` plus the
 * reference-runner integration suite
 * (`packages/e2e/tests/renderer-plugins.spec.ts`).
 */

const silentLogger: PluginLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const loadDeps = createPipelineEsmDepsLoader();

const PLUGIN = '@crowi/plugin-fixture-math';

const registerFakeMath = (reg: RendererRegistryImpl) => {
  const scope = makeRendererScope(reg, PLUGIN, silentLogger);
  scope.addUnifiedPlugin(fakeMathUnifiedPlugin, { phase: 'transform' });
  scope.addNodeRenderer(FAKE_MATH_NODE_TYPE, fakeMathRenderer);
};

describe('e2e: parse+render plugin registration shape (addUnifiedPlugin transform + addNodeRenderer)', () => {
  it('the transform-phase plugin introduces the custom node type at parse time, and the node renderer mutates it to html', async () => {
    const reg = new RendererRegistryImpl();
    registerFakeMath(reg);

    const storage = createMongoCacheStorage(crowi);
    const ctx: RenderContext = {
      mode: 'view',
      log: silentLogger,
      actor: { kind: 'system' },
      cache: scopeForPlugin(storage, PLUGIN),
      auth: createAuthContextStub(),
    };

    const body = 'Look at {{fm:x^2}} inline.';
    const result = await runPipeline(body, reg, ctx, loadDeps, { cache: storage, pageId: null });

    const para = result.tree.children[0] as { children: Array<{ type: string; value?: string }> };
    const html = para.children.find((c) => c.type === 'html');
    expect(html).toBeDefined();
    expect((html as { value: string }).value).toBe('<span class="fake-math">x^2</span>');
  });

  it('renders multiple occurrences in the same body, each mutated independently', async () => {
    const reg = new RendererRegistryImpl();
    registerFakeMath(reg);

    const storage = createMongoCacheStorage(crowi);
    const ctx: RenderContext = {
      mode: 'view',
      log: silentLogger,
      actor: { kind: 'system' },
      cache: scopeForPlugin(storage, PLUGIN),
      auth: createAuthContextStub(),
    };

    const body = '{{fm:a+b}} then {{fm:c*d}}.';
    const result = await runPipeline(body, reg, ctx, loadDeps, { cache: storage, pageId: null });

    const para = result.tree.children[0] as { children: Array<{ type: string; value?: string }> };
    const htmlValues = para.children.filter((c) => c.type === 'html').map((c) => c.value);
    expect(htmlValues).toEqual(['<span class="fake-math">a+b</span>', '<span class="fake-math">c*d</span>']);
  });

  it('without the plugin registered, the marker text passes through untouched (control)', async () => {
    const reg = new RendererRegistryImpl();
    const storage = createMongoCacheStorage(crowi);
    const ctx: RenderContext = {
      mode: 'view',
      log: silentLogger,
      actor: { kind: 'system' },
      cache: scopeForPlugin(storage, PLUGIN),
      auth: createAuthContextStub(),
    };

    const body = 'Look at {{fm:x^2}} inline.';
    const result = await runPipeline(body, reg, ctx, loadDeps, { cache: storage, pageId: null });

    const para = result.tree.children[0] as { children: Array<{ type: string; value?: string }> };
    expect(para.children.some((c) => c.type === 'html')).toBe(false);
    expect(para.children.map((c) => c.value).join('')).toContain('{{fm:x^2}}');
  });

  it('coexists with the bundled core transforms (proper headings still get TOC entries)', async () => {
    const reg = new RendererRegistryImpl();
    registerFakeMath(reg);

    const body = ['# Title', '', 'inline {{fm:x}} math', '', 'See [[/foo]]'].join('\n');
    const storage = createMongoCacheStorage(crowi);
    const ctx: RenderContext = {
      mode: 'save',
      log: silentLogger,
      actor: { kind: 'system' },
      cache: scopeForPlugin(storage, PLUGIN),
      auth: createAuthContextStub(),
    };
    const { metadata } = await runPipeline(body, reg, ctx, loadDeps, { cache: storage, pageId: null });

    expect(metadata.toc.map((e) => e.text)).toEqual(['Title']);
    expect(metadata.wikiLinks.map((w) => w.target)).toEqual(['/foo']);
  });
});
