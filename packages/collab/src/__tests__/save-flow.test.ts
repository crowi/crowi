import { Types } from 'mongoose';
import * as Y from 'yjs';
import { createContributorsTracker } from '../contributors';
import { createDocBaseRevisionStore } from '../doc-base-revision';
import { createDocEpochStore } from '../doc-epoch';
import { createOnLoadDocument } from '../hooks/on-load-document';
import { createInvalidatedPagesStore } from '../invalidation';
import type { CollabModels } from '../models';
import { CollabSaveError, createSaveFlow } from '../save-flow';
import type { CollabPageEventPublisher } from '../types';
import { CONTENT_FIELD } from '../yjs-doc';
import { type CollabFixtures, makeFixtures } from './fixtures';
import { registerTestModels, type SmokeMongo, startInMemoryMongo } from './setup';

/**
 * Phase 5 save-flow tests. We drive `executeSave` end-to-end against
 * an in-memory MongoDB:
 *   - Page + Revision + PageYjsUpdate are real models from the api
 *     dist + a fully wired renderer (core 5 transforms only; plugin
 *     transforms aren't loaded — see __tests__/setup.ts:registerTestModels).
 *   - The publisher is mocked so we can assert what was emitted.
 *   - The contributors tracker is the real implementation.
 */

interface MockPublisher extends CollabPageEventPublisher {
  calls: Array<{ eventName: string; payload: Record<string, unknown> }>;
}

const makeMockPublisher = (): MockPublisher => {
  const calls: MockPublisher['calls'] = [];
  return {
    calls,
    async publish(eventName, payload) {
      calls.push({ eventName, payload: { ...payload } });
    },
  };
};

const seedUser = async (models: CollabModels, overrides: Record<string, unknown> = {}) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const User = models.User as any;
  return User.create({
    email: `user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    username: `u${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
    name: 'Test User',
    status: 2, // STATUS_ACTIVE in user.ts (defensive default)
    ...overrides,
  });
};

