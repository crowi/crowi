import { Types } from 'mongoose';
import type { CodeBlockRenderer, PluginLogger, RenderActor } from '@crowi/plugin-api';
import type { RevisionMetaContent } from 'src/models/revision';
import type { PluginRenderCacheModel } from 'src/models/plugin-render-cache';
import { crowi } from 'src/test/setup';
import { RENDERER_PIPELINE_VERSION } from 'src/renderer/version';
import { computeRevisionRenderArtifactsAsync } from './page-response';

const TEST_ACTOR: RenderActor = { kind: 'system' };
const silentLogger: PluginLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * `computeRevisionRenderArtifactsAsync` — the read-path fallback that fills in
 * meta + renderedAst for revisions whose stored artifacts are absent or stale.
 *
 * Focus here is the version-mismatch RECOMPUTE branch (section C of the
 * TOC-rework fix): when the stored `renderedAst` is from an older pipeline
 * version, the read path re-renders the AST (heading ids slugged from the
 * STRIPPED heading text). The served `meta.toc` must track THAT recomputed AST
 * — not the stored, raw-derived toc — or a legacy `<font>` heading would ship
 * an `anchorId` that no longer matches any rendered heading `id` (broken TOC
 * jump / scroll-spy). The fresh (current-version) path must stay unchanged.
 */

// Pull the first heading's `hProperties.id` out of a recomputed mdast tree so
// we can assert the served toc anchorId equals the rendered heading id.
function firstHeadingId(ast: unknown): string | undefined {
  const root = ast as { children?: Array<{ type?: string; data?: { hProperties?: { id?: unknown } } }> };
  const heading = root.children?.find((c) => c.type === 'heading');
  const id = heading?.data?.hProperties?.id;
  return typeof id === 'string' ? id : undefined;
}

describe('computeRevisionRenderArtifactsAsync — toc tracks the AST it is served with (section C)', () => {
  // A pre-0.7.0 revision with an inline-HTML heading. The STORED toc carries
  // the legacy raw-derived anchorId (`workspace-の作成` is the stripped slug
  // today; the legacy one would have been derived differently / left raw). We
  // assert the SERVED toc matches the recomputed heading id regardless.
  const BODY = '### <font color="1a73e8">Workspace の作成</font>';

  // Complete Phase-2 meta (all 4 fields present) so only the AST is stale.
  const STORED_META: RevisionMetaContent = {
    toc: [{ level: 3, text: '<font color="1a73e8">Workspace の作成</font>', anchorId: 'stale-legacy-raw-anchor' }],
    wikiLinks: [],
    mentions: [],
    codeBlockLanguages: [],
  };

  // A stored AST blob whose heading id is the legacy raw-derived one — proves
  // we do NOT serve it on the stale path (we recompute instead).
  const STALE_STORED_AST = {
    type: 'root',
    children: [{ type: 'heading', depth: 3, data: { hProperties: { id: 'stale-legacy-raw-anchor' } }, children: [] }],
  };

  it('serves the recomputed toc whose anchorId matches the recomputed heading id (stale AST)', async () => {
    const result = await computeRevisionRenderArtifactsAsync(
      crowi,
      STORED_META,
      STALE_STORED_AST,
      BODY,
      TEST_ACTOR,
      '0.6.0', // older than RENDERER_PIPELINE_VERSION → recompute
    );

    // The AST is recomputed (not the stale stored one).
    const renderedHeadingId = firstHeadingId(result.renderedAst);
    expect(renderedHeadingId).toBeTruthy();
    expect(renderedHeadingId).not.toBe('stale-legacy-raw-anchor');

    // The served toc anchorId equals the recomputed heading id — the whole
    // point of the fix.
    expect(result.meta?.toc).toHaveLength(1);
    expect(result.meta?.toc?.[0].anchorId).toBe(renderedHeadingId);

    // Sanity: the recomputed anchor is the stripped slug, not the raw one.
    expect(result.meta?.toc?.[0].anchorId).toBe('workspace-の作成');
  });

  it('keeps stored-wins for the OTHER meta fields on the recompute path', async () => {
    const storedWithLinks: RevisionMetaContent = {
      toc: STORED_META.toc,
      wikiLinks: [{ raw: '/kept/link', target: '/kept/link' }],
      mentions: [],
      codeBlockLanguages: [],
    };
    const result = await computeRevisionRenderArtifactsAsync(crowi, storedWithLinks, STALE_STORED_AST, BODY, TEST_ACTOR, '0.6.0');
    // toc is recomputed, but the stored wikiLinks survive.
    expect(result.meta?.wikiLinks).toEqual([{ raw: '/kept/link', target: '/kept/link' }]);
    expect(result.meta?.toc?.[0].anchorId).toBe('workspace-の作成');
  });

  it('leaves the fresh (current-version) path byte-identical — stored toc + stored AST win', async () => {
    const result = await computeRevisionRenderArtifactsAsync(
      crowi,
      STORED_META,
      STALE_STORED_AST, // here it is the FRESH AST (version matches)
      BODY,
      TEST_ACTOR,
      RENDERER_PIPELINE_VERSION,
    );
    // Fresh path: the stored AST + stored toc are returned verbatim, no recompute.
    expect(result.renderedAst).toBe(STALE_STORED_AST);
    expect(result.meta?.toc).toBe(STORED_META.toc);
    expect(result.meta?.toc?.[0].anchorId).toBe('stale-legacy-raw-anchor');
  });

  it('treats a missing rendererVersion as fresh (trust the stored AST + toc)', async () => {
    const result = await computeRevisionRenderArtifactsAsync(crowi, STORED_META, STALE_STORED_AST, BODY, TEST_ACTOR /* no version */);
    expect(result.renderedAst).toBe(STALE_STORED_AST);
    expect(result.meta?.toc).toBe(STORED_META.toc);
  });
});

