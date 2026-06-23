import * as Y from 'yjs';
import { Types } from 'mongoose';
import type { CollabModels } from '../models';
import { createContributorsTracker } from '../contributors';
import { createSaveFlow } from '../save-flow';
import { createDocBaseRevisionStore, type DocBaseRevisionStore } from '../doc-base-revision';
import { createOnLoadDocument } from '../hooks/on-load-document';
import { createInvalidatedPagesStore, createPageInvalidator, INVALIDATED_DOC_BASE, type InvalidatedPagesStore } from '../invalidation';
import { startInMemoryMongo, registerTestModels, type SmokeMongo } from './setup';
import { makeFixtures, type CollabFixtures } from './fixtures';
import { CONTENT_FIELD } from '../yjs-doc';
import type { CollabPageEventPublisher } from '../types';

/**
 * feature-editor-preview-reliability G1 — external-edit invalidation of a
 * live collab doc (single-instance). Verifies:
 *   - an external edit on a page with a live doc broadcasts crowi:force-reload
 *     AND a reconnect re-materialises from the NEW revision body (not the
 *     stale doc);
 *   - while one connection delays its reload, a NEW connection during the
 *     drain does NOT re-attach to / re-record the stale doc base (tombstone
 *     holds), so an in-flight stale save still CONFLICTs;
 *   - the doc base is tombstoned so an old-base save after an external edit
 *     CONFLICTs.
 */

const makeMockPublisher = (): CollabPageEventPublisher => ({ async publish() {} });

const seedUser = async (models: CollabModels) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const User = models.User as any;
  return User.create({
    email: `inval-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    username: `iu${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
    name: 'Invalidation User',
    status: 2,
  });
};

/** A minimal Hocuspocus `Document` stand-in tracking broadcasts. */
interface FakeDoc {
  name: string;
  broadcasts: string[];
  broadcastStateless(payload: string): void;
}

/** A minimal Hocuspocus engine stand-in with `documents` + `closeConnections`. */
interface FakeInstance {
  documents: Map<string, FakeDoc>;
  closedDocs: string[];
  closeConnections(documentName?: string): void;
}

const makeFakeDoc = (name: string): FakeDoc => {
  const broadcasts: string[] = [];
  return {
    name,
    broadcasts,
    broadcastStateless(payload) {
      broadcasts.push(payload);
    },
  };
};

const makeFakeInstance = (): FakeInstance => {
  const documents = new Map<string, FakeDoc>();
  const closedDocs: string[] = [];
  return {
    documents,
    closedDocs,
    closeConnections(documentName) {
      if (documentName) {
        closedDocs.push(documentName);
        documents.delete(documentName);
      }
    },
  };
};

