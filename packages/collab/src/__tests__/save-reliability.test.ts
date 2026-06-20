import * as Y from 'yjs';
import { Types } from 'mongoose';
import type { CollabModels } from '../models';
import { createContributorsTracker } from '../contributors';
import { createSaveFlow } from '../save-flow';
import { startInMemoryMongo, registerTestModels, type SmokeMongo } from './setup';
import { makeFixtures, type CollabFixtures } from './fixtures';
import { CONTENT_FIELD } from '../yjs-doc';
import type { CollabPageEventPublisher } from '../types';

/**
 * editor-preview-reliability tests for the save flow:
 *   - §1A optimistic lock: a stale `baseRevisionId` is rejected with
 *     CONFLICT and the page is left untouched (no stale overwrite).
 *   - §1B anti-shrink: an empty live doc never persists an empty
 *     `yjsState` over a non-empty revision body.
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

describe('save-flow reliability (editor-preview-reliability §1A/§1B)', () => {
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

  test('§1A: a save whose baseRevisionId matches the live currentRevision succeeds', async () => {
    const flow = createSaveFlow({ models, contributorsTracker: createContributorsTracker(), pageEventPublisher: makeMockPublisher() });
    const { pageId } = await fixtures.seedPage();
    const user = await seedUser(models);

    const doc = new Y.Doc();
    doc.getText(CONTENT_FIELD).insert(0, 'v1 body');
    const r1 = await flow.executeSave({ pageId, userId: user._id.toString(), document: doc });

    // Second save pins base = r1 (the now-current revision) → accepted.
    doc.getText(CONTENT_FIELD).insert(doc.getText(CONTENT_FIELD).length, ' + more');
    const r2 = await flow.executeSave({ pageId, userId: user._id.toString(), document: doc, baseRevisionId: r1.revisionId });
    expect(r2.revisionId).not.toBe(r1.revisionId);
    const page = await Page().findById(pageId).exec();
    expect(page.currentRevision.toString()).toBe(r2.revisionId);
  });

  test('§1A: a save with a stale baseRevisionId is rejected with CONFLICT and leaves the page untouched', async () => {
    const flow = createSaveFlow({ models, contributorsTracker: createContributorsTracker(), pageEventPublisher: makeMockPublisher() });
    const { pageId } = await fixtures.seedPage();
    const user = await seedUser(models);

    const doc = new Y.Doc();
    doc.getText(CONTENT_FIELD).insert(0, 'real content');
    const r1 = await flow.executeSave({ pageId, userId: user._id.toString(), document: doc });

    const staleBase = new Types.ObjectId().toString();
    const beforeRevision = (await Page().findById(pageId).exec()).currentRevision.toString();

    const stale = new Y.Doc();
    stale.getText(CONTENT_FIELD).insert(0, 'OVERWRITE FROM STALE REPLICA');
    await expect(flow.executeSave({ pageId, userId: user._id.toString(), document: stale, baseRevisionId: staleBase })).rejects.toMatchObject({
      code: 'CONFLICT',
      name: 'CollabSaveError',
    });

    // Page revision pointer + body are untouched — the stale save did
    // not clobber the real content.
    const page = await Page().findById(pageId).exec();
    expect(page.currentRevision.toString()).toBe(beforeRevision);
    expect(beforeRevision).toBe(r1.revisionId);
  });

  test('§1A: an omitted baseRevisionId disables the lock (legacy client still saves)', async () => {
    const flow = createSaveFlow({ models, contributorsTracker: createContributorsTracker(), pageEventPublisher: makeMockPublisher() });
    const { pageId } = await fixtures.seedPage();
    const user = await seedUser(models);

    const doc = new Y.Doc();
    doc.getText(CONTENT_FIELD).insert(0, 'first');
    await flow.executeSave({ pageId, userId: user._id.toString(), document: doc });

    // No baseRevisionId at all → the lock is skipped even though
    // currentRevision is now set.
    doc.getText(CONTENT_FIELD).insert(doc.getText(CONTENT_FIELD).length, ' second');
    const r2 = await flow.executeSave({ pageId, userId: user._id.toString(), document: doc });
    expect(r2.revisionId).toMatch(/^[0-9a-f]{24}$/);
  });

  test('§1B/C2: a heavily-shrunk but non-empty user save IS persisted (explicit intent, ratio arm bypassed)', async () => {
    // Principle (post fix-round): a user save is explicit intent, already
    // protected by the §1A optimistic lock + §2 synced gate, so the
    // anti-shrink *ratio* arm must NOT block a legitimate large deletion.
    // Only an EMPTY save over non-empty content is rejected (the next
    // test). A heavily-shrunk-but-non-empty save therefore succeeds and
    // persists its yjsState.
    const flow = createSaveFlow({ models, contributorsTracker: createContributorsTracker(), pageEventPublisher: makeMockPublisher() });
    const { pageId } = await fixtures.seedPage();
    const user = await seedUser(models);

    const doc = new Y.Doc();
    doc.getText(CONTENT_FIELD).insert(0, 'a substantial amount of real content that the user then deliberately trims');
    const r1 = await flow.executeSave({ pageId, userId: user._id.toString(), document: doc });
    expect((await Page().findById(pageId).exec()).yjsState).toBeTruthy();

    // The user intentionally trims the doc to a single char. This is a
    // legitimate deletion — it must persist (revision committed + yjsState
    // written), not be blocked.
    const shrunk = new Y.Doc();
    shrunk.getText(CONTENT_FIELD).insert(0, 'x');
    const r2 = await flow.executeSave({ pageId, userId: user._id.toString(), document: shrunk, baseRevisionId: r1.revisionId });

    const page = await Page().findById(pageId).exec();
    expect(page.currentRevision.toString()).toBe(r2.revisionId);
    expect(page.yjsState).toBeTruthy();
    expect((page.yjsState as Buffer).length).toBeGreaterThan(0);
  });

  test('§1B/C2: an EMPTY save over non-empty content is rejected with CONFLICT BEFORE any revision is committed', async () => {
    // C2 regression: the pre-fix code committed the empty body as a new
    // Revision FIRST, then suppressed only the yjsState mirror — so
    // "rebuild from body on next load" rebuilt from the EMPTY body and the
    // content was lost. The fix evaluates the empty-doc guard BEFORE
    // `prepareRevision` and throws CONFLICT, so NO empty revision is ever
    // committed and the client reloads (recovery buffer restores the text).
    const flow = createSaveFlow({ models, contributorsTracker: createContributorsTracker(), pageEventPublisher: makeMockPublisher() });
    const { pageId } = await fixtures.seedPage();
    const user = await seedUser(models);

    const doc = new Y.Doc();
    doc.getText(CONTENT_FIELD).insert(0, 'real content that must not be silently cleared');
    const r1 = await flow.executeSave({ pageId, userId: user._id.toString(), document: doc });
    const revisionCountBefore = await models.Revision.countDocuments({}).exec();

    // A desynced/empty live doc save.
    const empty = new Y.Doc();
    await expect(flow.executeSave({ pageId, userId: user._id.toString(), document: empty, baseRevisionId: r1.revisionId })).rejects.toMatchObject({
      code: 'CONFLICT',
      name: 'CollabSaveError',
    });

    // No new (empty) revision was committed, and currentRevision + body
    // still point at the real content.
    const revisionCountAfter = await models.Revision.countDocuments({}).exec();
    expect(revisionCountAfter).toBe(revisionCountBefore);
    const page = await Page().findById(pageId).exec();
    expect(page.currentRevision.toString()).toBe(r1.revisionId);
    const rev = await models.Revision.findById(page.currentRevision).exec();
    expect(rev?.body).toBe('real content that must not be silently cleared');
  });

  test('§1B: a normal-sized save persists its yjsState (guard is a no-op)', async () => {
    const flow = createSaveFlow({ models, contributorsTracker: createContributorsTracker(), pageEventPublisher: makeMockPublisher() });
    const { pageId } = await fixtures.seedPage();
    const user = await seedUser(models);

    const doc = new Y.Doc();
    doc.getText(CONTENT_FIELD).insert(0, 'first version of the content with enough length to matter');
    const r1 = await flow.executeSave({ pageId, userId: user._id.toString(), document: doc });

    // Grow the doc — no shrink, guard is a no-op, yjsState persists.
    doc.getText(CONTENT_FIELD).insert(doc.getText(CONTENT_FIELD).length, ' plus an appended second sentence.');
    await flow.executeSave({ pageId, userId: user._id.toString(), document: doc, baseRevisionId: r1.revisionId });

    const page = await Page().findById(pageId).exec();
    expect(page.yjsState).toBeTruthy();
    expect((page.yjsState as Buffer).length).toBeGreaterThan(0);
  });
});
