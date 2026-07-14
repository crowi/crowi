import mongoose from 'mongoose';
import * as Y from 'yjs';
import { createDocBaseRevisionStore } from '../doc-base-revision';
import { createDocEpochStore } from '../doc-epoch';
import { createOnLoadDocument } from '../hooks/on-load-document';
import { createInvalidatedPagesStore } from '../invalidation';
import type { CollabModels } from '../models';
import { CONTENT_FIELD } from '../yjs-doc';
import { registerTestModels, type SmokeMongo, startInMemoryMongo } from './setup';

/**
 * Phase 6 onLoadDocument force-reload broadcast.
 *
 * Covers the two fallback paths (yjsState=null + Y.applyUpdate throw)
 * and the active-document presence check. The existing "happy path"
 * + "corrupt yjsState → revision body" assertions live in the Phase 3
 * smoke test; this file focuses on the new broadcast semantics.
 *
 * We synthesise a minimum `Hocuspocus` instance that exposes the
 * `documents: Map<string, Document>` field — Hocuspocus's real
 * `Document` is `extends Y.Doc & { broadcastStateless(...) }`, so a
 * `Y.Doc` decorated with a `broadcastStateless` spy is structurally
 * compatible (the hook only calls `.broadcastStateless`, not other
 * Document-specific methods).
 */

interface BroadcastSpy {
  doc: Y.Doc;
  calls: string[];
}

function makeBroadcastSpy(): BroadcastSpy {
  const doc = new Y.Doc();
  const calls: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (doc as any).broadcastStateless = (payload: string) => {
    calls.push(payload);
  };
  return { doc, calls };
}

/**
 * Build a fake Hocuspocus `instance` with a populated `documents`
 * Map. Only the fields the hook reaches into are present, so a future
 * Hocuspocus surface change lights up as a TS error at the call site.
 */
function makeInstanceWith(documentName: string | null, spy?: BroadcastSpy) {
  const docs = new Map<string, unknown>();
  if (documentName && spy) {
    docs.set(documentName, spy.doc);
  }
  return { documents: docs };
}

