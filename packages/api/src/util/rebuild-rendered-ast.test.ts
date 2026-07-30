import { Types } from 'mongoose';
import { createRebuildCliApi } from 'src/migration/rebuild-api';
import type { RevisionModel } from 'src/models/revision';
import { RENDERER_PIPELINE_VERSION } from 'src/renderer/version';
import { crowi } from 'src/test/setup';
import { createPageViaApi, createTestUser } from 'src/test/test-helpers';

/**
 * RFC-0023 §15 — `rebuild rendered-ast`: unified eligibility predicate,
 * monotonic version-guard CAS, meta co-update, dry-run, completion
 * semantics (newer-version rows never block), and save-path output
 * fidelity (`mode: 'save'` + system actor + owning pageId).
 */

const BODY = ['# Backfill Heading', '', 'Hello @nosuchmentioneduser and text.', '', '```ts', 'const x = 1;', '```'].join('\n');

const Revision = () => crowi.model('Revision') as unknown as RevisionModel;

interface LeanRevision {
  _id: Types.ObjectId;
  rendererVersion?: string;
  renderedAst?: unknown;
  meta?: { toc?: Array<{ anchorId: string }> };
}

const readRevision = async (id: string): Promise<LeanRevision> => {
  const doc = (await Revision().findById(id).select('rendererVersion renderedAst meta').lean().exec()) as LeanRevision | null;
  if (!doc) throw new Error(`revision ${id} vanished`);
  return doc;
};

describe('rebuild rendered-ast (RFC-0023 §15)', () => {
  let accessToken: string;
  let stalePageRevisionId: string;
  let stalePageId: string;
  let newerRevisionId: string;

  beforeAll(async () => {
    const { accessToken: token } = await createTestUser({ name: 'Backfill', username: 'backfillUser', email: 'backfill@example.com' });
    accessToken = token;

    // A page whose current revision we downgrade to "no rendererVersion"
    // (the pre-RFC legacy cohort) with a stale AST + stale toc.
    const stale = await createPageViaApi(accessToken, '/backfill/stale', BODY);
    stalePageId = stale._id;
    const Page = crowi.model('Page');
    const stalePage = await Page.findById(stalePageId).exec();
    stalePageRevisionId = String(stalePage?.revision);
    await Revision()
      .updateOne(
        { _id: stalePageRevisionId },
        {
          $unset: { rendererVersion: '' },
          $set: {
            renderedAst: { type: 'root', children: [{ type: 'html', value: '<p>legacy artifact</p>' }] },
            meta: { toc: [{ level: 1, text: 'Backfill Heading', anchorId: 'stale-anchor' }], wikiLinks: [], mentions: [], codeBlockLanguages: [] },
          },
        },
      )
      .exec();

    // A page whose current revision claims a NEWER pipeline version than
    // this binary — must never be touched and must never block completion.
    const newer = await createPageViaApi(accessToken, '/backfill/newer', '# Newer');
    const newerPage = await Page.findById(newer._id).exec();
    newerRevisionId = String(newerPage?.revision);
    await Revision()
      .updateOne({ _id: newerRevisionId }, { $set: { rendererVersion: '99.0.0' } })
      .exec();
  });

  it('dry-run counts eligible rows without writing anything', async () => {
    const api = createRebuildCliApi(crowi);
    const outcome = await api.rebuildRenderedAst({ dryRun: true });
    const stats = outcome.stats as { eligible: number; written: number; dryRun: boolean };
    expect(stats.dryRun).toBe(true);
    expect(stats.eligible).toBeGreaterThanOrEqual(1);
    expect(stats.written).toBe(0);
    const untouched = await readRevision(stalePageRevisionId);
    expect(untouched.rendererVersion).toBeUndefined();
    expect((untouched.renderedAst as { children: Array<{ value?: string }> }).children[0].value).toBe('<p>legacy artifact</p>');
  });

  it('real run: backfills AST + rendererVersion + meta in one $set; newer-version rows are skipped by the monotonic guard; completion reaches 0 eligible', async () => {
    const api = createRebuildCliApi(crowi);
    const outcome = await api.rebuildRenderedAst({});
    const stats = outcome.stats as { written: number; remainingEligible: number; targetVersion: string };
    expect(stats.targetVersion).toBe(RENDERER_PIPELINE_VERSION);
    expect(stats.written).toBeGreaterThanOrEqual(1);
    // Completion: the unified predicate reports 0 remaining even though
    // the newer-version row still sits in the $ne prefilter scan.
    expect(stats.remainingEligible).toBe(0);

    const rebuilt = await readRevision(stalePageRevisionId);
    expect(rebuilt.rendererVersion).toBe(RENDERER_PIPELINE_VERSION);
    const children = (rebuilt.renderedAst as { children: Array<{ type: string; data?: { hProperties?: { id?: string } } }> }).children;
    const heading = children.find((c) => c.type === 'heading');
    expect(heading?.data?.hProperties?.id).toBe('backfill-heading');
    // meta co-update: the served toc now matches the rebuilt AST's
    // heading ids (the stale anchor is gone).
    expect(rebuilt.meta?.toc?.[0]?.anchorId).toBe('backfill-heading');

    // Monotonic guard: the newer row was NOT downgraded.
    const newer = await readRevision(newerRevisionId);
    expect(newer.rendererVersion).toBe('99.0.0');
  });

  it('output fidelity: the backfilled AST equals a save-path render (mode: save + system actor + owning pageId) of the same body', async () => {
    const rebuilt = await readRevision(stalePageRevisionId);
    const { renderedAst } = await crowi.getRenderer().runRender(BODY, {
      mode: 'save',
      pageId: stalePageId,
      actor: { kind: 'system' },
    });
    expect(JSON.stringify(rebuilt.renderedAst)).toBe(JSON.stringify(renderedAst));
  });

  it('idempotence: an immediate re-run finds nothing eligible', async () => {
    const api = createRebuildCliApi(crowi);
    const outcome = await api.rebuildRenderedAst({});
    const stats = outcome.stats as { eligible: number; written: number; remainingEligible: number };
    expect(stats.eligible).toBe(0);
    expect(stats.written).toBe(0);
    expect(stats.remainingEligible).toBe(0);
  });
});