describe('createSaveFlow.executeSave', () => {
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

  test('happy path: writes Revision, updates Page, resets yjsState, clears pending, publishes update', async () => {
    const tracker = createContributorsTracker();
    const publisher = makeMockPublisher();
    const flow = createSaveFlow({ models, contributorsTracker: tracker, pageEventPublisher: publisher, docBaseRevisions: createDocBaseRevisionStore() });

    const { pageId } = await fixtures.seedPage();
    const user = await seedUser(models);

    // Awareness contributors include the trigger user + 2 others.
    // The flow must drop the trigger user (savedBy already points
    // at them) and persist the other 2 as contributors.
    const contribA = new Types.ObjectId();
    const contribB = new Types.ObjectId();
    tracker.record(pageId, contribA.toString());
    tracker.record(pageId, contribB.toString());
    tracker.record(pageId, user._id.toString()); // trigger user — must be filtered

    const doc = new Y.Doc();
    doc.getText(CONTENT_FIELD).insert(0, '# Hello\n\nworld');

    const result = await flow.executeSave({
      pageId,
      userId: user._id.toString(),
      document: doc,
      message: 'first checkpoint',
    });

    expect(result.revisionId).toMatch(/^[0-9a-f]{24}$/);

    // Revision row exists with the collab fields populated.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Revision = models.Revision as any;
    const rev = await Revision.findById(result.revisionId).lean().exec();
    expect(rev).toBeTruthy();
    expect(rev.body).toBe('# Hello\n\nworld');
    expect(rev.format).toBe('markdown');
    expect(rev.type).toBe('snapshot');
    expect(rev.savedBy.toString()).toBe(user._id.toString());
    expect(rev.message).toBe('first checkpoint');
    const contribIds = rev.contributors.map((id: Types.ObjectId) => id.toString()).sort();
    expect(contribIds).toEqual([contribA.toString(), contribB.toString()].sort());
    // The core renderer ran: meta + renderedAst + rendererVersion are stamped.
    expect(rev.meta).toBeDefined();
    expect(rev.rendererVersion).toBeDefined();

    // Page is bumped (revision pointer + currentRevision + yjsState + yjsCheckpointAt).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Page = models.Page as any;
    const page = await Page.findById(pageId).exec();
    expect(page.revision.toString()).toBe(result.revisionId);
    expect(page.currentRevision.toString()).toBe(result.revisionId);
    expect(page.yjsState).toBeTruthy();
    expect(page.yjsCheckpointAt).toBeInstanceOf(Date);

    // PageYjsUpdate cleared.
    expect(await fixtures.countPending(pageId)).toBe(0);

    // Tracker drained.
    expect(tracker.drain(pageId)).toEqual([]);

    // Publisher fired exactly one 'update' message with the right payload.
    expect(publisher.calls).toHaveLength(1);
    expect(publisher.calls[0].eventName).toBe('update');
    expect(publisher.calls[0].payload.pageId).toBe(pageId);
    expect(publisher.calls[0].payload.userId).toBe(user._id.toString());
    // collab no longer sends `bookmarkCount` over the wire — the api
    // subscriber defaults it to 0. See save-flow.ts step 8.
    expect(publisher.calls[0].payload.bookmarkCount).toBeUndefined();
  });

  test('parentRevisionId inherits from page.currentRevision when set', async () => {
    const tracker = createContributorsTracker();
    const publisher = makeMockPublisher();
    const flow = createSaveFlow({ models, contributorsTracker: tracker, pageEventPublisher: publisher, docBaseRevisions: createDocBaseRevisionStore() });

    const { pageId } = await fixtures.seedPage();
    const user = await seedUser(models);
    // Pre-seed an existing revision via fixtures so currentRevision
    // (set on save 1) chains to save 2's parentRevisionId.
    const doc = new Y.Doc();
    doc.getText(CONTENT_FIELD).insert(0, 'v1');
    const r1 = await flow.executeSave({ pageId, userId: user._id.toString(), document: doc });

    // Mutate the doc and save again — parentRevisionId on r2 must be r1.
    doc.getText(CONTENT_FIELD).insert(doc.getText(CONTENT_FIELD).length, '\nv2');
    const r2 = await flow.executeSave({ pageId, userId: user._id.toString(), document: doc });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Revision = models.Revision as any;
    const rev2 = await Revision.findById(r2.revisionId).lean().exec();
    expect(rev2.parentRevisionId.toString()).toBe(r1.revisionId);
  });

  test('renderer failure throws CollabSaveError code=RENDERER_FAILED and leaves Page untouched', async () => {
    const tracker = createContributorsTracker();
    const publisher = makeMockPublisher();
    const flow = createSaveFlow({ models, contributorsTracker: tracker, pageEventPublisher: publisher, docBaseRevisions: createDocBaseRevisionStore() });

    const { pageId } = await fixtures.seedPage();
    const user = await seedUser(models);

    // Stub `prepareRevision` to throw — simulates a renderer pipeline crash.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Revision = models.Revision as any;
    const originalPrepare = Revision.prepareRevision;
    Revision.prepareRevision = async () => {
      throw new Error('pipeline blew up');
    };

    const doc = new Y.Doc();
    doc.getText(CONTENT_FIELD).insert(0, 'body');

    try {
      await expect(flow.executeSave({ pageId, userId: user._id.toString(), document: doc })).rejects.toMatchObject({
        code: 'RENDERER_FAILED',
        name: 'CollabSaveError',
      });
    } finally {
      Revision.prepareRevision = originalPrepare;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Page = models.Page as any;
    const page = await Page.findById(pageId).exec();
    expect(page.currentRevision).toBeFalsy();
    expect(page.yjsState).toBeFalsy();

    // Publisher never fired (failure short-circuited before step 8).
    expect(publisher.calls).toHaveLength(0);
  });

  test('user not found throws CollabSaveError code=USER_NOT_FOUND', async () => {
    const tracker = createContributorsTracker();
    const publisher = makeMockPublisher();
    const flow = createSaveFlow({ models, contributorsTracker: tracker, pageEventPublisher: publisher, docBaseRevisions: createDocBaseRevisionStore() });

    const { pageId } = await fixtures.seedPage();
    const doc = new Y.Doc();
    doc.getText(CONTENT_FIELD).insert(0, 'body');

    const ghostUserId = new Types.ObjectId().toString();
    await expect(flow.executeSave({ pageId, userId: ghostUserId, document: doc })).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
  });

  test('page not found throws CollabSaveError code=PAGE_NOT_FOUND', async () => {
    const tracker = createContributorsTracker();
    const publisher = makeMockPublisher();
    const flow = createSaveFlow({ models, contributorsTracker: tracker, pageEventPublisher: publisher, docBaseRevisions: createDocBaseRevisionStore() });

    const user = await seedUser(models);
    const doc = new Y.Doc();
    doc.getText(CONTENT_FIELD).insert(0, 'body');

    const ghostPageId = new Types.ObjectId().toString();
    await expect(flow.executeSave({ pageId: ghostPageId, userId: user._id.toString(), document: doc })).rejects.toMatchObject({ code: 'PAGE_NOT_FOUND' });
  });

  test('two saves in a row produce two distinct Revisions and Page.currentRevision tracks the latest', async () => {
    const tracker = createContributorsTracker();
    const publisher = makeMockPublisher();
    const flow = createSaveFlow({ models, contributorsTracker: tracker, pageEventPublisher: publisher, docBaseRevisions: createDocBaseRevisionStore() });

    const { pageId } = await fixtures.seedPage();
    const user = await seedUser(models);

    const doc = new Y.Doc();
    doc.getText(CONTENT_FIELD).insert(0, 'first');
    const r1 = await flow.executeSave({ pageId, userId: user._id.toString(), document: doc });

    doc.getText(CONTENT_FIELD).insert(doc.getText(CONTENT_FIELD).length, ' + second');
    const r2 = await flow.executeSave({ pageId, userId: user._id.toString(), document: doc });

    expect(r1.revisionId).not.toBe(r2.revisionId);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Page = models.Page as any;
    const page = await Page.findById(pageId).exec();
    expect(page.currentRevision.toString()).toBe(r2.revisionId);
    expect(page.revision.toString()).toBe(r2.revisionId);
  });

  test('publish-on-save: a draft page transitions to published after a successful save', async () => {
    const tracker = createContributorsTracker();
    const publisher = makeMockPublisher();
    const flow = createSaveFlow({ models, contributorsTracker: tracker, pageEventPublisher: publisher, docBaseRevisions: createDocBaseRevisionStore() });

    // Seed a page in the RFC-0004 draft state (status: 'draft').
    const { pageId } = await fixtures.seedPage({ status: 'draft' });
    const user = await seedUser(models);

    const doc = new Y.Doc();
    doc.getText(CONTENT_FIELD).insert(0, '# Published now');

    await flow.executeSave({ pageId, userId: user._id.toString(), document: doc });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Page = models.Page as any;
    const page = await Page.findById(pageId).exec();
    expect(page.status).toBe('published');
  });

  test('publish-on-save: an already-published page keeps its status untouched on save', async () => {
    const tracker = createContributorsTracker();
    const publisher = makeMockPublisher();
    const flow = createSaveFlow({ models, contributorsTracker: tracker, pageEventPublisher: publisher, docBaseRevisions: createDocBaseRevisionStore() });

    // `fixtures.seedPage` defaults to status: 'published'.
    const { pageId } = await fixtures.seedPage();
    const user = await seedUser(models);

    const doc = new Y.Doc();
    doc.getText(CONTENT_FIELD).insert(0, 'just an edit');

    await flow.executeSave({ pageId, userId: user._id.toString(), document: doc });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Page = models.Page as any;
    const page = await Page.findById(pageId).exec();
    expect(page.status).toBe('published');
  });

  test('publish-on-save: a second save of an already-published draft is a no-op on status', async () => {
    const tracker = createContributorsTracker();
    const publisher = makeMockPublisher();
    const flow = createSaveFlow({ models, contributorsTracker: tracker, pageEventPublisher: publisher, docBaseRevisions: createDocBaseRevisionStore() });

    const { pageId } = await fixtures.seedPage({ status: 'draft' });
    const user = await seedUser(models);

    const doc = new Y.Doc();
    doc.getText(CONTENT_FIELD).insert(0, 'v1');
    await flow.executeSave({ pageId, userId: user._id.toString(), document: doc });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Page = models.Page as any;
    expect((await Page.findById(pageId).exec()).status).toBe('published');

    // Second save: the page is now published — status must stay put.
    doc.getText(CONTENT_FIELD).insert(doc.getText(CONTENT_FIELD).length, '\nv2');
    await flow.executeSave({ pageId, userId: user._id.toString(), document: doc });
    expect((await Page.findById(pageId).exec()).status).toBe('published');
  });

  test('CollabSaveError is exported as a real Error subclass (instanceof works)', async () => {
    // Quick sanity check — the on-stateless handler depends on
    // `err instanceof CollabSaveError` for code-narrowing.
    const err = new CollabSaveError('READONLY', 'nope');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CollabSaveError);
    expect(err.code).toBe('READONLY');
  });

  /**
   * RFC-0017 Phase 1 §4.1/AC-1..8 — the collab lifecycle epoch fold into
   * `executeSave`'s atomic pointer CAS. This is the correctness core: a
   * stale save must be rejected the instant a lifecycle transition
   * (rename/delete/revert/body-replace) advances the page's epoch, even
   * when `currentRevision` (the pre-existing CAS anchor) is UNCHANGED —
   * the rename case, where path/status CAS alone would incorrectly pass
   * (RFC-0017 §0.1). Nested inside the outer describe to reuse its
   * `models`/`fixtures`/`memMongo` (registering the api dist models twice
   * in one Jest file throws `OverwriteModelError`).
   */
  describe('RFC-0017 Phase 1 epoch CAS', () => {
    /**
     * Materialise a server doc via the REAL `onLoadDocument` hook so the
     * epoch (and doc base) are recorded exactly the way production does —
     * not hand-set on the stores, so these tests exercise the actual
     * recording path too.
     */
    const materialise = async (
      docBaseRevisions: ReturnType<typeof createDocBaseRevisionStore>,
      docEpochRevisions: ReturnType<typeof createDocEpochStore>,
      pageId: string,
    ): Promise<Y.Doc> => {
      const onLoadDocument = createOnLoadDocument({
        models: { Page: models.Page, Revision: models.Revision, PageYjsUpdate: models.PageYjsUpdate },
        docBaseRevisions,
        docEpochRevisions,
        invalidatedPages: createInvalidatedPagesStore(),
      });
      const doc = new Y.Doc();
      await onLoadDocument({
        documentName: pageId,
        document: doc,
        instance: { documents: new Map() },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      return doc;
    };

    test('AC-1: a rename (currentRevision UNCHANGED, epoch advanced) rejects a stale save via the epoch predicate ALONE', async () => {
      const docBaseRevisions = createDocBaseRevisionStore();
      const docEpochRevisions = createDocEpochStore();
      const publisher: CollabPageEventPublisher = { async publish() {} };
      const flow = createSaveFlow({
        models,
        contributorsTracker: createContributorsTracker(),
        pageEventPublisher: publisher,
        docBaseRevisions,
        docEpochRevisions,
      });

      const { pageId } = await fixtures.seedPage();
      const user = await seedUser(models);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Page = models.Page as any;

      const doc = await materialise(docBaseRevisions, docEpochRevisions, pageId);
      const before = await Page.findById(pageId).exec();
      const preRenameRevision = before.currentRevision ?? before.revision ?? null;

      // Simulate `Page.rename`'s epoch $inc — path changes, `currentRevision`
      // (and `revision`) do NOT. If the CAS only checked `{ _id,
      // currentRevision }` this save would PASS (self-invalidation hole).
      await Page.updateOne({ _id: pageId }, { $set: { path: `${before.path}-renamed` }, $inc: { collabLifecycleVersion: 1 } }).exec();

      doc.getText(CONTENT_FIELD).insert(0, 'stale content from before the rename');
      await expect(flow.executeSave({ pageId, userId: user._id.toString(), document: doc })).rejects.toMatchObject({ code: 'CONFLICT' });

      // currentRevision truly was unchanged by the rename (proving the
      // epoch predicate — not a currentRevision mismatch — is what rejected).
      const afterAttempt = await Page.findById(pageId).exec();
      const afterAttemptRevision = afterAttempt.currentRevision ?? afterAttempt.revision ?? null;
      expect(String(afterAttemptRevision)).toBe(String(preRenameRevision));
    });

    test("AC-2: a mutation that lands AFTER executeSave's own internal page read (TOCTOU) still rejects", async () => {
      const docBaseRevisions = createDocBaseRevisionStore();
      const docEpochRevisions = createDocEpochStore();
      const publisher: CollabPageEventPublisher = { async publish() {} };
      const flow = createSaveFlow({
        models,
        contributorsTracker: createContributorsTracker(),
        pageEventPublisher: publisher,
        docBaseRevisions,
        docEpochRevisions,
      });

      const { pageId } = await fixtures.seedPage();
      const user = await seedUser(models);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Page = models.Page as any;
      const doc = await materialise(docBaseRevisions, docEpochRevisions, pageId);

      // Inject the lifecycle mutation to land EXACTLY between executeSave's
      // own internal `Page.findById` read (step 2) and its final atomic
      // `updateOne` (step 5b) — the race window AC-2 targets. `expectedEpoch`
      // was already captured at materialise time (0); this proves the FINAL
      // atomic write's filter, not the earlier in-memory read, is what
      // enforces correctness.
      const originalFindById = Page.findById.bind(Page);
      Page.findById = (...args: unknown[]) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const query = (originalFindById as any)(...args);
        const originalExec = query.exec.bind(query);
        query.exec = async () => {
          const result = await originalExec();
          // The mutation lands AFTER this read resolves.
          await Page.updateOne({ _id: pageId }, { $inc: { collabLifecycleVersion: 1 } }).exec();
          return result;
        };
        return query;
      };

      try {
        doc.getText(CONTENT_FIELD).insert(0, 'raced by a mutation landing mid-executeSave');
        await expect(flow.executeSave({ pageId, userId: user._id.toString(), document: doc })).rejects.toMatchObject({ code: 'CONFLICT' });
      } finally {
        Page.findById = originalFindById;
      }
    });

    test('AC-3: a STATUS_DELETED page rejects a save even when the epoch matches (belt-and-suspenders status predicate)', async () => {
      const docBaseRevisions = createDocBaseRevisionStore();
      const docEpochRevisions = createDocEpochStore();
      const publisher: CollabPageEventPublisher = { async publish() {} };
      const flow = createSaveFlow({
        models,
        contributorsTracker: createContributorsTracker(),
        pageEventPublisher: publisher,
        docBaseRevisions,
        docEpochRevisions,
      });

      const { pageId } = await fixtures.seedPage();
      const user = await seedUser(models);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Page = models.Page as any;

      const doc = await materialise(docBaseRevisions, docEpochRevisions, pageId);

      // Soft-delete WITHOUT advancing the epoch (isolates the status
      // predicate specifically — the epoch advance is covered by AC-1/AC-9/10).
      await Page.updateOne({ _id: pageId }, { $set: { status: 'deleted' } }).exec();

      doc.getText(CONTENT_FIELD).insert(0, 'stale content targeting a deleted page');
      await expect(flow.executeSave({ pageId, userId: user._id.toString(), document: doc })).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    test('AC-4: the CAS miss from a lifecycle transition does not mis-coalesce into a false save-ok', async () => {
      const docBaseRevisions = createDocBaseRevisionStore();
      const docEpochRevisions = createDocEpochStore();
      const publisher: CollabPageEventPublisher = { async publish() {} };
      const flow = createSaveFlow({
        models,
        contributorsTracker: createContributorsTracker(),
        pageEventPublisher: publisher,
        docBaseRevisions,
        docEpochRevisions,
      });

      const { pageId } = await fixtures.seedPage();
      const user = await seedUser(models);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Page = models.Page as any;

      const doc = await materialise(docBaseRevisions, docEpochRevisions, pageId);
      // A lifecycle transition (rename) — advances the epoch WITHOUT ever
      // advancing `docBaseRevisions` (only `Page.rename` / `deletePage` /
      // `revertDeletedPage` touch the epoch; nothing in the collab package
      // itself moves the in-process doc base except a collab save).
      await Page.updateOne({ _id: pageId }, { $inc: { collabLifecycleVersion: 1 } }).exec();

      doc.getText(CONTENT_FIELD).insert(0, 'a body nobody else has written');
      // `tryCoalesce`'s condition 1 (`docBaseRevisions` advanced to the live
      // pointer) never holds for a lifecycle-only transition — settles to a
      // genuine CONFLICT after the bounded micro-retry budget, never a
      // save-ok.
      await expect(flow.executeSave({ pageId, userId: user._id.toString(), document: doc })).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    test('AC-5: expectedEpoch is server-recorded — a caller cannot smuggle a client-supplied epoch into executeSave', async () => {
      const docBaseRevisions = createDocBaseRevisionStore();
      const docEpochRevisions = createDocEpochStore();
      const publisher: CollabPageEventPublisher = { async publish() {} };
      const flow = createSaveFlow({
        models,
        contributorsTracker: createContributorsTracker(),
        pageEventPublisher: publisher,
        docBaseRevisions,
        docEpochRevisions,
      });

      const { pageId } = await fixtures.seedPage();
      const user = await seedUser(models);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Page = models.Page as any;

      const doc = await materialise(docBaseRevisions, docEpochRevisions, pageId);
      await Page.updateOne({ _id: pageId }, { $inc: { collabLifecycleVersion: 1 } }).exec();

      doc.getText(CONTENT_FIELD).insert(0, 'attempted bypass');
      // `ExecuteSaveInput` has no `epoch`/`expectedEpoch` field at all — the
      // TS surface doesn't expose one to smuggle a stale-but-matching value
      // through. Casting past the type to prove the runtime ALSO ignores it
      // (the extra property is simply not destructured by `executeSave`).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const bypassAttempt = { pageId, userId: user._id.toString(), document: doc, expectedEpoch: 0, epoch: 0 } as any;
      await expect(flow.executeSave(bypassAttempt)).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    test('AC-6: a doc materialised DURING an invalidation drain still records expectedEpoch (sibling store is unconditional)', async () => {
      const docBaseRevisions = createDocBaseRevisionStore();
      const docEpochRevisions = createDocEpochStore();
      const invalidatedPages = createInvalidatedPagesStore();
      const publisher: CollabPageEventPublisher = { async publish() {} };
      const flow = createSaveFlow({
        models,
        contributorsTracker: createContributorsTracker(),
        pageEventPublisher: publisher,
        docBaseRevisions,
        docEpochRevisions,
      });

      const { pageId } = await fixtures.seedPage();
      const user = await seedUser(models);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Page = models.Page as any;

      // Mark the page as mid-drain (mirrors the invalidator having just run).
      invalidatedPages.mark(pageId, 5000);

      const onLoadDocument = createOnLoadDocument({
        models: { Page: models.Page, Revision: models.Revision, PageYjsUpdate: models.PageYjsUpdate },
        docBaseRevisions,
        docEpochRevisions,
        invalidatedPages,
      });
      const doc = new Y.Doc();
      await onLoadDocument({
        documentName: pageId,
        document: doc,
        instance: { documents: new Map() },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      // The doc base is NOT recorded mid-drain (existing G1 behaviour) — but
      // the epoch IS (RFC-0017 Phase 1, unconditional).
      expect(docBaseRevisions.get(pageId)).toBeUndefined();
      expect(docEpochRevisions.get(pageId)).toBe(0);

      // Advance the epoch (simulating the SAME transition that triggered the
      // drain) — the stale doc-base-unknown save still gets the epoch CAS
      // guard because `expectedEpoch` WAS recorded.
      await Page.updateOne({ _id: pageId }, { $inc: { collabLifecycleVersion: 1 } }).exec();
      doc.getText(CONTENT_FIELD).insert(0, 'stale content materialised mid-drain');
      await expect(flow.executeSave({ pageId, userId: user._id.toString(), document: doc })).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    test('AC-7: an unrecorded epoch (synthetic driver / process restart) degrades to the fail-safe fallback, not a bypass', async () => {
      // `docEpochRevisions` is never populated for this pageId (as if this
      // process restarted after the doc was last loaded, or a synthetic test
      // driver never called `onLoadDocument`).
      const docBaseRevisions = createDocBaseRevisionStore();
      const docEpochRevisions = createDocEpochStore();
      const publisher: CollabPageEventPublisher = { async publish() {} };
      const flow = createSaveFlow({
        models,
        contributorsTracker: createContributorsTracker(),
        pageEventPublisher: publisher,
        docBaseRevisions,
        docEpochRevisions,
      });

      const { pageId } = await fixtures.seedPage();
      const user = await seedUser(models);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Page = models.Page as any;

      const doc = new Y.Doc();
      doc.getText(CONTENT_FIELD).insert(0, 'first save from a fresh process, no doc base recorded');

      // The page's epoch has ALREADY advanced (e.g. a rename before this
      // process ever saw the page) — with no recorded `expectedEpoch`, the
      // predicate is omitted (fail-safe fallback) rather than fabricating a
      // match, so the save proceeds on the `{ _id, currentRevision }` +
      // status predicate alone (identical to pre-RFC-0017 behaviour).
      await Page.updateOne({ _id: pageId }, { $inc: { collabLifecycleVersion: 5 } }).exec();

      const result = await flow.executeSave({ pageId, userId: user._id.toString(), document: doc });
      expect(result.revisionId).toMatch(/^[0-9a-f]{24}$/);
    });

    test("AC-8: cross-replica enforcement — a directly-advanced DB epoch (simulating another replica) rejects this process's save", async () => {
      const docBaseRevisions = createDocBaseRevisionStore();
      const docEpochRevisions = createDocEpochStore();
      const publisher: CollabPageEventPublisher = { async publish() {} };
      const flow = createSaveFlow({
        models,
        contributorsTracker: createContributorsTracker(),
        pageEventPublisher: publisher,
        docBaseRevisions,
        docEpochRevisions,
      });

      const { pageId } = await fixtures.seedPage();
      const user = await seedUser(models);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Page = models.Page as any;

      // This process materialised the doc and recorded epoch 0 (as if via a
      // real onLoadDocument on THIS replica).
      const doc = await materialise(docBaseRevisions, docEpochRevisions, pageId);

      // ANOTHER replica renames the page — simulated by advancing the epoch
      // directly on the shared DB row (no in-process store on THIS replica
      // is touched, exactly mirroring a genuinely different process).
      await Page.updateOne({ _id: pageId }, { $inc: { collabLifecycleVersion: 1 } }).exec();

      doc.getText(CONTENT_FIELD).insert(0, "this replica does not know about the other replica's rename");
      await expect(flow.executeSave({ pageId, userId: user._id.toString(), document: doc })).rejects.toMatchObject({ code: 'CONFLICT' });
    });
  });
});
