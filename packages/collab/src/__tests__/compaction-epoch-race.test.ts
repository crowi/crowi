import mongoose from 'mongoose';
import * as Y from 'yjs';
import type { CollabModels } from '../models';
import { createCompactor } from '../compaction';
import { createDocEpochStore } from '../doc-epoch';
import { CONTENT_FIELD } from '../yjs-doc';
import { registerTestModels, type SmokeMongo, startInMemoryMongo } from './setup';
import { encodeYjsDelta } from './fixtures';

/**
 * RFC-0017 Phase 1 §4.2 — regression test for the "compaction generation
 * race" codex flagged in review round 4 (`compaction.ts` reading
 * `docEpochRevisions.get(pageId)` LATE, right at each `persistYjsState`
 * call site, instead of once at the start of the compaction generation).
 *
 * The race: `docEpochRevisions` is a shared, process-wide, mutable
 * `Map<pageId, epoch>` that `onLoadDocument` overwrites UNCONDITIONALLY on
 * every load for a given `pageId` (see `doc-epoch.ts`). A compaction that
 * started BEFORE a lifecycle transition (rename/delete/revert/body-replace)
 * — e.g. `onChange`'s fire-and-forget count-trigger, or the debounce-driven
 * `onStoreDocument` store — does several `await`s (the pending-rows find,
 * the Y.Doc merge, the baseline-body read) before it reaches its
 * `persistYjsState` write. If a DIFFERENT connection reconnects to the SAME
 * `pageId` during that window (the invalidator detaches the stale doc from
 * the Hocuspocus registry SYNCHRONOUSLY, well before its grace-period close
 * — see `invalidation.ts` — so a fresh `onLoadDocument` can fire almost
 * immediately after the transition lands), it overwrites the shared epoch
 * store to the NEW post-transition epoch. Reading the store LATE would then
 * hand `persistYjsState` the NEW epoch — which matches the DB's own
 * (already-advanced) `collabLifecycleVersion` — so the stale compaction's
 * write would land, resurrecting pre-transition content instead of being
 * rejected.
 *
 * The fix (`compaction.ts`'s `runCompaction`): capture `expectedEpoch`
 * ONCE, synchronously, as the first statement — before the pending-rows
 * `find` and before any other `await` — so a concurrent `.set()` from a
 * racing `onLoadDocument` can never retroactively change what this
 * compaction generation CASes against.
 *
 * This test simulates the race deterministically (no real timing race)
 * by hooking `PageYjsUpdate.find(...).exec()` — the very first `await` in
 * `runCompaction` — to perform the "concurrent transition + reconnect"
 * side effect (bump the page's real `collabLifecycleVersion` in the DB and
 * overwrite the shared `docEpochRevisions` store) before returning the
 * pending rows. Under the fix, `expectedEpoch` was already captured before
 * this hook fires, so the later `persistYjsState` call CASes against the
 * OLD epoch and is correctly rejected (zero-match against the now-advanced
 * DB row). Under the pre-fix (late-read) behaviour this assertion would
 * fail: the late read would observe the NEW epoch, which matches the DB,
 * and the stale write would land.
 */
describe('compaction generation race (RFC-0017 Phase 1 §4.2)', () => {
  let memMongo: SmokeMongo;
  let models: CollabModels;

  beforeAll(async () => {
    memMongo = await startInMemoryMongo();
    const reg = registerTestModels();
    models = reg.models;
  });

  afterAll(async () => {
    await memMongo.stop();
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Page = () => models.Page as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Revision = () => models.Revision as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const PageYjsUpdate = () => models.PageYjsUpdate as any;

  const seedPage = async (overrides: Record<string, unknown> = {}) => {
    const page = await Page().create({
      path: `/__compact-epoch-race-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      creator: new mongoose.Types.ObjectId(),
      grant: 1,
      status: 'published',
      ...overrides,
    });
    return page._id.toString();
  };

  const seedRevision = async (pageId: string, body: string) => {
    const page = await Page().findById(pageId).exec();
    const revision = await Revision().create({ path: page.path, body, author: page.creator, format: 'markdown' });
    page.revision = revision._id;
    await page.save();
  };

  test('a compaction started before a lifecycle transition rejects its write instead of landing under the NEW epoch', async () => {
    const OLD_EPOCH = 5;
    const NEW_EPOCH = 6;

    const pageId = await seedPage({ collabLifecycleVersion: OLD_EPOCH });
    await seedRevision(pageId, 'pre-transition body');

    // A baseline checkpoint (as if an earlier compaction/save already
    // persisted something) so we can assert it is left untouched below.
    const baselineDoc = new Y.Doc();
    baselineDoc.getText(CONTENT_FIELD).insert(0, 'base');
    await Page()
      .updateOne({ _id: pageId }, { $set: { yjsState: Buffer.from(Y.encodeStateAsUpdate(baselineDoc)), yjsCheckpointAt: new Date(Date.now() - 1000) } })
      .exec();

    // One pending delta the compaction will try to fold.
    await PageYjsUpdate().create({ pageId, payload: encodeYjsDelta('x'), createdAt: new Date(), collabLifecycleVersion: OLD_EPOCH });

    // The epoch store, as it stood when THIS document generation was
    // materialised (`onLoadDocument` recorded OLD_EPOCH before the
    // transition below).
    const docEpochRevisions = createDocEpochStore();
    docEpochRevisions.set(pageId, OLD_EPOCH);

    // Hook the pending-rows find (the first `await` inside `runCompaction`)
    // to simulate, mid-flight, a lifecycle transition landing + a fresh
    // `onLoadDocument` reconnect for the SAME pageId overwriting the shared
    // store — exactly the race window the fix closes.
    const realFind = PageYjsUpdate().find.bind(PageYjsUpdate());
    const findSpy = jest.spyOn(PageYjsUpdate(), 'find').mockImplementation(((filter: unknown) => {
      const query = realFind(filter);
      const originalExec = query.exec.bind(query);
      query.exec = async () => {
        await Page()
          .updateOne({ _id: pageId }, { $inc: { collabLifecycleVersion: 1 } })
          .exec();
        docEpochRevisions.set(pageId, NEW_EPOCH);
        return originalExec();
      };
      return query;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);

    const compactor = createCompactor({
      models: { Page: models.Page, PageYjsUpdate: models.PageYjsUpdate, Revision: models.Revision },
      docEpochRevisions,
    });

    try {
      const result = await compactor.compactPage(pageId);
      // Fixed behaviour: `expectedEpoch` was frozen at OLD_EPOCH before the
      // race, so `persistYjsState`'s CAS against the now-NEW_EPOCH DB row
      // zero-matches and the compaction reports "nothing written".
      expect(result).toBeNull();
    } finally {
      findSpy.mockRestore();
    }

    const after = await Page().findById(pageId).select('yjsState collabLifecycleVersion').exec();
    // The transition itself landed (this is real and expected)...
    expect(after?.collabLifecycleVersion).toBe(NEW_EPOCH);
    // ...but the stale compaction's merged content must NOT have been
    // written over the baseline checkpoint.
    const restored = new Y.Doc();
    Y.applyUpdate(restored, new Uint8Array(after?.yjsState as Buffer));
    expect(restored.getText(CONTENT_FIELD).toString()).toBe('base');

    // No-data-loss policy: the folded row was NOT pruned on reject, so a
    // later, correctly-epoched compaction/load can still replay it.
    expect(await PageYjsUpdate().countDocuments({ pageId }).exec()).toBe(1);
  });
});