describe('@crowi/collab Phase 6 onLoadDocument force-reload broadcast', () => {
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
    const pagePath = `/__on-load-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const revision = await Revision.create({ path: pagePath, body, author: userId, format: 'markdown' });
    const page = await Page.create({
      path: pagePath,
      revision: revision._id,
      creator: userId,
      grant: 1,
      status: 'published',
    });
    return { pageId: page._id.toString(), pagePath };
  };

  test('yjsState=null path seeds the body WITHOUT a spurious force-reload broadcast', async () => {
    // Page.yjsState defaults to null in the schema (no checkpoint yet),
    // so creating a fresh page+revision is sufficient to exercise the
    // null path.
    //
    // editor-preview-reliability tail fix: a null/empty yjsState is the
    // NORMAL state for a brand-new page AND for every checkpoint that
    // anti-shrink rejected (the reject policy leaves yjsState alone). The
    // hook must NOT broadcast `page-body-replaced` on null yjsState — only
    // an ABANDONED lineage (stale-empty / corrupt yjsState) signals it.
    const { pageId } = await seedPageWithBody('seed body');
    const spy = makeBroadcastSpy();
    const instance = makeInstanceWith(pageId, spy);

    const onLoadDocument = createOnLoadDocument({
      models: { Page: models.Page, Revision: models.Revision, PageYjsUpdate: models.PageYjsUpdate },
    });
    const newDoc = new Y.Doc();
    await onLoadDocument({
      documentName: pageId,
      document: newDoc,
      instance,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    // Fresh build still seeds the revision body — just no broadcast.
    expect(newDoc.getText(CONTENT_FIELD).toString()).toBe('seed body');
    expect(spy.calls).toEqual([]);
  });

  test('corrupt yjsState path broadcasts crowi:force-reload (reason=yjs-state-corruption)', async () => {
    const { pageId } = await seedPageWithBody('fallback body');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Page = models.Page as any;
    await Page.updateOne({ _id: pageId }, { $set: { yjsState: Buffer.from([0xff, 0xff, 0xff, 0xff]) } }).exec();

    const spy = makeBroadcastSpy();
    const instance = makeInstanceWith(pageId, spy);

    // Deterministically hits `hooks/on-load-document.ts`'s yjsState
    // Y.applyUpdate-failed body-seed-fallback warn — assert the operator
    // warning contract (not just its downstream effects) so a regression
    // that silently drops the warn is caught. Ported from
    // `packages/api/src/test/setup.ts`'s spy-per-test pattern; spy is
    // inline (no shared helper) so mockRestore() runs even if an
    // expect() above throws.
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const onLoadDocument = createOnLoadDocument({
        models: { Page: models.Page, Revision: models.Revision, PageYjsUpdate: models.PageYjsUpdate },
      });
      const newDoc = new Y.Doc();
      await onLoadDocument({
        documentName: pageId,
        document: newDoc,
        instance,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      expect(newDoc.getText(CONTENT_FIELD).toString()).toBe('fallback body');
      expect(spy.calls).toEqual([JSON.stringify({ kind: 'crowi:force-reload', reason: 'yjs-state-corruption' })]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('failed Y.applyUpdate; falling back to body seed'), expect.any(String));
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('valid yjsState path does NOT broadcast (normal restore, no editors to notify)', async () => {
    // Persist a real Yjs update so applyUpdate succeeds — the seed
    // path is skipped, so no broadcast should fire.
    const sourceDoc = new Y.Doc();
    sourceDoc.getText(CONTENT_FIELD).insert(0, 'persisted body');
    const yjsBuf = Buffer.from(Y.encodeStateAsUpdate(sourceDoc));

    const { pageId } = await seedPageWithBody('original revision');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Page = models.Page as any;
    await Page.updateOne({ _id: pageId }, { $set: { yjsState: yjsBuf } }).exec();

    const spy = makeBroadcastSpy();
    const instance = makeInstanceWith(pageId, spy);

    const onLoadDocument = createOnLoadDocument({
      models: { Page: models.Page, Revision: models.Revision, PageYjsUpdate: models.PageYjsUpdate },
    });
    const newDoc = new Y.Doc();
    await onLoadDocument({
      documentName: pageId,
      document: newDoc,
      instance,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    expect(newDoc.getText(CONTENT_FIELD).toString()).toBe('persisted body');
    expect(spy.calls).toEqual([]);
  });

  test('page with no revision + null yjsState yields an empty Y.Doc with NO broadcast', async () => {
    // Defensive: a page row with no `revision` pointer should not
    // crash the hook. With the tail fix, a null yjsState (the fresh-page
    // norm) does NOT broadcast — there is nothing replaced.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Page = models.Page as any;
    const page = await Page.create({
      path: `/__on-load-no-rev-${Date.now()}`,
      creator: new mongoose.Types.ObjectId(),
      grant: 1,
      status: 'published',
    });
    const pageId = page._id.toString();

    const spy = makeBroadcastSpy();
    const instance = makeInstanceWith(pageId, spy);

    const onLoadDocument = createOnLoadDocument({
      models: { Page: models.Page, Revision: models.Revision, PageYjsUpdate: models.PageYjsUpdate },
    });
    const newDoc = new Y.Doc();
    await onLoadDocument({
      documentName: pageId,
      document: newDoc,
      instance,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    expect(newDoc.getText(CONTENT_FIELD).toString()).toBe('');
    expect(spy.calls).toEqual([]);
  });

  test('documents.get undefined (no active editors) skips the broadcast without throwing', async () => {
    // First-connection scenario: Hocuspocus has not yet inserted the
    // Document into `instance.documents` (the hook is the entry point
    // for materialising it). `documents.get(documentName)` is
    // undefined; the hook must skip the broadcast silently — there is
    // no audience to notify.
    const { pageId } = await seedPageWithBody('seed body');
    const instance = makeInstanceWith(null /* nothing registered */); // empty Map

    const onLoadDocument = createOnLoadDocument({
      models: { Page: models.Page, Revision: models.Revision, PageYjsUpdate: models.PageYjsUpdate },
    });
    const newDoc = new Y.Doc();
    await expect(
      onLoadDocument({
        documentName: pageId,
        document: newDoc,
        instance,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    ).resolves.toBeUndefined();
    expect(newDoc.getText(CONTENT_FIELD).toString()).toBe('seed body');
  });

  test('seeds a CRLF (v1-era) revision body as LF-only so the Y.Text stays length-aligned with the editor', async () => {
    // CodeMirror 6 builds its document by splitting on `/\r\n?|\n/` and
    // re-joining with `\n`, dropping every `\r`. Seeding a CRLF body
    // verbatim would leave the Y.Text one char longer *per line* than the
    // editor's view; y-codemirror.next maps positions 1:1, so the drift
    // makes every subsequent edit land at the wrong offset and corrupts
    // the document. The seed must normalize CRLF → LF.
    const crlfBody = '# Title\r\n\r\n- one\r\n- two\r\n';
    const { pageId } = await seedPageWithBody(crlfBody);
    const instance = makeInstanceWith(null);

    const onLoadDocument = createOnLoadDocument({
      models: { Page: models.Page, Revision: models.Revision, PageYjsUpdate: models.PageYjsUpdate },
    });
    const newDoc = new Y.Doc();
    await onLoadDocument({
      documentName: pageId,
      document: newDoc,
      instance,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const seeded = newDoc.getText(CONTENT_FIELD).toString();
    expect(seeded).not.toContain('\r');
    expect(seeded).toBe('# Title\n\n- one\n- two\n');
  });

  test('seeds a lone-CR (old-Mac) revision body as LF-only', async () => {
    const { pageId } = await seedPageWithBody('a\rb\rc');
    const instance = makeInstanceWith(null);

    const onLoadDocument = createOnLoadDocument({
      models: { Page: models.Page, Revision: models.Revision, PageYjsUpdate: models.PageYjsUpdate },
    });
    const newDoc = new Y.Doc();
    await onLoadDocument({
      documentName: pageId,
      document: newDoc,
      instance,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    expect(newDoc.getText(CONTENT_FIELD).toString()).toBe('a\nb\nc');
  });

  describe('RFC-0017 Phase 1 — collab lifecycle epoch', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Page = () => models.Page as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const PageYjsUpdate = () => models.PageYjsUpdate as any;

    test('AC-19: a STATUS_DELETED page is rejected BEFORE any Y.Doc materialisation, and its epoch is recorded UNCONDITIONALLY', async () => {
      const { pageId } = await seedPageWithBody('deleted-era body');
      await Page()
        .updateOne({ _id: pageId }, { $set: { status: 'deleted' }, $inc: { collabLifecycleVersion: 1 } })
        .exec();

      const docEpochRevisions = createDocEpochStore();
      const onLoadDocument = createOnLoadDocument({
        models: { Page: models.Page, Revision: models.Revision, PageYjsUpdate: models.PageYjsUpdate },
        docEpochRevisions,
      });
      const newDoc = new Y.Doc();
      await expect(
        onLoadDocument({
          documentName: pageId,
          document: newDoc,
          instance: { documents: new Map() },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any),
      ).rejects.toThrow('page not found');

      // Rejected before any body-seed happened.
      expect(newDoc.getText(CONTENT_FIELD).toString()).toBe('');
      // But the epoch WAS recorded (unconditional — see doc-epoch.ts).
      expect(docEpochRevisions.get(pageId)).toBe(1);
    });

    test('epoch is recorded even while mid external-edit-invalidation drain (docBaseRevisions is conditionally skipped, docEpochRevisions is not)', async () => {
      const { pageId } = await seedPageWithBody('live body');
      await Page()
        .updateOne({ _id: pageId }, { $set: { collabLifecycleVersion: 2 } })
        .exec();

      const docBaseRevisions = createDocBaseRevisionStore();
      const docEpochRevisions = createDocEpochStore();
      const invalidatedPages = createInvalidatedPagesStore();
      invalidatedPages.mark(pageId, 5000);

      const onLoadDocument = createOnLoadDocument({
        models: { Page: models.Page, Revision: models.Revision, PageYjsUpdate: models.PageYjsUpdate },
        docBaseRevisions,
        docEpochRevisions,
        invalidatedPages,
      });
      const newDoc = new Y.Doc();
      await onLoadDocument({
        documentName: pageId,
        document: newDoc,
        instance: { documents: new Map() },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      expect(docBaseRevisions.get(pageId)).toBeUndefined();
      expect(docEpochRevisions.get(pageId)).toBe(2);
    });

    test('AC-15: replays only current-epoch PageYjsUpdate rows and best-effort sweeps stale-epoch ones', async () => {
      const { pageId } = await seedPageWithBody('placeholder body');
      await Page()
        .updateOne({ _id: pageId }, { $set: { collabLifecycleVersion: 1 } })
        .exec();

      const encodeDelta = (text: string): Buffer => {
        const d = new Y.Doc();
        d.getText(CONTENT_FIELD).insert(0, text);
        return Buffer.from(Y.encodeStateAsUpdate(d));
      };

      // A current-epoch row (should replay) and a stale-epoch row (should
      // NOT replay, and should be swept).
      await PageYjsUpdate().create({ pageId, payload: encodeDelta('CURRENT EPOCH CONTENT'), createdAt: new Date(), collabLifecycleVersion: 1 });
      await PageYjsUpdate().create({ pageId, payload: encodeDelta('STALE EPOCH CONTENT — MUST NOT MERGE'), createdAt: new Date(), collabLifecycleVersion: 0 });

      const onLoadDocument = createOnLoadDocument({
        models: { Page: models.Page, Revision: models.Revision, PageYjsUpdate: models.PageYjsUpdate },
      });
      const newDoc = new Y.Doc();
      await onLoadDocument({
        documentName: pageId,
        document: newDoc,
        instance: { documents: new Map() },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      const text = newDoc.getText(CONTENT_FIELD).toString();
      expect(text).toContain('CURRENT EPOCH CONTENT');
      expect(text).not.toContain('STALE EPOCH CONTENT');

      // Best-effort sweep: the stale-epoch row is gone (it can never become
      // current again — epoch only advances).
      expect(await PageYjsUpdate().countDocuments({ pageId }).exec()).toBe(1);
    });

    test('AC-15: a row missing collabLifecycleVersion (pre-RFC-0017) is treated as epoch 0 — replays on a never-transitioned page', async () => {
      const { pageId } = await seedPageWithBody('placeholder body');
      // Page never transitioned: collabLifecycleVersion stays at its
      // schema default (0).

      const encodeDelta = (text: string): Buffer => {
        const d = new Y.Doc();
        d.getText(CONTENT_FIELD).insert(0, text);
        return Buffer.from(Y.encodeStateAsUpdate(d));
      };
      // No collabLifecycleVersion field at all — the legacy row shape.
      await PageYjsUpdate().create({ pageId, payload: encodeDelta('LEGACY ROW, NO EPOCH FIELD'), createdAt: new Date() });

      const onLoadDocument = createOnLoadDocument({
        models: { Page: models.Page, Revision: models.Revision, PageYjsUpdate: models.PageYjsUpdate },
      });
      const newDoc = new Y.Doc();
      await onLoadDocument({
        documentName: pageId,
        document: newDoc,
        instance: { documents: new Map() },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      expect(newDoc.getText(CONTENT_FIELD).toString()).toContain('LEGACY ROW, NO EPOCH FIELD');
    });
  });
});
