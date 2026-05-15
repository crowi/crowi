import * as Y from 'yjs';
import { Types } from 'mongoose';
import type { CollabModels } from '../models';
import { createContributorsTracker } from '../contributors';
import { createSaveFlow, CollabSaveError } from '../save-flow';
import { startInMemoryMongo, registerTestModels, type SmokeMongo } from './setup';
import { makeFixtures, type CollabFixtures } from './fixtures';
import { CONTENT_FIELD } from '../yjs-doc';
import type { CollabPageEventPublisher } from '../types';

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
    const flow = createSaveFlow({ models, contributorsTracker: tracker, pageEventPublisher: publisher });

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
    const flow = createSaveFlow({ models, contributorsTracker: tracker, pageEventPublisher: publisher });

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
    const flow = createSaveFlow({ models, contributorsTracker: tracker, pageEventPublisher: publisher });

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
    const flow = createSaveFlow({ models, contributorsTracker: tracker, pageEventPublisher: publisher });

    const { pageId } = await fixtures.seedPage();
    const doc = new Y.Doc();
    doc.getText(CONTENT_FIELD).insert(0, 'body');

    const ghostUserId = new Types.ObjectId().toString();
    await expect(flow.executeSave({ pageId, userId: ghostUserId, document: doc })).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
  });

  test('page not found throws CollabSaveError code=PAGE_NOT_FOUND', async () => {
    const tracker = createContributorsTracker();
    const publisher = makeMockPublisher();
    const flow = createSaveFlow({ models, contributorsTracker: tracker, pageEventPublisher: publisher });

    const user = await seedUser(models);
    const doc = new Y.Doc();
    doc.getText(CONTENT_FIELD).insert(0, 'body');

    const ghostPageId = new Types.ObjectId().toString();
    await expect(flow.executeSave({ pageId: ghostPageId, userId: user._id.toString(), document: doc })).rejects.toMatchObject({ code: 'PAGE_NOT_FOUND' });
  });

  test('two saves in a row produce two distinct Revisions and Page.currentRevision tracks the latest', async () => {
    const tracker = createContributorsTracker();
    const publisher = makeMockPublisher();
    const flow = createSaveFlow({ models, contributorsTracker: tracker, pageEventPublisher: publisher });

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

  test('CollabSaveError is exported as a real Error subclass (instanceof works)', async () => {
    // Quick sanity check — the on-stateless handler depends on
    // `err instanceof CollabSaveError` for code-narrowing.
    const err = new CollabSaveError('READONLY', 'nope');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CollabSaveError);
    expect(err.code).toBe('READONLY');
  });
});
