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

  test('§1B: a heavily-shrunk live doc does NOT persist its yjsState over a much larger previous body', async () => {
    const flow = createSaveFlow({ models, contributorsTracker: createContributorsTracker(), pageEventPublisher: makeMockPublisher() });
    const { pageId } = await fixtures.seedPage();
    const user = await seedUser(models);

    // First, a real save establishes a substantial baseline body + yjsState.
    const doc = new Y.Doc();
    doc.getText(CONTENT_FIELD).insert(0, 'a substantial amount of real content that must be protected from loss by anti-shrink');
    const r1 = await flow.executeSave({ pageId, userId: user._id.toString(), document: doc });
    expect((await Page().findById(pageId).exec()).yjsState).toBeTruthy();

    // A new save whose doc has been catastrophically shrunk (~3 chars vs
    // ~85) — a classic desync artifact. The new (short) revision is
    // durable, but the yjsState write must be suppressed so the next
    // load can rebuild from the body via the repointed currentRevision.
    const shrunk = new Y.Doc();
    shrunk.getText(CONTENT_FIELD).insert(0, 'x');
    await flow.executeSave({ pageId, userId: user._id.toString(), document: shrunk, baseRevisionId: r1.revisionId });

    const page = await Page().findById(pageId).exec();
    expect(page.yjsState).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('anti-shrink rejected yjsState write'));
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
