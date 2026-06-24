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

  test('C3 (round 3): the save path no longer reads the previous body, so a transient Revision.findById(baseline) failure does NOT fail an otherwise-valid save', async () => {
    // Round 3 removed the dead baseline read from the save path: it only ever
    // fed `persistYjsState(..., allowShrink:true)`, and `evaluateAntiShrink`
    // returns ok on `allowShrink` BEFORE consulting the baseline — so the
    // value was discarded, yet a flaky `Revision.findById` read turned an
    // otherwise-valid save into a spurious DB_ERROR. We assert the save now
    // succeeds even when reading the *current* revision id via `findById`
    // would have thrown (empty-overwrite is independently blocked by the
    // required `Revision.body` + the client synced gate, not this read).
    const docBaseRevisions = createDocBaseRevisionStore();
    const flow = createSaveFlow({ models, contributorsTracker: createContributorsTracker(), pageEventPublisher: makeMockPublisher(), docBaseRevisions });
    const { pageId } = await fixtures.seedPage();
    const user = await seedUser(models);

    const doc = await materialise(docBaseRevisions, pageId);
    doc.getText(CONTENT_FIELD).insert(0, 'real content that must not be lost on a flaky DB');
    const r1 = await flow.executeSave({ pageId, userId: user._id.toString(), document: doc });
    const revisionCountBefore = await models.Revision.countDocuments({}).exec();

    // Make the `.select('body')` baseline-style read on r1 throw. The save
    // path no longer performs it, so the save must still succeed; any other
    // findById (e.g. an internal read that doesn't `.select('body')`) passes
    // through unchanged.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Revision = models.Revision as any;
    const originalFindById = Revision.findById.bind(Revision);
    const spy = jest.spyOn(Revision, 'findById').mockImplementation((id: unknown) => {
      if (String(id) === r1.revisionId) {
        return { select: () => ({ lean: () => ({ exec: () => Promise.reject(new Error('simulated DB outage')) }) }) };
      }
      return originalFindById(id);
    });

    let r2: { revisionId: string };
    try {
      doc.getText(CONTENT_FIELD).insert(doc.getText(CONTENT_FIELD).length, ' appended');
      r2 = await flow.executeSave({ pageId, userId: user._id.toString(), document: doc });
    } finally {
      spy.mockRestore();
    }

    // The save committed a new revision and advanced the page pointer.
    const revisionCountAfter = await models.Revision.countDocuments({}).exec();
    expect(revisionCountAfter).toBe(revisionCountBefore + 1);
    const page = await Page().findById(pageId).exec();
    expect(page.currentRevision.toString()).toBe(r2.revisionId);
    expect(page.revision.toString()).toBe(r2.revisionId);
  });

  // ---------------------------------------------------------------------
  // G2 — conditional coalesce of two concurrent SAME-doc saves.
  // ---------------------------------------------------------------------

  test('G2: a CAS-loser whose body is byte-identical to the winner returns the WINNER revisionId as save-ok (no CONFLICT)', async () => {
    // Two editors share ONE server doc (one base store). They both press
    // save at the same instant with the SAME body (they edited the same live
    // doc). The CAS lets the winner move the pointer; the loser's CAS misses.
    // Because the winner's body is identical, the loser must coalesce — it
    // returns the WINNER's revisionId and never CONFLICTs.
    const docBaseRevisions = createDocBaseRevisionStore();
    const tracker = createContributorsTracker();
    const flow = createSaveFlow({ models, contributorsTracker: tracker, pageEventPublisher: makeMockPublisher(), docBaseRevisions });
    const { pageId } = await fixtures.seedPage();
    const winnerUser = await seedUser(models);
    const loserUser = await seedUser(models);

    const doc = await materialise(docBaseRevisions, pageId);
    doc.getText(CONTENT_FIELD).insert(0, 'identical co-edited content');

    // The WINNER saves normally: pointer -> R_win, base advances to R_win,
    // body persisted = the doc's current text.
    const winner = await flow.executeSave({ pageId, userId: winnerUser._id.toString(), document: doc });
    const pageAfterWin = await Page().findById(pageId).exec();
    expect(pageAfterWin.currentRevision.toString()).toBe(winner.revisionId);

    // Now the loser's save races: it read the page when it still pointed at
    // the pre-winner base, so its CAS pointer write misses. We reproduce the
    // post-race state by forcing the loser's CAS pointer write (the updateOne
    // whose filter carries `currentRevision`) to report matchedCount: 0 while
    // the real DB already reflects the winner (identical body). The coalesce
    // path must then return the winner's revisionId.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Page2 = models.Page as any;
    const realUpdateOne = Page2.updateOne.bind(Page2);
    const spy = jest.spyOn(Page2, 'updateOne').mockImplementation((...args: unknown[]) => {
      const filter = args[0] as Record<string, unknown>;
      if (filter && Object.prototype.hasOwnProperty.call(filter, 'currentRevision')) {
        // The lost CAS — pretend the pointer moved out from under us.
        return { exec: async () => ({ matchedCount: 0 }) };
      }
      return realUpdateOne(...args);
    });

    let result: { revisionId: string };
    try {
      // The loser snapshots the SAME doc (identical body) and saves.
      result = await flow.executeSave({ pageId, userId: loserUser._id.toString(), document: doc });
    } finally {
      spy.mockRestore();
    }

    // The loser coalesced into the winner — same revisionId, no CONFLICT.
    expect(result.revisionId).toBe(winner.revisionId);
    const page = await Page().findById(pageId).exec();
    expect(page.currentRevision.toString()).toBe(winner.revisionId);
    expect(page.revision.toString()).toBe(winner.revisionId);

    // Best-effort: the loser's trigger user was folded into the winner
    // revision's contributors.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Revision = models.Revision as any;
    const winnerRev = await Revision.findById(winner.revisionId).lean().exec();
    expect((winnerRev.contributors ?? []).map((id: Types.ObjectId) => id.toString())).toContain(loserUser._id.toString());
  });

  test('G2: a CAS-loser whose body DIFFERS from the winner keeps CONFLICT (no coalesce)', async () => {
    const docBaseRevisions = createDocBaseRevisionStore();
    const flow = createSaveFlow({ models, contributorsTracker: createContributorsTracker(), pageEventPublisher: makeMockPublisher(), docBaseRevisions });
    const { pageId } = await fixtures.seedPage();
    const winnerUser = await seedUser(models);
    const loserUser = await seedUser(models);

    const doc = await materialise(docBaseRevisions, pageId);
    doc.getText(CONTENT_FIELD).insert(0, 'the winner body');
    const winner = await flow.executeSave({ pageId, userId: winnerUser._id.toString(), document: doc });

    // The loser is about to save a DIFFERENT body. Force its CAS to miss; the
    // winner's persisted body differs, so coalesce must be refused → CONFLICT.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Page2 = models.Page as any;
    const realUpdateOne = Page2.updateOne.bind(Page2);
    const spy = jest.spyOn(Page2, 'updateOne').mockImplementation((...args: unknown[]) => {
      const filter = args[0] as Record<string, unknown>;
      if (filter && Object.prototype.hasOwnProperty.call(filter, 'currentRevision')) {
        return { exec: async () => ({ matchedCount: 0 }) };
      }
      return realUpdateOne(...args);
    });

    try {
      // A different body than the winner's.
      doc.getText(CONTENT_FIELD).insert(doc.getText(CONTENT_FIELD).length, ' + the loser typed something else');
      await expect(flow.executeSave({ pageId, userId: loserUser._id.toString(), document: doc })).rejects.toMatchObject({ code: 'CONFLICT' });
    } finally {
      spy.mockRestore();
    }

    // The page still points at the winner; nothing clobbered.
    const page = await Page().findById(pageId).exec();
    expect(page.currentRevision.toString()).toBe(winner.revisionId);
  });

  test('G2: an out-of-band Page.updatePage that moved currentRevision is NEVER coalesced (CONFLICT)', async () => {
    // The danger case: an EXTERNAL edit (HTTP / other instance / CLI) moved
    // the pointer. Even if its body happened to equal the loser's body, the
    // in-process doc base did NOT advance to it (only a same-process collab
    // save advances the base), so coalesce condition 1 fails → CONFLICT. This
    // is what keeps coalesce from masking a genuine external divergence.
    const docBaseRevisions = createDocBaseRevisionStore();
    const flow = createSaveFlow({ models, contributorsTracker: createContributorsTracker(), pageEventPublisher: makeMockPublisher(), docBaseRevisions });
    const { pageId } = await fixtures.seedPage();
    const user = await seedUser(models);

    const doc = await materialise(docBaseRevisions, pageId);
    doc.getText(CONTENT_FIELD).insert(0, 'identical content body');
    const r1 = await flow.executeSave({ pageId, userId: user._id.toString(), document: doc });

    // An out-of-band save moves currentRevision to a NEW revision whose body
    // is byte-identical to what the doc holds — but it does NOT advance the
    // in-process base (the base still equals r1, the live pointer is now the
    // external revision). The early divergence check fires CONFLICT before we
    // even reach the CAS; coalesce never runs on an external move.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Revision = models.Revision as any;
    const externalRev = await Revision.create({ path: '/x2', body: 'identical content body', author: user._id, format: 'markdown' });
    await Page()
      .updateOne({ _id: pageId }, { $set: { revision: externalRev._id, currentRevision: externalRev._id } })
      .exec();

    await expect(flow.executeSave({ pageId, userId: user._id.toString(), document: doc })).rejects.toMatchObject({ code: 'CONFLICT' });

    // The doc base still holds r1 (never advanced to the external revision),
    // proving the coalesce guard would have rejected it too.
    expect(docBaseRevisions.get(pageId)).toBe(r1.revisionId);
    const page = await Page().findById(pageId).exec();
    expect(page.currentRevision.toString()).toBe(externalRev._id.toString());
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
