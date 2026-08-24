import type { CodeBlockRenderer, PluginLogger, RenderActor } from '@crowi/plugin-api';
import { Types } from 'mongoose';
import type { PluginRenderCacheModel } from 'src/models/plugin-render-cache';
import type { RevisionMetaContent } from 'src/models/revision';
import { renderFallbackCard } from 'src/renderer/core/link-card/render-card';
import { RENDERER_PIPELINE_VERSION } from 'src/renderer/version';
import { crowi } from 'src/test/setup';
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

  it('treats a missing rendererVersion as STALE (RFC-0023 §13 — the missing-version special case is removed; rebuild rendered-ast backfills)', async () => {
    const result = await computeRevisionRenderArtifactsAsync(crowi, STORED_META, STALE_STORED_AST, BODY, TEST_ACTOR /* no version */);
    // Stale path: the AST is recomputed on the fly, NOT served verbatim.
    expect(result.renderedAst).not.toBe(STALE_STORED_AST);
    // ...and the toc comes from the recompute too (toc tracks the AST source).
    expect(result.meta?.toc?.[0]?.anchorId).not.toBe('stale-legacy-raw-anchor');
  });
});

// feature-backlink-raw-space-metadata — the spec explicitly calls out that
// the "meta を持たない古い revision" on-the-fly fallback (revision.ts's
// `meta?: RevisionMetaContent`) must also populate the new field, not just
// the save-time path already covered in revision.test.ts.
describe('computeRevisionRenderArtifactsAsync — rawSpaceLinks on the fully-legacy fallback path (feature-backlink-raw-space-metadata)', () => {
  it('a revision with NO stored meta at all still gets rawSpaceLinks filled in via the on-the-fly recompute', async () => {
    const result = await computeRevisionRenderArtifactsAsync(
      crowi,
      undefined, // pre-Phase-2 revision: no stored meta whatsoever
      undefined, // and no stored renderedAst either
      '[label](/legacy raw space doc)',
      TEST_ACTOR,
    );
    expect(result.meta?.rawSpaceLinks).toEqual(['/legacy raw space doc']);
  });

  it('stored meta that predates this field (no rawSpaceLinks key) still counts as "complete" — no forced recompute', async () => {
    // `metaIsComplete` intentionally does NOT gate on `rawSpaceLinks` (see
    // that constant's comment in page-response.ts) — otherwise every
    // pre-existing revision would be forced through an on-the-fly
    // recompute on its very next read.
    const preExistingMeta: RevisionMetaContent = { toc: [], wikiLinks: [], mentions: [], codeBlockLanguages: [] };
    const freshAst = { type: 'root', children: [] };
    const runRenderSpy = jest.spyOn(crowi.getRenderer(), 'runRender');
    try {
      const result = await computeRevisionRenderArtifactsAsync(
        crowi,
        preExistingMeta,
        freshAst,
        '[label](/should not be recomputed)',
        TEST_ACTOR,
        RENDERER_PIPELINE_VERSION,
      );
      expect(runRenderSpy).not.toHaveBeenCalled();
      expect(result.renderedAst).toBe(freshAst);
      expect(result.meta?.rawSpaceLinks).toBeUndefined();
    } finally {
      runRenderSpy.mockRestore();
    }
  });
});