describe('external-edit invalidation (G1)', () => {
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
  const Revision = () => models.Revision as any;

  /** Materialise a server doc via onLoadDocument so its base is recorded. */
  const materialise = async (docBaseRevisions: DocBaseRevisionStore, invalidatedPages: InvalidatedPagesStore, pageId: string): Promise<Y.Doc> => {
    const onLoadDocument = createOnLoadDocument({
      models: { Page: models.Page, Revision: models.Revision, PageYjsUpdate: models.PageYjsUpdate },
      docBaseRevisions,
      invalidatedPages,
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

  /** Simulate an external `Page.updatePage`: new revision, bump pointer, null yjsState. */
  const externalEdit = async (pageId: string, body: string, authorId: Types.ObjectId): Promise<string> => {
    const page = await Page().findById(pageId).exec();
    const rev = await Revision().create({ path: page.path, body, author: authorId, format: 'markdown' });
    await Page()
      .updateOne({ _id: pageId }, { $set: { revision: rev._id, currentRevision: rev._id, yjsState: null, yjsCheckpointAt: null } })
      .exec();
    return rev._id.toString();
  };

  test('broadcasts crowi:force-reload AND a reconnect re-materialises the NEW revision body', async () => {
    const docBaseRevisions = createDocBaseRevisionStore();
    const invalidatedPages = createInvalidatedPagesStore();
    const flow = createSaveFlow({ models, contributorsTracker: createContributorsTracker(), pageEventPublisher: makeMockPublisher(), docBaseRevisions });
    const { pageId } = await fixtures.seedPage();
    const user = await seedUser(models);

    // A live collab session: materialise + save so the page has a yjsState
    // and the doc base is r1.
    const doc = await materialise(docBaseRevisions, invalidatedPages, pageId);
    doc.getText(CONTENT_FIELD).insert(0, 'collab content');
    await flow.executeSave({ pageId, userId: user._id.toString(), document: doc });
    expect((await Page().findById(pageId).exec()).yjsState).toBeTruthy();

    // The live doc is registered with the engine. Capture the reference now:
    // the invalidator detaches the doc from `instance.documents` synchronously
    // (Blocker 1) so a reconnect during the drain can't re-attach to it, so we
    // assert the broadcast on the captured reference rather than re-fetching
    // via `documents.get` (which is undefined post-detach).
    const instance = makeFakeInstance();
    const liveFake = makeFakeDoc(pageId);
    instance.documents.set(pageId, liveFake);

    // An external edit lands (HTTP / MCP path): new body, pointer moved,
    // yjsState nulled.
    const newRevId = await externalEdit(pageId, 'EXTERNAL EDIT BODY — the canonical new content', user._id);

    // Drive the invalidator synchronously (test scheduler).
    const drains: Array<() => void> = [];
    const invalidator = createPageInvalidator({
      instance,
      docBaseRevisions,
      invalidatedPages,
      graceMs: 50,
      schedule: (fn) => drains.push(fn),
    });
    await invalidator.invalidatePages([pageId], 'page-body-replaced');

    // (a) force-reload was broadcast to the live connections (asserted on the
    // captured reference — the invalidator detached it from the registry).
    expect(liveFake.broadcasts).toHaveLength(1);
    expect(JSON.parse(liveFake.broadcasts[0])).toMatchObject({ kind: 'crowi:force-reload', reason: 'page-body-replaced' });
    // The stale doc was synchronously detached so a reconnect re-materialises.
    expect(instance.documents.has(pageId)).toBe(false);

    // (b) the doc base is tombstoned (an in-flight stale save would CONFLICT).
    expect(docBaseRevisions.get(pageId)).toBe(INVALIDATED_DOC_BASE);

    // Run the drain (force-close): the stale doc is dropped from the engine.
    drains.forEach((fn) => fn());
    expect(instance.closedDocs).toContain(pageId);
    expect(invalidatedPages.isInvalidating(pageId)).toBe(false);

    // (c) the reconnect re-materialises from the NEW revision body, not the
    // stale (now-null) yjsState.
    const reconnect = await materialise(docBaseRevisions, invalidatedPages, pageId);
    expect(reconnect.getText(CONTENT_FIELD).toString()).toBe('EXTERNAL EDIT BODY — the canonical new content');
    // and the doc base now tracks the external revision.
    expect(docBaseRevisions.get(pageId)).toBe(newRevId);
  });

  test('while one connection delays its reload, a NEW connection during the drain does NOT re-record the stale doc base (tombstone holds)', async () => {
    const docBaseRevisions = createDocBaseRevisionStore();
    const invalidatedPages = createInvalidatedPagesStore();
    const flow = createSaveFlow({ models, contributorsTracker: createContributorsTracker(), pageEventPublisher: makeMockPublisher(), docBaseRevisions });
    const { pageId } = await fixtures.seedPage();
    const user = await seedUser(models);

    const doc = await materialise(docBaseRevisions, invalidatedPages, pageId);
    doc.getText(CONTENT_FIELD).insert(0, 'two editors are here');
    await flow.executeSave({ pageId, userId: user._id.toString(), document: doc });

    const instance = makeFakeInstance();
    instance.documents.set(pageId, makeFakeDoc(pageId));

    await externalEdit(pageId, 'external body that wins', user._id);

    // Hold the drain open (do NOT run the scheduled close yet) so we are in
    // the window where one client lingers on the stale doc.
    const invalidator = createPageInvalidator({
      instance,
      docBaseRevisions,
      invalidatedPages,
      graceMs: 5000,
      schedule: () => {
        /* hold — never fire during this test */
      },
    });
    await invalidator.invalidatePages([pageId], 'page-body-replaced');
    expect(invalidatedPages.isInvalidating(pageId)).toBe(true);

    // A NEW connection arrives DURING the drain. Its onLoadDocument must NOT
    // overwrite the sentinel base (which would let a racing save match the
    // advanced pointer and clobber the external edit).
    const newConn = await materialise(docBaseRevisions, invalidatedPages, pageId);
    // The base is STILL the tombstone (not the external revision).
    expect(docBaseRevisions.get(pageId)).toBe(INVALIDATED_DOC_BASE);
    // The new connection still sees the correct (external) body, because the
    // external write nulled yjsState so it re-materialises from the body.
    expect(newConn.getText(CONTENT_FIELD).toString()).toBe('external body that wins');

    // An in-flight stale save during the drain CONFLICTs (base is the
    // tombstone, can never match the live pointer).
    doc.getText(CONTENT_FIELD).insert(doc.getText(CONTENT_FIELD).length, ' stale append');
    await expect(flow.executeSave({ pageId, userId: user._id.toString(), document: doc })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  test('the tombstoned doc base makes an old-base save after an external edit CONFLICT', async () => {
    const docBaseRevisions = createDocBaseRevisionStore();
    const invalidatedPages = createInvalidatedPagesStore();
    const flow = createSaveFlow({ models, contributorsTracker: createContributorsTracker(), pageEventPublisher: makeMockPublisher(), docBaseRevisions });
    const { pageId } = await fixtures.seedPage();
    const user = await seedUser(models);

    const doc = await materialise(docBaseRevisions, invalidatedPages, pageId);
    doc.getText(CONTENT_FIELD).insert(0, 'original content');
    await flow.executeSave({ pageId, userId: user._id.toString(), document: doc });

    const instance = makeFakeInstance();
    instance.documents.set(pageId, makeFakeDoc(pageId));
    const externalRevId = await externalEdit(pageId, 'wholly different external content', user._id);

    const invalidator = createPageInvalidator({
      instance,
      docBaseRevisions,
      invalidatedPages,
      graceMs: 50,
      schedule: () => {
        /* hold so the tombstone stays for the assertion */
      },
    });
    await invalidator.invalidatePages([pageId], 'page-body-replaced');

    // The stale doc tries to save its old content — must CONFLICT (the
    // tombstone base can never match the external currentRevision).
    doc.getText(CONTENT_FIELD).insert(doc.getText(CONTENT_FIELD).length, ' + stale local edit');
    await expect(flow.executeSave({ pageId, userId: user._id.toString(), document: doc })).rejects.toMatchObject({ code: 'CONFLICT' });

    // The external edit is untouched (the page still points at it).
    const page = await Page().findById(pageId).exec();
    expect(page.currentRevision.toString()).toBe(externalRevId);
  });

  test('invalidating a page with NO active doc is a no-op (clears the tombstone immediately)', async () => {
    const docBaseRevisions = createDocBaseRevisionStore();
    const invalidatedPages = createInvalidatedPagesStore();
    const { pageId } = await fixtures.seedPage();

    const instance = makeFakeInstance(); // no documents registered
    const invalidator = createPageInvalidator({ instance, docBaseRevisions, invalidatedPages, graceMs: 50 });
    await invalidator.invalidatePages([pageId], 'page-body-replaced');

    // No live doc → nothing to drain; the tombstone is cleared right away so
    // the next connection records a real base normally.
    expect(invalidatedPages.isInvalidating(pageId)).toBe(false);
    expect(instance.closedDocs).toHaveLength(0);
  });
});
