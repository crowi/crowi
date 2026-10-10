import mongoose from 'mongoose';
import * as Y from 'yjs';
import type { CollabModels } from '../models';
import { persistYjsState } from '../persist-yjs-state';
import { CONTENT_FIELD } from '../yjs-doc';
import { registerTestModels, type SmokeMongo, startInMemoryMongo } from './setup';

/**
 * RFC-0017 Phase 1 §4.2/AC-16 — `persistYjsState`'s epoch + deleted-status
 * CAS. Zero-match on the `updateOne` filter is treated as "do not
 * persist" — same no-data-loss policy as an anti-shrink reject.
 */
describe('persistYjsState — RFC-0017 Phase 1 epoch/status CAS', () => {
  let memMongo: SmokeMongo;
  let models: CollabModels;
  let warnSpy: jest.SpyInstance;

  beforeAll(async () => {
    memMongo = await startInMemoryMongo();
    const reg = registerTestModels();
    models = reg.models;
  });

  afterAll(async () => {
    await memMongo.stop();
  });

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Page = () => models.Page as any;
  const persistModels = () => ({ Page: models.Page, Revision: models.Revision });

  const seedPage = async (overrides: Record<string, unknown> = {}) => {
    const page = await Page().create({
      path: `/__persist-epoch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      creator: new mongoose.Types.ObjectId(),
      grant: 1,
      status: 'published',
      ...overrides,
    });
    return page._id.toString();
  };

  const makeDoc = (text: string): Y.Doc => {
    const doc = new Y.Doc();
    doc.getText(CONTENT_FIELD).insert(0, text);
    return doc;
  };

  test('AC-16: a matching expectedEpoch persists normally', async () => {
    const pageId = await seedPage({ collabLifecycleVersion: 2 });
    const result = await persistYjsState(persistModels(), { pageId, document: makeDoc('hello'), baselineBody: null, origin: 'save', expectedEpoch: 2 });
    expect(result.ok).toBe(true);

    const page = await Page().findById(pageId).exec();
    expect(page.yjsState).toBeTruthy();
  });

  test('AC-16: a stale expectedEpoch (page transitioned since load) rejects — zero-match is treated as "do not persist"', async () => {
    const pageId = await seedPage({ collabLifecycleVersion: 3 });
    // expectedEpoch (1) is stale — the page has already moved to epoch 3.
    const result = await persistYjsState(persistModels(), { pageId, document: makeDoc('stale write'), baselineBody: null, origin: 'save', expectedEpoch: 1 });
    expect(result).toEqual({ ok: false, reason: 'epoch-mismatch' });

    const page = await Page().findById(pageId).exec();
    expect(page.yjsState ?? null).toBeNull();
  });

  const seedPageWithRevisionKind = async (revisionKind: string | undefined, pageOverrides: Record<string, unknown> = {}) => {
    const revision = await models.Revision.collection.insertOne({
      path: '/persist-kind',
      body: 'body',
      format: 'markdown',
      author: new mongoose.Types.ObjectId(),
      createdAt: new Date(),
      ...(revisionKind === undefined ? {} : { contentType: revisionKind }),
    });
    const pageId = await seedPage({ revision: revision.insertedId, currentRevision: revision.insertedId, ...pageOverrides });
    return { pageId, revisionId: revision.insertedId };
  };

  test('AC-06: every origin refuses an artifact Revision even when the Page hint says markdown, before anything is encoded', async () => {
    const { pageId } = await seedPageWithRevisionKind('artifact', { contentType: 'markdown' });
    // The doc is never even inspected (anti-shrink / encode run after the kind check).
    const doc = makeDoc('x');
    const getText = jest.spyOn(doc, 'getText');
    for (const origin of ['save', 'store-only', 'full-merge'] as const) {
      const result = await persistYjsState(persistModels(), { pageId, document: doc, baselineBody: null, origin, expectedEpoch: 0 });
      expect(result).toEqual({ ok: false, reason: 'content-type' });
    }
    expect(getText).not.toHaveBeenCalled();
    expect((await Page().findById(pageId).exec()).yjsState ?? null).toBeNull();
  });

  test('AC-06: a currentRevision that points at an artifact Revision is refused too, and a dangling pointer fails closed', async () => {
    const artifact = await seedPageWithRevisionKind('artifact');
    const md = await seedPageWithRevisionKind('markdown');
    await Page()
      .updateOne({ _id: md.pageId }, { $set: { currentRevision: artifact.revisionId } })
      .exec();
    expect(await persistYjsState(persistModels(), { pageId: md.pageId, document: makeDoc('x'), baselineBody: null, origin: 'save' })).toEqual({
      ok: false,
      reason: 'content-type',
    });

    await Page()
      .updateOne({ _id: md.pageId }, { $set: { currentRevision: new mongoose.Types.ObjectId() } })
      .exec();
    expect(await persistYjsState(persistModels(), { pageId: md.pageId, document: makeDoc('x'), baselineBody: null, origin: 'save' })).toEqual({
      ok: false,
      reason: 'content-type',
    });
  });

  test('AC-06: a pointer that moves between the metadata read and the write makes the checkpoint miss (epoch-mismatch), writing nothing', async () => {
    const { pageId } = await seedPageWithRevisionKind('markdown');
    const other = await seedPageWithRevisionKind('artifact');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const PageModel = models.Page as any;
    const originalUpdateOne = PageModel.updateOne.bind(PageModel);
    const updateOne = jest.spyOn(PageModel, 'updateOne').mockImplementation((...args: unknown[]) => ({
      exec: async () => {
        // A concurrent writer moves both pointers to an artifact Revision right after the metadata read.
        await PageModel.collection.updateOne(
          { _id: new mongoose.Types.ObjectId(pageId) },
          { $set: { revision: other.revisionId, currentRevision: other.revisionId } },
        );
        return originalUpdateOne(...args).exec();
      },
    }));
    let result;
    try {
      result = await persistYjsState(persistModels(), { pageId, document: makeDoc('x'), baselineBody: null, origin: 'save', expectedEpoch: 0 });
    } finally {
      updateOne.mockRestore();
    }
    expect(result).toEqual({ ok: false, reason: 'epoch-mismatch' });
    expect((await Page().findById(pageId).exec()).yjsState ?? null).toBeNull();
  });

  test('AC-10: the kind check reads one Page and at most one Revision query, with no body or Yjs bytes selected', async () => {
    const { pageId } = await seedPageWithRevisionKind('markdown');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Revision = models.Revision as any;
    const revisionFind = jest.spyOn(Revision, 'find');
    const pageFindById = jest.spyOn(Page(), 'findById');
    try {
      const result = await persistYjsState(persistModels(), { pageId, document: makeDoc('x'), baselineBody: null, origin: 'save', expectedEpoch: 0 });
      expect(result.ok).toBe(true);
      expect(revisionFind).toHaveBeenCalledTimes(1);
      expect(pageFindById).toHaveBeenCalledTimes(1);
    } finally {
      revisionFind.mockRestore();
      pageFindById.mockRestore();
    }
  });

  test('a missing Page and a soft-deleted Markdown Page both keep the existing epoch-mismatch outcome', async () => {
    expect(
      await persistYjsState(persistModels(), { pageId: new mongoose.Types.ObjectId().toString(), document: makeDoc('x'), baselineBody: null, origin: 'save' }),
    ).toEqual({
      ok: false,
      reason: 'epoch-mismatch',
    });
    const deleted = await seedPage({ status: 'deleted', collabLifecycleVersion: 4 });
    for (const expectedEpoch of [undefined, 4]) {
      expect(await persistYjsState(persistModels(), { pageId: deleted, document: makeDoc('x'), baselineBody: null, origin: 'save', expectedEpoch })).toEqual({
        ok: false,
        reason: 'epoch-mismatch',
      });
    }
  });

  test('AC-16: a STATUS_DELETED page rejects even when the epoch matches (belt-and-suspenders status predicate)', async () => {
    const pageId = await seedPage({ collabLifecycleVersion: 0, status: 'deleted' });
    const result = await persistYjsState(persistModels(), {
      pageId,
      document: makeDoc('targeting a deleted page'),
      baselineBody: null,
      origin: 'save',
      expectedEpoch: 0,
    });
    expect(result).toEqual({ ok: false, reason: 'epoch-mismatch' });
  });

  test('AC-16: a legacy row (status predicate only, no expectedEpoch) still rejects a deleted page', async () => {
    const pageId = await seedPage({ status: 'deleted' });
    // No `expectedEpoch` at all (fail-safe fallback) — the status predicate
    // alone must still guard against writing into a deleted page.
    const result = await persistYjsState(persistModels(), { pageId, document: makeDoc('no epoch known'), baselineBody: null, origin: 'store-only' });
    expect(result).toEqual({ ok: false, reason: 'epoch-mismatch' });
  });

  test('an unknown expectedEpoch (undefined) on a live, non-deleted page persists normally (fail-safe fallback, not a bypass)', async () => {
    const pageId = await seedPage({ collabLifecycleVersion: 9 });
    const result = await persistYjsState(persistModels(), {
      pageId,
      document: makeDoc('fresh process, no epoch recorded'),
      baselineBody: null,
      origin: 'full-merge',
    });
    expect(result.ok).toBe(true);

    const page = await Page().findById(pageId).exec();
    expect(page.yjsState).toBeTruthy();
  });

  test('AC-SC-9 (RFC-0020 §1): a Page that acquired artifact kind rejects the checkpoint even when the epoch matches, without writing yjsState', async () => {
    const pageId = await seedPage({ collabLifecycleVersion: 0, contentType: 'artifact' });
    const result = await persistYjsState(persistModels(), {
      pageId,
      document: makeDoc('must never be written onto an artifact Page'),
      baselineBody: null,
      origin: 'save',
      expectedEpoch: 0,
    });
    expect(result).toEqual({ ok: false, reason: 'content-type' });

    const page = await Page().findById(pageId).exec();
    expect(page.yjsState ?? null).toBeNull();
  });

  test('a missing contentType hint (legacy Markdown) still persists normally', async () => {
    const pageId = await seedPage({ collabLifecycleVersion: 0 });
    const result = await persistYjsState(persistModels(), {
      pageId,
      document: makeDoc('legacy markdown page'),
      baselineBody: null,
      origin: 'save',
      expectedEpoch: 0,
    });
    expect(result.ok).toBe(true);
  });
});
