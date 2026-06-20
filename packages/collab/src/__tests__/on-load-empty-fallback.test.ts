import * as Y from 'yjs';
import mongoose from 'mongoose';
import { startInMemoryMongo, registerTestModels, type SmokeMongo } from './setup';
import type { CollabModels } from '../models';
import { createOnLoadDocument } from '../hooks/on-load-document';
import { CONTENT_FIELD } from '../yjs-doc';

/**
 * editor-preview-reliability §1C — when a stale / empty yjsState applies
 * cleanly but decodes to an empty Y.Text, and the current revision body
 * is non-empty, onLoadDocument must fall back to seeding the body rather
 * than handing the client an empty doc (which a subsequent save would
 * then persist as an empty body = content loss).
 */
describe('onLoadDocument empty-yjsState body fallback (§1C)', () => {
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

  const seedPageWithBody = async (body: string) => {
    const userId = new mongoose.Types.ObjectId();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Page = models.Page as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Revision = models.Revision as any;
    const pagePath = `/__on-load-empty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const revision = await Revision.create({ path: pagePath, body, author: userId, format: 'markdown' });
    const page = await Page.create({ path: pagePath, revision: revision._id, creator: userId, grant: 1, status: 'published' });
    return { pageId: page._id.toString() };
  };

  test('a non-empty yjsState that decodes to an empty Y.Text falls back to the revision body', async () => {
    const { pageId } = await seedPageWithBody('the canonical body that must survive a stale empty snapshot');

    // An empty-doc encode is a non-empty Buffer ([0,0]) that applies
    // cleanly but yields an empty Y.Text — exactly the stale snapshot
    // the §1C fallback protects against.
    const emptyState = Buffer.from(Y.encodeStateAsUpdate(new Y.Doc()));
    expect(emptyState.length).toBeGreaterThan(0); // sanity: not a 0-length buffer
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (models.Page as any).updateOne({ _id: pageId }, { $set: { yjsState: emptyState } }).exec();

    const onLoadDocument = createOnLoadDocument({
      models: { Page: models.Page, Revision: models.Revision, PageYjsUpdate: models.PageYjsUpdate },
    });
    const doc = new Y.Doc();
    await onLoadDocument({
      documentName: pageId,
      document: doc,
      instance: { documents: new Map() },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    expect(doc.getText(CONTENT_FIELD).toString()).toBe('the canonical body that must survive a stale empty snapshot');
  });

  test('a non-empty yjsState with real content is restored as-is (no spurious fallback)', async () => {
    const { pageId } = await seedPageWithBody('original revision body');
    const source = new Y.Doc();
    source.getText(CONTENT_FIELD).insert(0, 'live yjs content');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (models.Page as any).updateOne({ _id: pageId }, { $set: { yjsState: Buffer.from(Y.encodeStateAsUpdate(source)) } }).exec();

    const onLoadDocument = createOnLoadDocument({
      models: { Page: models.Page, Revision: models.Revision, PageYjsUpdate: models.PageYjsUpdate },
    });
    const doc = new Y.Doc();
    await onLoadDocument({
      documentName: pageId,
      document: doc,
      instance: { documents: new Map() },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    expect(doc.getText(CONTENT_FIELD).toString()).toBe('live yjs content');
  });
});
