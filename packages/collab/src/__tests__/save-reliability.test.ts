import * as Y from 'yjs';
import { Types } from 'mongoose';
import type { CollabModels } from '../models';
import { createContributorsTracker } from '../contributors';
import { createSaveFlow } from '../save-flow';
import { createDocBaseRevisionStore, type DocBaseRevisionStore } from '../doc-base-revision';
import { createOnLoadDocument } from '../hooks/on-load-document';
import { startInMemoryMongo, registerTestModels, type SmokeMongo } from './setup';
import { makeFixtures, type CollabFixtures } from './fixtures';
import { CONTENT_FIELD } from '../yjs-doc';
import type { CollabPageEventPublisher } from '../types';

/**
 * editor-preview-reliability (round 2) save-flow tests:
 *   - Decision 1 (server-doc lock): co-editing never false-CONFLICTs; an
 *     out-of-band save that moves `currentRevision` is rejected; `revision`
 *     and `currentRevision` are bumped atomically (never diverge).
 *   - Decision 2 (anti-shrink → desync): a user save is explicit intent, so
 *     a legitimate large deletion / empty clear persists; a baseline read
 *     failure rejects the save (never commits blindly).
 */

const makeMockPublisher = (): CollabPageEventPublisher & { calls: number } => {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    async publish() {
      state.calls += 1;
    },
  } as CollabPageEventPublisher & { calls: number };
};

const seedUser = async (models: CollabModels) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const User = models.User as any;
  return User.create({
    email: `user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    username: `u${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
    name: 'Test User',
    status: 2,
  });
};

