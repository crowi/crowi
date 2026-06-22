import type { RevisionMetaContent } from 'src/models/revision';
import { crowi } from 'src/test/setup';
import { RENDERER_PIPELINE_VERSION } from 'src/renderer/version';
import { computeRevisionRenderArtifactsAsync } from './page-response';

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
    const result = await computeRevisionRenderArtifactsAsync(crowi, storedWithLinks, STALE_STORED_AST, BODY, '0.6.0');
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
      RENDERER_PIPELINE_VERSION,
    );
    // Fresh path: the stored AST + stored toc are returned verbatim, no recompute.
    expect(result.renderedAst).toBe(STALE_STORED_AST);
    expect(result.meta?.toc).toBe(STORED_META.toc);
    expect(result.meta?.toc?.[0].anchorId).toBe('stale-legacy-raw-anchor');
  });

  it('treats a missing rendererVersion as fresh (trust the stored AST + toc)', async () => {
    const result = await computeRevisionRenderArtifactsAsync(crowi, STORED_META, STALE_STORED_AST, BODY /* no version */);
    expect(result.renderedAst).toBe(STALE_STORED_AST);
    expect(result.meta?.toc).toBe(STORED_META.toc);
  });
});