describe('computeRevisionRenderArtifactsAsync — renderPending marker scan on the astIsFresh path (feature-plugin-renderer-mermaid spec §5)', () => {
  const COMPLETE_META: RevisionMetaContent = { toc: [], wikiLinks: [], mentions: [], codeBlockLanguages: [] };
  const PLUGIN = '@crowi/plugin-fixture-pending-scan';

  it('a stored AST with no renderPending marker anywhere is returned as the exact same object (no clone, no redispatch attempted, full pipeline never re-run)', async () => {
    const pageId = new Types.ObjectId().toHexString();
    const storedAst = {
      type: 'root',
      children: [{ type: 'code', lang: 'mermaid', value: 'flowchart TD\n  A --> B' }], // no `data.renderPending` — the vast majority case
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

  it('a stored AST WITH a renderPending marker is resolved via a scoped redispatch, and the ORIGINAL stored object is left unmutated', async () => {
    const pageId = new Types.ObjectId().toHexString();
    const renderer: CodeBlockRenderer = {
      cacheVersion: 1,
      admissionControl: { maxConcurrentGlobal: 4, maxConcurrentPerUser: 2, queueDepth: 200 },
      render: (info) => ({ html: `<img alt="Mermaid diagram" src="data:image/svg+xml;base64,${Buffer.from(info.source).toString('base64')}">`, ttlSec: 3600 }),
    };
    crowi.getRenderer().registry.addCodeBlockRenderer('mermaid-pending-scan-fixture', renderer, PLUGIN, silentLogger);

    const storedAst = {
      type: 'root',
      children: [{ type: 'code', lang: 'mermaid-pending-scan-fixture', value: 'flowchart TD\n  A --> B', data: { renderPending: true } }],
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
    expect((storedAst.children[0] as { data: { renderPending: boolean } }).data.renderPending).toBe(true);

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
  // generically above and in the `renderPending` describe block.
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

  // feature-plugin-renderer-mermaid Phase 4 (spec §9/§10): wiring
  // @crowi/plugin-renderer-mermaid into apps/crowi-runner activates the
  // plugin for NEW code-block-dispatch calls from the moment this Phase
  // deploys — that change deliberately left `RENDERER_PIPELINE_VERSION`
  // untouched (a plain, new-bundled-plugin addition would ordinarily
  // warrant a "minor" bump per this constant's own doc comment in
  // version.ts, but spec §9 explicitly carved out an exception for
  // Mermaid/PlantUML specifically to avoid a version-bump-driven
  // recompute of every unrelated revision on next read).
  // feature-renderer-plugin-boundary Phase 3 DOES bump it (0.8.0 ->
  // 0.9.0): emoji becoming a hard-coded core pipeline transform and
  // link-card becoming a core-reserved embed tag are exactly the
  // "new bundled transform/plugin" category `version.ts`'s policy
  // comment defines as a minor bump — no carve-out applies to them.
  // feature-page-link-space-paths Phase 2 bumps it again (0.9.0 ->
  // 0.10.0): the new raw-space-link recovery transform
  // (`renderer/core/raw-space-links.ts`) is likewise a new bundled
  // transform added to `buildCorePlugins`.
  // RFC-0023 bumps it to 1.0.0 (MAJOR): producers now stamp typed
  // sidecars onto their `html` nodes, and pre-1.0 stored ASTs — which
  // lack them — must be invalidated wholesale so `rebuild rendered-ast`
  // (util/rebuild-rendered-ast.ts) re-renders every current revision.
  // feature-renderer-frontmatter bumps it again (1.0.0 -> 1.1.0): the
  // new `core/frontmatter.ts` transform (`makeFrontmatterPlugin`) is a
  // new-bundled-transform minor bump per this constant's own policy —
  // same rollout as every bump since 1.0.0 (RFC-0023 removed the
  // missing-version freshness special case), so a stored AST with an
  // older `rendererVersion` recomputes per read rather than staying a
  // `thematicBreak` + paragraph until saved.
  // GitHub Alerts bumps it again (1.1.0 -> 1.2.0) for the same reason:
  // `core/github-alerts.ts`'s `makeGithubAlertsPlugin` is another new
  // bundled transform, and its rendering likewise arrives on next read
  // rather than next save.
  // feature-renderer-break-normalization bumps it again (1.2.0 -> 1.3.0):
  // `core/break-normalization.ts`'s `remarkNormalizeHtmlBreaks` is another
  // new bundled transform (a bare `<br>` `html` node in an uncontaminated
  // paragraph/heading/tableCell phrasing subtree becomes a canonical
  // `break`), and its rendering likewise arrives on next read rather than
  // next save.
  // Pinned here so an accidental future bump/no-bump alongside an
  // unrelated change is caught immediately.
  it('RENDERER_PIPELINE_VERSION is 1.3.0 (new bundled transform, minor bump)', () => {
    expect(RENDERER_PIPELINE_VERSION).toBe('1.3.0');
  });

  // The concrete read-path half of that bump: a revision saved by a
  // 1.1.0 process holds an ordinary `blockquote` AST, and the first read
  // served by a 1.2.0 process must hand back the recomputed alert
  // without touching either the stored AST object or the document
  // behind it.
  it('recomputes a 1.1.0-stored ordinary blockquote into a crowiAlert on read, leaving the stored AST object untouched', async () => {
    const alertBody = '> [!NOTE]\n> body\n';
    const storedAst = {
      type: 'root',
      children: [{ type: 'blockquote', children: [{ type: 'paragraph', children: [{ type: 'text', value: '[!NOTE]' }] }] }],
    };
    const before = structuredClone(storedAst);

    const result = await computeRevisionRenderArtifactsAsync(crowi, undefined, storedAst, alertBody, TEST_ACTOR, '1.1.0');

    const recomputed = result.renderedAst as { children: Array<{ type: string; variant?: string }> };
    expect(recomputed).not.toBe(storedAst);
    expect(recomputed.children[0].type).toBe('crowiAlert');
    expect(recomputed.children[0].variant).toBe('note');
    // The read path is a pure projection: no in-place upgrade of the
    // caller's stored blob (and, one level up, no DB write-back).
    expect(storedAst).toEqual(before);
  });

  // The concrete read-path half of the 1.2.0 -> 1.3.0 bump: a revision
  // saved by a 1.2.0 process holds a bare `html("<br>")` node, and the
  // first read served by a 1.3.0 process must hand back the recomputed
  // `break` without touching either the stored AST object or the
  // document behind it.
  it('recomputes a 1.2.0-stored bare `html("<br>")` table cell into `break` on read, leaving the stored AST object untouched', async () => {
    const tableBody = '| h |\n| --- |\n| a<br>b |\n';
    const storedAst = {
      type: 'root',
      children: [
        {
          type: 'table',
          align: [null],
          children: [
            { type: 'tableRow', children: [{ type: 'tableCell', children: [{ type: 'text', value: 'h' }] }] },
            {
              type: 'tableRow',
              children: [
                {
                  type: 'tableCell',
                  children: [
                    { type: 'text', value: 'a' },
                    { type: 'html', value: '<br>' },
                    { type: 'text', value: 'b' },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const before = structuredClone(storedAst);

    const result = await computeRevisionRenderArtifactsAsync(crowi, undefined, storedAst, tableBody, TEST_ACTOR, '1.2.0');

    const recomputed = result.renderedAst as { children: Array<{ children: Array<{ children: Array<{ type: string }> }> }> };
    expect(recomputed).not.toBe(storedAst);
    const cell = recomputed.children[0].children[1].children[0] as unknown as { children: Array<{ type: string }> };
    expect(cell.children.map((c) => c.type)).toEqual(['text', 'break', 'text']);
    // The read path is a pure projection: no in-place upgrade of the
    // caller's stored blob (and, one level up, no DB write-back).
    expect(storedAst).toEqual(before);
  });

  // Registers a diagram-shaped CodeBlockRenderer (feature-renderer-plugin-
  // boundary Phase 2 §1/§4 — converted off the real
  // `@crowi/plugin-renderer-mermaid` import onto a local fake with the
  // same registration SHAPE `apps/crowi-runner`'s boot sequence uses via
  // registerRenderer, spec §10) into the SAME registry
  // computeRevisionRenderArtifactsAsync reads from
  // (crowi.getRenderer().registry), then proves that a Revision saved
  // BEFORE this Phase (no CodeBlockRenderer existed for 'mermaid' yet, so
  // the fenced block is still a raw, un-dispatched `code` node with no
  // `renderPending` marker) is served byte-identical on the fresh
  // (matching-version) path — still a plain code block, never dispatched
  // to the now-live renderer — until the author explicitly re-saves the
  // page. This is strictly stronger than the generic
  // no-marker-untouched test earlier in this describe block: that test
  // has NO 'mermaid' renderer registered at all, so it cannot show that
  // the renderer's mere presence in a live registry doesn't retroactively
  // reprocess old content.
  it('registering a diagram CodeBlockRenderer (post-Phase-4 wiring) does not retroactively touch a pre-existing, un-dispatched ```mermaid code node — it stays a plain code block until re-saved', async () => {
    const pageId = new Types.ObjectId().toHexString();
    const renderer: CodeBlockRenderer = {
      cacheVersion: 2,
      admissionControl: { maxConcurrentGlobal: 4, maxConcurrentPerUser: 2, queueDepth: 200 },
      render: (info) => ({
        html: `<img class="diagram-embed mermaid-embed" data-crowi-renderer-presentation="diagram" data-crowi-renderer-state="ready" alt="Mermaid diagram" src="data:image/svg+xml;base64,${Buffer.from(info.source).toString('base64')}">`,
        ttlSec: 3600,
      }),
    };
    crowi.getRenderer().registry.addCodeBlockRenderer('mermaid', renderer, '@crowi/plugin-renderer-mermaid', silentLogger);

    const storedAst = {
      type: 'root',
      children: [{ type: 'code', lang: 'mermaid', value: 'flowchart TD\n  A --> B' }], // pre-Phase-4 content — never dispatched, no marker
    };
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
      expect(result.renderedAst).toBe(storedAst);
      const codeNode = (result.renderedAst as { children: Array<{ type: string; lang?: string }> }).children[0];
      expect(codeNode.type).toBe('code');
      expect(codeNode.lang).toBe('mermaid');
      expect(runRenderSpy).not.toHaveBeenCalled();
    } finally {
      runRenderSpy.mockRestore();
    }
  });
});

/**
 * feature-renderer-plugin-boundary Phase 3 spec §6.2/AC5/AC7 — "toggle
 * flips never retroactively rewrite a stored AST; a fully-resolved
 * current-version artifact returns verbatim". `security:linkCardEnabled`
 * is read live only inside the `card` `EmbedRenderer.render()` call
 * (`core/link-card/index.ts`), which the fresh (`astIsFresh &&
 * metaIsComplete`) read path never reaches at all — proven here the
 * same way the sibling Mermaid describe block above proves the
 * analogous code-block-dispatch claim: `runRender` (the ONLY entry
 * point that could re-dispatch an embed) is spied and asserted
 * un-called, and the returned AST is the exact same object reference
 * (not a clone / not re-serialized).
 */
describe('link-card toggle does not affect the stored renderedAst display contract (feature-renderer-plugin-boundary Phase 3 spec §6.2/AC5/AC7)', () => {
  const COMPLETE_META: RevisionMetaContent = { toc: [], wikiLinks: [], mentions: [], codeBlockLanguages: [] };
  const STORED_LINK_CARD_AST = {
    type: 'root',
    children: [
      {
        type: 'paragraph',
        children: [
          {
            type: 'html',
            value:
              '<figure class="crowi-link-card"><a class="crowi-link-card-link" href="https://example.test/x" target="_blank" rel="noopener noreferrer"><div class="crowi-link-card-body"><div class="crowi-link-card-title">Example</div></div></a></figure>',
          },
        ],
      },
    ],
  };

  afterEach(async () => {
    // Restore the default (a missing row already reads as enabled) so
    // this file doesn't leak a `false` value into a later test/file
    // sharing the same in-process Config cache.
    await crowi.model('Config').deleteMany({ ns: 'crowi', key: 'security:linkCardEnabled' }).exec();
    await crowi.getConfigService().load();
  });

  it.each([
    ['disabled (toggle flipped true -> false since the AST was saved)', false],
    ['enabled (toggle stayed true)', true],
  ])('a fully-resolved, current-version stored AST containing a rendered link card is returned VERBATIM — %s', async (_label, linkCardEnabled) => {
    await crowi.getConfigService().saveConfig('crowi', { 'security:linkCardEnabled': linkCardEnabled });

    const runRenderSpy = jest.spyOn(crowi.getRenderer(), 'runRender');
    try {
      const result = await computeRevisionRenderArtifactsAsync(
        crowi,
        COMPLETE_META,
        STORED_LINK_CARD_AST,
        'body unused on the fresh path',
        TEST_ACTOR,
        RENDERER_PIPELINE_VERSION,
      );
      // Verbatim: same object reference, no re-render / re-dispatch.
      expect(result.renderedAst).toBe(STORED_LINK_CARD_AST);
      expect(runRenderSpy).not.toHaveBeenCalled();
    } finally {
      runRenderSpy.mockRestore();
    }
  });

  // The AC7 case the sibling `it.each` above does NOT cover: a stored AST
  // that already shows the unified fallback card (i.e. it was saved while
  // the toggle read `false`, or the original OGP fetch failed) must stay
  // the fallback card verbatim even after the toggle flips back to `true`
  // — reading a page must never retroactively "upgrade" a stored fallback
  // into a fresh OGP fetch. Uses the real `renderFallbackCard()` builder
  // (not a hand-typed literal) so this test tracks the actual HTML shape.
  const STORED_FALLBACK_LINK_CARD_AST = {
    type: 'root',
    children: [
      {
        type: 'paragraph',
        children: [
          {
            type: 'html',
            value: renderFallbackCard('https://example.test/unreachable'),
          },
        ],
      },
    ],
  };

  it.each([
    ['stayed disabled (toggle stayed false)', false],
    ['flipped false -> true since the AST was saved', true],
  ])('a fully-resolved, current-version stored AST containing the unified FALLBACK card is returned VERBATIM — %s', async (_label, linkCardEnabled) => {
    await crowi.getConfigService().saveConfig('crowi', { 'security:linkCardEnabled': linkCardEnabled });

    const runRenderSpy = jest.spyOn(crowi.getRenderer(), 'runRender');
    try {
      const result = await computeRevisionRenderArtifactsAsync(
        crowi,
        COMPLETE_META,
        STORED_FALLBACK_LINK_CARD_AST,
        'body unused on the fresh path',
        TEST_ACTOR,
        RENDERER_PIPELINE_VERSION,
      );
      // Verbatim: same object reference, no re-render / re-dispatch (in
      // particular, no fresh OGP fetch attempt even when the toggle now
      // reads enabled).
      expect(result.renderedAst).toBe(STORED_FALLBACK_LINK_CARD_AST);
      expect(runRenderSpy).not.toHaveBeenCalled();
    } finally {
      runRenderSpy.mockRestore();
    }
  });
});

/**
 * RFC-0023 §14 — `renderedAstArtifactKey`: the identity of the AST
 * artifact a single response serves. Stable (`RENDERER_PIPELINE_VERSION`)
 * for a verbatim stored AST; a per-response nonce whenever the served
 * tree can differ from the stored one (pending-marker retry resolving,
 * freshness-mismatch on-the-fly recompute). The web render memo keys on
 * `[revisionId, renderedAstArtifactKey]`.
 */
describe('computeRevisionRenderArtifactsAsync — renderedAstArtifactKey (RFC-0023 §14)', () => {
  const COMPLETE_META: RevisionMetaContent = { toc: [], wikiLinks: [], mentions: [], codeBlockLanguages: [] };

  it('(a)(d) fresh verbatim: equals RENDERER_PIPELINE_VERSION and is stable across repeated reads (react-query refetches never re-render)', async () => {
    const storedAst = { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', value: 'stable' }] }] };
    const first = await computeRevisionRenderArtifactsAsync(crowi, COMPLETE_META, storedAst, 'unused', TEST_ACTOR, RENDERER_PIPELINE_VERSION);
    const second = await computeRevisionRenderArtifactsAsync(crowi, COMPLETE_META, storedAst, 'unused', TEST_ACTOR, RENDERER_PIPELINE_VERSION);
    expect(first.renderedAstArtifactKey).toBe(RENDERER_PIPELINE_VERSION);
    expect(second.renderedAstArtifactKey).toBe(RENDERER_PIPELINE_VERSION);
  });

  it('(b) a pending-marker retry that changes the tree yields a fresh nonce per response', async () => {
    const pageId = new Types.ObjectId().toHexString();
    const renderer: CodeBlockRenderer = {
      cacheVersion: 1,
      admissionControl: { maxConcurrentGlobal: 4, maxConcurrentPerUser: 2, queueDepth: 200 },
      render: () => ({ html: '<div class="resolved-artifact"></div>', ttlSec: 3600 }),
    };
    crowi.getRenderer().registry.addCodeBlockRenderer('artifactlang', renderer, '@crowi/test-artifact-plugin', silentLogger);

    const buildStored = () => ({
      type: 'root',
      children: [{ type: 'code', lang: 'artifactlang', value: 'x', data: { renderPending: true } }],
    });
    const first = await computeRevisionRenderArtifactsAsync(crowi, COMPLETE_META, buildStored(), 'unused', TEST_ACTOR, RENDERER_PIPELINE_VERSION, pageId);
    // The retry succeeded (renderer registered + healthy) — the served
    // tree differs from the stored one, so the key must be a nonce.
    const servedHtml = (first.renderedAst as { children: Array<{ type: string }> }).children[0];
    expect(servedHtml.type).toBe('html');
    expect(first.renderedAstArtifactKey).not.toBe(RENDERER_PIPELINE_VERSION);
    const second = await computeRevisionRenderArtifactsAsync(crowi, COMPLETE_META, buildStored(), 'unused', TEST_ACTOR, RENDERER_PIPELINE_VERSION, pageId);
    expect(second.renderedAstArtifactKey).not.toBe(first.renderedAstArtifactKey);
  });

  it('(c) a freshness-mismatch recompute (no pending marker anywhere) yields a fresh nonce per response', async () => {
    const staleAst = { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', value: 'old' }] }] };
    const first = await computeRevisionRenderArtifactsAsync(crowi, COMPLETE_META, staleAst, '# recompute me', TEST_ACTOR, '0.6.0');
    const second = await computeRevisionRenderArtifactsAsync(crowi, COMPLETE_META, staleAst, '# recompute me', TEST_ACTOR, '0.6.0');
    expect(first.renderedAstArtifactKey).toBeDefined();
    expect(first.renderedAstArtifactKey).not.toBe(RENDERER_PIPELINE_VERSION);
    expect(second.renderedAstArtifactKey).not.toBe(first.renderedAstArtifactKey);
  });

  it('no AST at all (empty body, nothing stored) → no key', async () => {
    const result = await computeRevisionRenderArtifactsAsync(crowi, COMPLETE_META, undefined, '', TEST_ACTOR);
    expect(result.renderedAst).toBeUndefined();
    expect(result.renderedAstArtifactKey).toBeUndefined();
  });
});