describe('save-flow reliability (editor-preview-reliability round 2)', () => {
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

  /**
   * Materialise the server doc the way `onLoadDocument` does so the doc
   * base revision is recorded in `docBaseRevisions`, then return a live
   * Y.Doc the save flow can operate on. Mirrors the real engine wiring (one
   * shared store between onLoadDocument + saveFlow).
   */
  const materialise = async (docBaseRevisions: DocBaseRevisionStore, pageId: string): Promise<Y.Doc> => {
    const onLoadDocument = createOnLoadDocument({
      models: { Page: models.Page, Revision: models.Revision, PageYjsUpdate: models.PageYjsUpdate },
      docBaseRevisions,
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

  test('Decision 1: a save on a current server doc succeeds; revision === currentRevision', async () => {
    const docBaseRevisions = createDocBaseRevisionStore();
    const flow = createSaveFlow({ models, contributorsTracker: createContributorsTracker(), pageEventPublisher: makeMockPublisher(), docBaseRevisions });
    const { pageId } = await fixtures.seedPage();
    const user = await seedUser(models);

    const doc = await materialise(docBaseRevisions, pageId);
    doc.getText(CONTENT_FIELD).insert(0, 'v1 body');
    const r1 = await flow.executeSave({ pageId, userId: user._id.toString(), document: doc });

    // The base advanced to r1; a second save on the SAME server doc lands.
    doc.getText(CONTENT_FIELD).insert(doc.getText(CONTENT_FIELD).length, ' + more');
    const r2 = await flow.executeSave({ pageId, userId: user._id.toString(), document: doc });
    expect(r2.revisionId).not.toBe(r1.revisionId);

    const page = await Page().findById(pageId).exec();
    expect(page.currentRevision.toString()).toBe(r2.revisionId);
    // A1 — the two pointers were bumped atomically and never diverge.
    expect(page.revision.toString()).toBe(r2.revisionId);
  });

  test('A2: two editors sharing ONE server doc both save without a false CONFLICT', async () => {
    // The real multi-user shape: A and B connect to the SAME Hocuspocus
    // document (one server doc → one base in the shared store). A saves,
    // the base advances; B then saves the SAME live doc and must succeed —
    // the pre-fix client-pinned base would have false-CONFLICTed here.
    const docBaseRevisions = createDocBaseRevisionStore();
    const flow = createSaveFlow({ models, contributorsTracker: createContributorsTracker(), pageEventPublisher: makeMockPublisher(), docBaseRevisions });
    const { pageId } = await fixtures.seedPage();
    const userA = await seedUser(models);
    const userB = await seedUser(models);

    const doc = await materialise(docBaseRevisions, pageId);
    doc.getText(CONTENT_FIELD).insert(0, 'A typed this. ');
    const rA = await flow.executeSave({ pageId, userId: userA._id.toString(), document: doc });

    // B edits the same shared doc and saves — no CONFLICT.
    doc.getText(CONTENT_FIELD).insert(doc.getText(CONTENT_FIELD).length, 'B added this.');
    const rB = await flow.executeSave({ pageId, userId: userB._id.toString(), document: doc });
    expect(rB.revisionId).not.toBe(rA.revisionId);

    const page = await Page().findById(pageId).exec();
    expect(page.currentRevision.toString()).toBe(rB.revisionId);
    expect(page.revision.toString()).toBe(rB.revisionId);
  });

  test('Decision 1: an out-of-band save (HTTP / other instance) that moved currentRevision is rejected with CONFLICT', async () => {
    const docBaseRevisions = createDocBaseRevisionStore();
    const flow = createSaveFlow({ models, contributorsTracker: createContributorsTracker(), pageEventPublisher: makeMockPublisher(), docBaseRevisions });
    const { pageId } = await fixtures.seedPage();
    const user = await seedUser(models);

    const doc = await materialise(docBaseRevisions, pageId);
    doc.getText(CONTENT_FIELD).insert(0, 'real content');
    const r1 = await flow.executeSave({ pageId, userId: user._id.toString(), document: doc });
    const beforeRevision = (await Page().findById(pageId).exec()).currentRevision.toString();
    expect(beforeRevision).toBe(r1.revisionId);

    // Simulate an out-of-band save: another revision is created and the
    // page pointer is moved to it WITHOUT advancing this doc's base. The
    // server doc is now stale relative to the live page.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Revision = models.Revision as any;
    const httpRevision = await Revision.create({ path: '/x', body: 'HTTP edit', author: user._id, format: 'markdown' });
    await Page()
      .updateOne({ _id: pageId }, { $set: { revision: httpRevision._id, currentRevision: httpRevision._id } })
      .exec();

    // The server doc still believes its base is r1, so its next save would
    // clobber the HTTP edit — reject CONFLICT, page untouched.
    doc.getText(CONTENT_FIELD).insert(doc.getText(CONTENT_FIELD).length, ' (stale overwrite)');
    await expect(flow.executeSave({ pageId, userId: user._id.toString(), document: doc })).rejects.toMatchObject({
      code: 'CONFLICT',
      name: 'CollabSaveError',
    });

    const page = await Page().findById(pageId).exec();
    expect(page.currentRevision.toString()).toBe(httpRevision._id.toString());
    expect(page.revision.toString()).toBe(httpRevision._id.toString());
  });

  test('A1: the compare-and-set pointer write keeps revision === currentRevision even when the CAS loses', async () => {
    // Two saves race past the early read. The CAS pointer write lets exactly
    // one win; the loser is rejected (its Revision stays in history,
    // unreferenced). Either way the two pointers are bumped together and
    // never diverge. We simulate the race by moving currentRevision out from
    // under the second save BETWEEN its early read and its pointer write —
    // here, by issuing a competing save in the middle.
    const docBaseRevisions = createDocBaseRevisionStore();
    const flow = createSaveFlow({ models, contributorsTracker: createContributorsTracker(), pageEventPublisher: makeMockPublisher(), docBaseRevisions });
    const { pageId } = await fixtures.seedPage();
    const user = await seedUser(models);

    const doc = await materialise(docBaseRevisions, pageId);
    doc.getText(CONTENT_FIELD).insert(0, 'base content for the CAS race');
    await flow.executeSave({ pageId, userId: user._id.toString(), document: doc });

    // Tamper the in-store base so the next save's CAS filter no longer
    // matches the live pointer (= a lost CAS). The save must reject CONFLICT
    // and leave both pointers consistent.
    docBaseRevisions.set(pageId, new Types.ObjectId().toString());
    doc.getText(CONTENT_FIELD).insert(doc.getText(CONTENT_FIELD).length, ' more');
    await expect(flow.executeSave({ pageId, userId: user._id.toString(), document: doc })).rejects.toMatchObject({ code: 'CONFLICT' });

    const page = await Page().findById(pageId).exec();
    expect(page.revision.toString()).toBe(page.currentRevision.toString());
  });

  test('Decision 2 / C1: a legitimate large deletion persists durably in yjsState (not just 1h-TTL rows)', async () => {
    // A user save is explicit intent — a large deletion to a few chars is
    // legitimate and must persist (revision committed + yjsState written),
    // so it survives a reload and >1h idle (no TTL-row dependency).
    const docBaseRevisions = createDocBaseRevisionStore();
    const flow = createSaveFlow({ models, contributorsTracker: createContributorsTracker(), pageEventPublisher: makeMockPublisher(), docBaseRevisions });
    const { pageId } = await fixtures.seedPage();
    const user = await seedUser(models);

    const doc = await materialise(docBaseRevisions, pageId);
    doc.getText(CONTENT_FIELD).insert(0, 'a substantial amount of real content that the user then deliberately trims down');
    await flow.executeSave({ pageId, userId: user._id.toString(), document: doc });
    expect((await Page().findById(pageId).exec()).yjsState).toBeTruthy();

    // The user trims the doc to a single char — a legitimate deletion.
    doc.getText(CONTENT_FIELD).delete(1, doc.getText(CONTENT_FIELD).length - 1);
    const r2 = await flow.executeSave({ pageId, userId: user._id.toString(), document: doc });

    const page = await Page().findById(pageId).exec();
    expect(page.currentRevision.toString()).toBe(r2.revisionId);
    // The deletion is durable in yjsState (decodes to the trimmed text),
    // NOT parked in TTL'd PageYjsUpdate rows.
    const replay = new Y.Doc();
    Y.applyUpdate(replay, new Uint8Array(page.yjsState as Buffer));
    expect(replay.getText(CONTENT_FIELD).length).toBe(1);
    // The revision body matches the deletion too.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Revision = models.Revision as any;
    const rev = await Revision.findById(r2.revisionId).lean().exec();
    expect(rev.body.length).toBe(1);
  });

  test('Decision 2: clearing down to minimal content is ALLOWED (no spurious CONFLICT, no empty-overwrite)', async () => {
    // Round 2 removes the artificial empty-over-nonempty CONFLICT the
    // anti-shrink guard used to throw on the SAVE path — a user trimming the
    // page is explicit intent. (A LITERALLY-empty body is independently
    // rejected by the Revision model's `body: required` constraint, which
    // predates this feature and applies to every save path; that surfaces as
    // a DB_ERROR, NOT a silent empty overwrite — see the next test.) Trimming
    // to a single char must just work.
    const docBaseRevisions = createDocBaseRevisionStore();
    const flow = createSaveFlow({ models, contributorsTracker: createContributorsTracker(), pageEventPublisher: makeMockPublisher(), docBaseRevisions });
    const { pageId } = await fixtures.seedPage();
    const user = await seedUser(models);

    const doc = await materialise(docBaseRevisions, pageId);
    doc.getText(CONTENT_FIELD).insert(0, 'content that the user will now intentionally trim to almost nothing');
    await flow.executeSave({ pageId, userId: user._id.toString(), document: doc });

    // Trim to a single char — allowed, no CONFLICT.
    doc.getText(CONTENT_FIELD).delete(1, doc.getText(CONTENT_FIELD).length - 1);
    const cleared = await flow.executeSave({ pageId, userId: user._id.toString(), document: doc });

    const page = await Page().findById(pageId).exec();
    expect(page.currentRevision.toString()).toBe(cleared.revisionId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Revision = models.Revision as any;
    const rev = await Revision.findById(cleared.revisionId).lean().exec();
    expect(rev.body.length).toBe(1);
  });

  test('Decision 2: a fully-empty body is rejected by the model as DB_ERROR (no silent empty overwrite, page untouched)', async () => {
    // A literally-empty Revision body fails the model's `body: required`
    // validation. The save flow surfaces that as DB_ERROR (the client may
    // retry / keep the text in its recovery buffer); critically the page
    // pointer is NOT moved, so an empty body never overwrites real content.
    const docBaseRevisions = createDocBaseRevisionStore();
    const flow = createSaveFlow({ models, contributorsTracker: createContributorsTracker(), pageEventPublisher: makeMockPublisher(), docBaseRevisions });
    const { pageId } = await fixtures.seedPage();
    const user = await seedUser(models);

    const doc = await materialise(docBaseRevisions, pageId);
    doc.getText(CONTENT_FIELD).insert(0, 'real content that must survive a failed empty save');
    const r1 = await flow.executeSave({ pageId, userId: user._id.toString(), document: doc });

    doc.getText(CONTENT_FIELD).delete(0, doc.getText(CONTENT_FIELD).length);
    await expect(flow.executeSave({ pageId, userId: user._id.toString(), document: doc })).rejects.toMatchObject({
      code: 'DB_ERROR',
      name: 'CollabSaveError',
    });

    const page = await Page().findById(pageId).exec();
    expect(page.currentRevision.toString()).toBe(r1.revisionId);
    expect(page.revision.toString()).toBe(r1.revisionId);
  });

  test('Decision 2 / C3: a baseline read failure REJECTS the save (never commits blindly)', async () => {
    // The safety requirement: if we can't read the previous body to verify
    // the save, we must reject (DB_ERROR → client retries), never degrade to
    // a no-op that lets a possibly-empty body through. We make
    // `Revision.findById(...).select('body')` throw for the baseline read.
    const docBaseRevisions = createDocBaseRevisionStore();
    const flow = createSaveFlow({ models, contributorsTracker: createContributorsTracker(), pageEventPublisher: makeMockPublisher(), docBaseRevisions });
    const { pageId } = await fixtures.seedPage();
    const user = await seedUser(models);

    const doc = await materialise(docBaseRevisions, pageId);
    doc.getText(CONTENT_FIELD).insert(0, 'real content that must not be lost on a flaky DB');
    const r1 = await flow.executeSave({ pageId, userId: user._id.toString(), document: doc });
    const revisionCountBefore = await models.Revision.countDocuments({}).exec();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Revision = models.Revision as any;
    const originalFindById = Revision.findById.bind(Revision);
    const spy = jest.spyOn(Revision, 'findById').mockImplementation((id: unknown) => {
      // Only the baseline read (current revision = r1) should blow up; let
      // any other findById pass through.
      if (String(id) === r1.revisionId) {
        return { select: () => ({ lean: () => ({ exec: () => Promise.reject(new Error('simulated DB outage')) }) }) };
      }
      return originalFindById(id);
    });

    try {
      doc.getText(CONTENT_FIELD).insert(doc.getText(CONTENT_FIELD).length, ' appended');
      await expect(flow.executeSave({ pageId, userId: user._id.toString(), document: doc })).rejects.toMatchObject({
        code: 'DB_ERROR',
        name: 'CollabSaveError',
      });
    } finally {
      spy.mockRestore();
    }

    // No revision committed; the page still points at the real content.
    const revisionCountAfter = await models.Revision.countDocuments({}).exec();
    expect(revisionCountAfter).toBe(revisionCountBefore);
    const page = await Page().findById(pageId).exec();
    expect(page.currentRevision.toString()).toBe(r1.revisionId);
  });

  test('a normal-sized save persists its yjsState', async () => {
    const docBaseRevisions = createDocBaseRevisionStore();
    const flow = createSaveFlow({ models, contributorsTracker: createContributorsTracker(), pageEventPublisher: makeMockPublisher(), docBaseRevisions });
    const { pageId } = await fixtures.seedPage();
    const user = await seedUser(models);

    const doc = await materialise(docBaseRevisions, pageId);
    doc.getText(CONTENT_FIELD).insert(0, 'first version of the content with enough length to matter');
    await flow.executeSave({ pageId, userId: user._id.toString(), document: doc });

    doc.getText(CONTENT_FIELD).insert(doc.getText(CONTENT_FIELD).length, ' plus an appended second sentence.');
    await flow.executeSave({ pageId, userId: user._id.toString(), document: doc });

    const page = await Page().findById(pageId).exec();
    expect(page.yjsState).toBeTruthy();
    expect((page.yjsState as Buffer).length).toBeGreaterThan(0);
  });
});
