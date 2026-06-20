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
    // The chokepoint now returns `null` on a reject (not an ok-shaped
    // 0-byte result) so `onStoreDocument` does not treat the reject as
    // "persisted" and the 10-min time-trigger can re-attempt.
    const empty = new Y.Doc();
    const result = await compactor.storeCheckpoint(pageId, empty);
    expect(result).toBeNull();

    // The good state survives untouched.
    const page = await Page().findById(pageId).exec();
    expect(Buffer.compare(page.yjsState as Buffer, goodState)).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('anti-shrink rejected the store-only checkpoint'));
  });

  test('full merge path (C1 regression): a shrink reject keeps the folded rows AND the surviving yjsState (no data loss)', async () => {
    // C1 was: on a full-merge anti-shrink reject the code kept the stale
    // (large) yjsState BUT still pruned the folded deletion deltas — so
    // the next load applied the stale state, saw a non-empty doc, took the
    // fast path, never replayed the deletion, and permanently reverted a
    // legitimate large deletion. The fix: on a reject write NOTHING and
    // DO NOT prune the rows, so the deletion deltas survive to replay over
    // the surviving base on the next load.
    const { pageId } = await fixtures.seedPage();
    await fixtures.seedRevision(pageId, BODY);

    // A good, large yjsState (the full body) is the protected baseline.
    const goodState = encodeYjsDelta(BODY);
    await Page()
      .updateOne({ _id: pageId }, { $set: { yjsState: goodState } })
      .exec();

    // A pending delta that, merged over the good state, DELETES most of
    // the content (a legitimate large deletion → drops below the 50%
    // anti-shrink ratio). We build it from a doc seeded with the same
    // state then delete most of the text, encoding only the resulting
    // delta so its lineage descends from `goodState`.
    const editor = new Y.Doc();
    Y.applyUpdate(editor, new Uint8Array(goodState));
    const stateBefore = Y.encodeStateVector(editor);
    editor.getText(CONTENT_FIELD).delete(2, BODY.length - 2); // keep ~2 chars
    const deletionDelta = Buffer.from(Y.encodeStateAsUpdate(editor, stateBefore));
    await PageYjsUpdate().create({ pageId, payload: deletionDelta, createdAt: new Date() });
    expect(await fixtures.countPending(pageId)).toBe(1);

    const compactor = createCompactor({ models: { Page: models.Page, PageYjsUpdate: models.PageYjsUpdate, Revision: models.Revision } });
    const result = await compactor.compactPage(pageId);

    // Reject: nothing folded, no bytes written.
    expect(result?.compactedCount).toBe(0);
    expect(result?.newYjsStateBytes).toBe(0);
    // C1 fix — the deletion deltas are PRESERVED (not pruned)...
    expect(await fixtures.countPending(pageId)).toBe(1);
    // ...and the surviving yjsState is left intact (not nulled, not the
    // shrunk merge). Next load applies it + replays the deletion delta →
    // the deletion is preserved instead of reverted.
    const page = await Page().findById(pageId).exec();
    expect(Buffer.compare(page.yjsState as Buffer, goodState)).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('anti-shrink rejected the full-merge checkpoint'));

    // Prove no data loss end-to-end: a fresh doc that applies the kept
    // yjsState + replays the kept deletion delta lands at the deleted size.
    const replay = new Y.Doc();
    Y.applyUpdate(replay, new Uint8Array(page.yjsState as Buffer));
    Y.applyUpdate(replay, new Uint8Array(deletionDelta));
    expect(replay.getText(CONTENT_FIELD).length).toBe(2);
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
