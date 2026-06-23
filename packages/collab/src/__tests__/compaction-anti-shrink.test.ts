process.env.WS_TOKEN_SECRET = process.env.WS_TOKEN_SECRET ?? 'test-ws-token-secret-base64-32bytes-=';

import * as Y from 'yjs';
import { startInMemoryMongo, registerTestModels, type SmokeMongo } from './setup';
import { encodeYjsDelta, makeFixtures, type CollabFixtures } from './fixtures';
import type { CollabModels } from '../models';
import { createCompactor } from '../compaction';
import { CONTENT_FIELD } from '../yjs-doc';

/**
 * editor-preview-reliability §1B (round 2, Decision 2) — DESYNC detection
 * across BOTH compaction write paths (store-only fast path + full merge).
 * The guard now rejects ONLY an EMPTY decoded doc over a non-empty revision
 * body (the desync tell-tale); a legitimate large deletion is non-empty and
 * persists durably. The rejected (empty) checkpoint must not overwrite the
 * last good `Page.yjsState`; the next onLoadDocument rebuilds from the body.
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
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('desync guard rejected the store-only checkpoint'));
  });

  test('store-only fast path (round 3): a baseline-body READ FAILURE on an empty live doc SKIPS the checkpoint (never overwrites with empty)', async () => {
    // Round 3: when the live doc is empty, the desync verdict hinges entirely
    // on whether the baseline body is non-empty. A transient baseline read
    // failure must NOT degrade to `baselineBody=null` (which would let the
    // empty doc overwrite a good yjsState); it must SKIP the checkpoint
    // (return null) so the 10-min time-trigger re-attempts once content is
    // re-established.
    const { pageId } = await fixtures.seedPage();
    await fixtures.seedRevision(pageId, BODY);

    const goodState = encodeYjsDelta(BODY);
    await Page()
      .updateOne({ _id: pageId }, { $set: { yjsState: goodState } })
      .exec();

    // Make the baseline body read throw. `latestRevisionBody` reads the page
    // (for the revision pointer) then the revision body via
    // `.select('body').lean().exec()`; we fail the revision read.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Revision = models.Revision as any;
    const spy = jest.spyOn(Revision, 'findById').mockImplementation(() => ({
      select: () => ({ lean: () => ({ exec: () => Promise.reject(new Error('simulated baseline read outage')) }) }),
    }));

    let result: Awaited<ReturnType<ReturnType<typeof createCompactor>['storeCheckpoint']>>;
    try {
      const compactor = createCompactor({ models: { Page: models.Page, PageYjsUpdate: models.PageYjsUpdate, Revision: models.Revision } });
      const empty = new Y.Doc();
      result = await compactor.storeCheckpoint(pageId, empty);
    } finally {
      spy.mockRestore();
    }

    // Skipped (not persisted), so onStoreDocument's time-trigger can retry.
    expect(result).toBeNull();
    // The good state survives untouched — the empty doc never overwrote it.
    const page = await Page().findById(pageId).exec();
    expect(Buffer.compare(page.yjsState as Buffer, goodState)).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('skipping store-only checkpoint'));
  });

  test('full merge path (C1 regression): an EMPTY-merge reject keeps the folded rows AND the surviving yjsState (no data loss)', async () => {
    // C1 was: on a full-merge reject the code kept the stale yjsState BUT
    // still pruned the folded deltas — so the next load applied the stale
    // state, saw a non-empty doc, took the fast path, never replayed the
    // deltas, and permanently reverted content. The fix: on a reject write
    // NOTHING, DO NOT prune the rows, and return null. Round 2: the reject
    // now only fires when the merge result is EMPTY over a non-empty body
    // (the desync tell-tale); a non-empty large deletion persists durably
    // (covered by the next test).
    const { pageId } = await fixtures.seedPage();
    await fixtures.seedRevision(pageId, BODY);

    // A good, large yjsState (the full body) is the protected baseline.
    const goodState = encodeYjsDelta(BODY);
    await Page()
      .updateOne({ _id: pageId }, { $set: { yjsState: goodState } })
      .exec();

    // A pending delta that, merged over the good state, deletes ALL the
    // content (the empty-over-nonempty desync case). We build it from a doc
    // seeded with the same state then delete every char, encoding only the
    // resulting delta so its lineage descends from `goodState`.
    const editor = new Y.Doc();
    Y.applyUpdate(editor, new Uint8Array(goodState));
    const stateBefore = Y.encodeStateVector(editor);
    editor.getText(CONTENT_FIELD).delete(0, BODY.length); // empties the doc
    const deletionDelta = Buffer.from(Y.encodeStateAsUpdate(editor, stateBefore));
    await PageYjsUpdate().create({ pageId, payload: deletionDelta, createdAt: new Date() });
    expect(await fixtures.countPending(pageId)).toBe(1);

    const compactor = createCompactor({ models: { Page: models.Page, PageYjsUpdate: models.PageYjsUpdate, Revision: models.Revision } });
    const result = await compactor.compactPage(pageId);

    // C4 — a reject returns null (so onStoreDocument doesn't read it as
    // "persisted" and skip the time-trigger).
    expect(result).toBeNull();
    // C1 fix — the deletion deltas are PRESERVED (not pruned)...
    expect(await fixtures.countPending(pageId)).toBe(1);
    // ...and the surviving yjsState is left intact (not nulled, not the
    // empty merge).
    const page = await Page().findById(pageId).exec();
    expect(Buffer.compare(page.yjsState as Buffer, goodState)).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('desync guard rejected the full-merge checkpoint'));
  });

  test('Decision 2 / C1 durability: a legitimate large (non-empty) deletion PERSISTS into yjsState, not 1h-TTL rows', async () => {
    // The shrink-ratio arm is gone: a large deletion that leaves the doc
    // NON-EMPTY is the live doc's real content and must be written durably
    // to yjsState (so it survives past the PageYjsUpdate TTL), with the
    // folded rows pruned. This is the case the old ratio guard wrongly
    // rejected (data reverted after TTL).
    const { pageId } = await fixtures.seedPage();
    await fixtures.seedRevision(pageId, BODY);

    const goodState = encodeYjsDelta(BODY);
    await Page()
      .updateOne({ _id: pageId }, { $set: { yjsState: goodState } })
      .exec();

    const editor = new Y.Doc();
    Y.applyUpdate(editor, new Uint8Array(goodState));
    const stateBefore = Y.encodeStateVector(editor);
    editor.getText(CONTENT_FIELD).delete(2, BODY.length - 2); // keep ~2 chars (non-empty)
    const deletionDelta = Buffer.from(Y.encodeStateAsUpdate(editor, stateBefore));
    await PageYjsUpdate().create({ pageId, payload: deletionDelta, createdAt: new Date() });

    const compactor = createCompactor({ models: { Page: models.Page, PageYjsUpdate: models.PageYjsUpdate, Revision: models.Revision } });
    const result = await compactor.compactPage(pageId);

    // The deletion is folded + persisted; the rows are pruned (durable now).
    expect(result?.compactedCount).toBe(1);
    expect(result?.newYjsStateBytes).toBeGreaterThan(0);
    expect(await fixtures.countPending(pageId)).toBe(0);

    // yjsState decodes to the deleted (2-char) doc — no TTL-row dependency.
    const page = await Page().findById(pageId).exec();
    const replay = new Y.Doc();
    Y.applyUpdate(replay, new Uint8Array(page.yjsState as Buffer));
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
