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

  test('H4 regression: a body-seed fallback DROPS residual deltas from the abandoned lineage (no duplication)', async () => {
    // H4 was: after seeding from the revision body (empty-yjsState
    // fallback), the hook unconditionally replayed leftover PageYjsUpdate
    // deltas. Those deltas were authored against the DISCARDED yjsState
    // lineage, so applying them onto the body-seeded doc (different state
    // vector) duplicated / misplaced content. The fix drops them instead.
    const body = 'the authoritative revision body that must stand alone';
    const { pageId } = await seedPageWithBody(body);

    // Stale empty yjsState → triggers the §1C body-seed fallback.
    const emptyState = Buffer.from(Y.encodeStateAsUpdate(new Y.Doc()));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (models.Page as any).updateOne({ _id: pageId }, { $set: { yjsState: emptyState } }).exec();

    // A residual delta from an UNRELATED lineage (a fresh doc with its own
    // text). Replaying it onto the body-seeded doc would inject duplicate
    // content; the fix must drop it.
    const foreign = new Y.Doc();
    foreign.getText(CONTENT_FIELD).insert(0, 'GHOST CONTENT FROM THE ABANDONED LINEAGE');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (models.PageYjsUpdate as any).create({ pageId, payload: Buffer.from(Y.encodeStateAsUpdate(foreign)), createdAt: new Date() });

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

    // Exactly the body — no ghost content, no duplication.
    expect(doc.getText(CONTENT_FIELD).toString()).toBe(body);
    // The abandoned-lineage deltas were cleared so they can't haunt a
    // later load either.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const remaining = await (models.PageYjsUpdate as any).countDocuments({ pageId }).exec();
    expect(remaining).toBe(0);
  });

  test('C2 (round 2): when the body seed is EMPTY, residual deltas that carry the only content are NOT dropped', async () => {
    // C2 regression: the previous code dropped ALL residual deltas whenever
    // it body-seeded (any abandoned lineage). But when there is no revision
    // body to seed from (a brand-new page whose first edits never folded),
    // the body seed puts NOTHING in — the residual deltas carry the user's
    // ONLY content. Dropping them then loses that content. The fix only
    // drops deltas when the body seed actually produced content; an empty
    // seed falls through to replaying the deltas.
    const userId = new mongoose.Types.ObjectId();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Page = models.Page as any;
    const pagePath = `/__on-load-c2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // A fresh page with NO revision pointer yet — the body seed has nothing
    // to insert (the `body: required` Revision model precludes an empty-body
    // revision, so "no revision" is the realistic empty-seed case).
    const page = await Page.create({ path: pagePath, creator: userId, grant: 1, status: 'published' });
    const pageId = page._id.toString();

    // A stale empty yjsState triggers the fallback; the body seed is empty.
    const emptyState = Buffer.from(Y.encodeStateAsUpdate(new Y.Doc()));
    await Page.updateOne({ _id: pageId }, { $set: { yjsState: emptyState } }).exec();

    // A residual delta carrying the only content the user has.
    const onlyContent = new Y.Doc();
    onlyContent.getText(CONTENT_FIELD).insert(0, 'the only content the user typed before a crash');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (models.PageYjsUpdate as any).create({ pageId, payload: Buffer.from(Y.encodeStateAsUpdate(onlyContent)), createdAt: new Date() });

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

    // The delta content survived — it was NOT dropped as an abandoned
    // lineage, because the body seed put nothing in.
    expect(doc.getText(CONTENT_FIELD).toString()).toBe('the only content the user typed before a crash');
    // The rows are kept (replayed, not cleared) so a later load also works.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const remaining = await (models.PageYjsUpdate as any).countDocuments({ pageId }).exec();
    expect(remaining).toBe(1);
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