describe('computeRevisionRenderArtifactsAsync — mermaidRenderPending marker scan on the astIsFresh path (feature-plugin-renderer-mermaid spec §5)', () => {
  const COMPLETE_META: RevisionMetaContent = { toc: [], wikiLinks: [], mentions: [], codeBlockLanguages: [] };
  const PLUGIN = '@crowi/plugin-fixture-pending-scan';

  it('a stored AST with no mermaidRenderPending marker anywhere is returned as the exact same object (no clone, no redispatch attempted, full pipeline never re-run)', async () => {
    const pageId = new Types.ObjectId().toHexString();
    const storedAst = {
      type: 'root',
      children: [{ type: 'code', lang: 'mermaid', value: 'flowchart TD\n  A --> B' }], // no `data.mermaidRenderPending` — the vast majority case
    };
    // AC "マーカーの無い大多数のケースで runPipeline/runRender 相当が一切
    // 呼ばれないこと" — spy directly on the renderer's `runRender` (the
    // only full-pipeline entry point `computeRevisionRenderArtifactsAsync`
    // has access to) rather than relying on reference-identity alone.
    const runRenderSpy = jest.spyOn(crowi.getRenderer(), 'runRender');
    try {
      const result = await computeRevisionRenderArtifactsAsync(
        crowi,
        COMPLETE_META,
        storedAst,
        'body unused on the fresh path',
        TEST_ACTOR,
        RENDERER_PIPELINE_VERSION,
        pageId,
      );
      // Reference equality (not just deep equality) — proves the fast path
      // returned the input object untouched rather than cloning + walking
      // it (which `redispatchPendingCodeBlocks` would require).
      expect(result.renderedAst).toBe(storedAst);
      expect(runRenderSpy).not.toHaveBeenCalled();
    } finally {
      runRenderSpy.mockRestore();
    }
  });

  it('a stored AST WITH a mermaidRenderPending marker is resolved via a scoped redispatch, and the ORIGINAL stored object is left unmutated', async () => {
    const pageId = new Types.ObjectId().toHexString();
    const renderer: CodeBlockRenderer = {
      cacheVersion: 1,
      admissionControl: { maxConcurrentGlobal: 4, maxConcurrentPerUser: 2, queueDepth: 200 },
      render: (info) => ({ html: `<img alt="Mermaid diagram" src="data:image/svg+xml;base64,${Buffer.from(info.source).toString('base64')}">`, ttlSec: 3600 }),
    };
    crowi.getRenderer().registry.addCodeBlockRenderer('mermaid-pending-scan-fixture', renderer, PLUGIN, silentLogger);

    const storedAst = {
      type: 'root',
      children: [{ type: 'code', lang: 'mermaid-pending-scan-fixture', value: 'flowchart TD\n  A --> B', data: { mermaidRenderPending: true } }],
    };
    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    await PluginRenderCache.deleteMany({ pageId: new Types.ObjectId(pageId) }).exec();

    const result = await computeRevisionRenderArtifactsAsync(
      crowi,
      COMPLETE_META,
      storedAst,
      'body unused on the fresh path',
      TEST_ACTOR,
      RENDERER_PIPELINE_VERSION,
      pageId,
    );

    // The returned AST reflects the resolved node...
    const resultRoot = result.renderedAst as { children: Array<{ type: string; value?: string }> };
    expect(resultRoot.children[0].type).toBe('html');
    expect(resultRoot.children[0].value).toContain('<img');
    // ...but the ORIGINAL stored object (what `Revision.renderedAst`
    // still points at) was never mutated — spec §5: "Revision.renderedAst
    // 自体への書き戻しはしない".
    expect((storedAst.children[0] as { type: string }).type).toBe('code');
    expect((storedAst.children[0] as { data: { mermaidRenderPending: boolean } }).data.mermaidRenderPending).toBe(true);

    const doc = await PluginRenderCache.findOne({ pageId: new Types.ObjectId(pageId) })
      .lean()
      .exec();
    expect(doc).toBeTruthy();
  });

  it('a stored AST whose code node has no marker at all (pre-Mermaid-activation content) is left completely untouched', async () => {
    const pageId = new Types.ObjectId().toHexString();
    const storedAst = { type: 'root', children: [{ type: 'code', lang: 'some-other-lang', value: 'plain code, never touched by this feature' }] };
    const result = await computeRevisionRenderArtifactsAsync(
      crowi,
      COMPLETE_META,
      storedAst,
      'body unused on the fresh path',
      TEST_ACTOR,
      RENDERER_PIPELINE_VERSION,
      pageId,
    );
    expect(result.renderedAst).toBe(storedAst);
    expect((result.renderedAst as { children: Array<{ type: string }> }).children[0].type).toBe('code');
  });

  // feature-plugin-renderer-mermaid Phase 3 (spec §9): the PlantUML
  // sanitizer swap + output class rename (`plantuml-embed` →
  // `diagram-embed plantuml-embed`) bumped ONLY the plugin's own
  // `cacheVersion` (a `PluginRenderCache`-lookup-only escape hatch) —
  // `RENDERER_PIPELINE_VERSION` (this file's own `version` argument) was
  // deliberately left untouched. A `Revision.renderedAst` written before
  // this Phase therefore still embeds the OLD sanitizer's HTML string
  // (old class, old regex-stripped output) verbatim; nothing re-renders
  // it until the page is next saved. This pins that specific regression
  // scenario, though the underlying mechanism (astIsFresh ⇒ verbatim
  // stored-AST passthrough, no pipeline re-run) is already exercised
  // generically above and in the `mermaidRenderPending` describe block.
  it('a stored AST embedding legacy pre-Phase-3 PlantUML output (old sanitizer, old `plantuml-embed`-only class) is served byte-identical and never re-rendered', async () => {
    const pageId = new Types.ObjectId().toHexString();
    const legacyPlantumlHtml = '<div class="plantuml-embed"><svg><path d="M0 0 L1 1"/></svg></div>';
    const storedAst = { type: 'root', children: [{ type: 'html', value: legacyPlantumlHtml }] };
    const runRenderSpy = jest.spyOn(crowi.getRenderer(), 'runRender');
    try {
      const result = await computeRevisionRenderArtifactsAsync(
        crowi,
        COMPLETE_META,
        storedAst,
        'body unused on the fresh path',
        TEST_ACTOR,
        RENDERER_PIPELINE_VERSION, // unchanged by Phase 3 — this stays the "fresh" path
        pageId,
      );
      expect(result.renderedAst).toBe(storedAst);
      expect((result.renderedAst as { children: Array<{ value: string }> }).children[0].value).toBe(legacyPlantumlHtml);
      expect(runRenderSpy).not.toHaveBeenCalled();
    } finally {
      runRenderSpy.mockRestore();
    }
  });
});
