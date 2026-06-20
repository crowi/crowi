process.env.WS_TOKEN_SECRET = process.env.WS_TOKEN_SECRET ?? 'test-ws-token-secret-base64-32bytes-=';

import * as Y from 'yjs';
import { startInMemoryMongo, registerTestModels, type SmokeMongo } from './setup';
import { encodeYjsDelta, makeFixtures, type CollabFixtures } from './fixtures';
import type { CollabModels } from '../models';
import { createCompactor } from '../compaction';
import { CONTENT_FIELD } from '../yjs-doc';

/**
 * editor-preview-reliability §1B — anti-shrink across BOTH compaction
 * write paths (store-only fast path + full merge). An empty / heavily
 * shrunk doc must not overwrite the last good `Page.yjsState`; the next
 * onLoadDocument rebuilds from the revision body instead.
 */
describe('compaction anti-shrink (editor-preview-reliability §1B)', () => {
  let memMongo: SmokeMongo;
  let models: CollabModels;
  let fixtures: CollabFixtures;
  let warnSpy: jest.SpyInstance;

  beforeAll(async () => {
    memMongo = await startInMemoryMongo();
    const reg = registerTestModels();
    models = reg.models;
    fixtures = makeFixtures(models);
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const PageYjsUpdate = () => models.PageYjsUpdate as any;

  const BODY = 'A meaningful page body that exceeds the anti-shrink minimum baseline threshold comfortably.';

  test('store-only fast path: an empty live doc does not overwrite a good yjsState', async () => {
    const { pageId } = await fixtures.seedPage();
    await fixtures.seedRevision(pageId, BODY);

    // Establish a good non-empty yjsState first.
    const goodState = encodeYjsDelta(BODY);
    await Page()
      .updateOne({ _id: pageId }, { $set: { yjsState: goodState } })
      .exec();

    const compactor = createCompactor({ models: { Page: models.Page, PageYjsUpdate: models.PageYjsUpdate, Revision: models.Revision } });

    // Store checkpoint with an EMPTY live doc + no pending rows (fast path).
    const empty = new Y.Doc();
    const result = await compactor.storeCheckpoint(pageId, empty);
    expect(result).toEqual({ compactedCount: 0, newYjsStateBytes: 0 });

    // The good state survives untouched.
    const page = await Page().findById(pageId).exec();
    expect(Buffer.compare(page.yjsState as Buffer, goodState)).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('anti-shrink skipped store-only checkpoint'));
  });

  test('full merge path: an empty merged doc skips the yjsState write but still prunes folded rows', async () => {
    const { pageId } = await fixtures.seedPage();
    await fixtures.seedRevision(pageId, BODY);

    const goodState = encodeYjsDelta(BODY);
    await Page()
      .updateOne({ _id: pageId }, { $set: { yjsState: goodState } })
      .exec();

    // Seed pending rows whose net effect is an EMPTY doc (a single
    // delta from a fresh empty doc — applying it over `goodState` won't
    // empty it, so instead drive the full path with no fromDocument and
    // a pending delta that, merged over good state, stays non-empty.
    // To exercise the *reject* branch we force an empty merge by using a
    // delta encoded from an empty doc AND pre-clearing the baseline
    // yjsState to empty so the merge result is empty.)
    await Page()
      .updateOne({ _id: pageId }, { $set: { yjsState: null } })
      .exec();
    const emptyDelta = Buffer.from(Y.encodeStateAsUpdate(new Y.Doc()));
    await PageYjsUpdate().create({ pageId, payload: emptyDelta, createdAt: new Date() });
    expect(await fixtures.countPending(pageId)).toBe(1);

    const compactor = createCompactor({ models: { Page: models.Page, PageYjsUpdate: models.PageYjsUpdate, Revision: models.Revision } });
    const result = await compactor.compactPage(pageId);

    // The rows folded into the (empty) merge are still pruned...
    expect(result?.compactedCount).toBe(1);
    expect(result?.newYjsStateBytes).toBe(0);
    expect(await fixtures.countPending(pageId)).toBe(0);
    // ...but no empty yjsState was persisted (stays null → next load
    // rebuilds from the revision body).
    const page = await Page().findById(pageId).exec();
    expect(page.yjsState).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('anti-shrink skipped full-merge yjsState write'));
  });

  test('non-shrinking checkpoint writes yjsState normally (guard is a no-op)', async () => {
    const { pageId } = await fixtures.seedPage();
    await fixtures.seedRevision(pageId, BODY);

    const compactor = createCompactor({ models: { Page: models.Page, PageYjsUpdate: models.PageYjsUpdate, Revision: models.Revision } });

    const doc = new Y.Doc();
    doc.getText(CONTENT_FIELD).insert(0, BODY);
    const result = await compactor.storeCheckpoint(pageId, doc);
    expect(result?.newYjsStateBytes).toBeGreaterThan(0);

    const page = await Page().findById(pageId).exec();
    expect(page.yjsState).toBeTruthy();
    expect((page.yjsState as Buffer).length).toBeGreaterThan(0);
  });
});
