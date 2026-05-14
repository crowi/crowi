// Pin WS_TOKEN_SECRET before the api util's resolveWsTokenSecret() fires
// (it captures the secret on first call). Matches the smoke test for
// boot parity; compaction itself doesn't sign tokens, but the api dist's
// model factory side-imports may indirectly reach for the secret in
// future phases.
process.env.WS_TOKEN_SECRET = process.env.WS_TOKEN_SECRET ?? 'test-ws-token-secret-base64-32bytes-=';

import * as Y from 'yjs';
import { startInMemoryMongo, registerTestModels, type SmokeMongo } from './setup';
import { encodeYjsDelta, makeFixtures, type CollabFixtures } from './fixtures';
import type { CollabModels } from '../models';
import { createCompactor } from '../compaction';
import { createOnChange } from '../hooks/on-change';
import { createOnStoreDocument } from '../hooks/on-store-document';
import { createOnLoadDocument } from '../hooks/on-load-document';
import { CONTENT_FIELD } from '../yjs-doc';
import { payloadToUint8Array } from '../yjs-payload';

/**
 * Phase 4 tests for the PageYjsUpdate append + compaction loop.
 *
 * Strategy: drive the hooks + compactor directly (no Hocuspocus
 * WebSocket — see smoke.test.ts for the reasoning) so we can assert
 * DB state at every step. The mocks for "concurrent edit safety" use
 * a real second insert *between* the find and the deleteMany inside
 * the compactor, so the race we're testing is faithful.
 */

describe('@crowi/collab Phase 4 compaction', () => {
  let memMongo: SmokeMongo;
  let models: CollabModels;
  let fixtures: CollabFixtures;

  beforeAll(async () => {
    memMongo = await startInMemoryMongo();
    const reg = registerTestModels();
    models = reg.models;
    fixtures = makeFixtures(models);
  });

  afterAll(async () => {
    await memMongo.stop();
  });

  const seedPage = (overrides?: Record<string, unknown>) => fixtures.seedPage(overrides);
  const seedRevision = (pageId: string, body: string) => fixtures.seedRevision(pageId, body);
  const countPending = (pageId: string) => fixtures.countPending(pageId);

  it('compactPage folds yjsState + pending PageYjsUpdate rows into one and deletes the rows', async () => {
    const { pageId } = await seedPage();

    // Seed an initial checkpoint + a few pending deltas. We capture
    // each delta via the `Y.Doc.update` event (same way Hocuspocus's
    // `onChange` receives them in production) so the byte payloads
    // are valid Yjs updates referencing the live doc's clientID.
    const liveDoc = new Y.Doc();
    liveDoc.getText(CONTENT_FIELD).insert(0, 'A');
    const initialState = Buffer.from(Y.encodeStateAsUpdate(liveDoc));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (models.Page as any).updateOne({ _id: pageId }, { $set: { yjsState: initialState, yjsCheckpointAt: new Date(Date.now() - 1000) } }).exec();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const PageYjsUpdate = models.PageYjsUpdate as any;
    const deltas: Buffer[] = [];
    const captureUpdate = (update: Uint8Array): void => {
      deltas.push(Buffer.from(update));
    };
    liveDoc.on('update', captureUpdate);
    for (const ch of ['B', 'C', 'D', 'E', 'F']) {
      liveDoc.getText(CONTENT_FIELD).insert(liveDoc.getText(CONTENT_FIELD).length, ch);
    }
    liveDoc.off('update', captureUpdate);
    expect(deltas.length).toBe(5);
    for (let i = 0; i < deltas.length; i += 1) {
      await PageYjsUpdate.create({
        pageId,
        payload: deltas[i],
        createdAt: new Date(Date.now() + i),
      });
    }
    expect(await countPending(pageId)).toBe(5);

    const compactor = createCompactor({
      models: { Page: models.Page, PageYjsUpdate: models.PageYjsUpdate },
    });
    const result = await compactor.compactPage(pageId);

    expect(result).toEqual({ compactedCount: 5, newYjsStateBytes: expect.any(Number) });
    expect(await countPending(pageId)).toBe(0);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const after = await (models.Page as any).findById(pageId).select('yjsState yjsCheckpointAt').exec();
    expect(after?.yjsState).toBeInstanceOf(Buffer);
    expect((after?.yjsState as Buffer).length).toBeGreaterThan(0);
    expect(after?.yjsCheckpointAt).toBeInstanceOf(Date);

    // Round-trip: applying the new yjsState into a fresh doc yields the
    // merged content of base + every delta.
    const restoredDoc = new Y.Doc();
    Y.applyUpdate(restoredDoc, new Uint8Array(after?.yjsState as Buffer));
    expect(restoredDoc.getText(CONTENT_FIELD).toString()).toBe('ABCDEF');
  });

  it('compactPage is idempotent — a same-page in-flight call returns null', async () => {
    const { pageId } = await seedPage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const PageYjsUpdate = models.PageYjsUpdate as any;
    await PageYjsUpdate.create({
      pageId,
      payload: encodeYjsDelta('hello'),
      createdAt: new Date(),
    });

    const compactor = createCompactor({
      models: { Page: models.Page, PageYjsUpdate: models.PageYjsUpdate },
    });

    // Run two compactPage calls concurrently. The second one (whichever
    // hits the inflight check second) must return null, leaving the
    // first to complete normally.
    const [a, b] = await Promise.all([compactor.compactPage(pageId), compactor.compactPage(pageId)]);
    const nulls = [a, b].filter((r) => r === null);
    const successes = [a, b].filter((r) => r !== null);
    expect(nulls.length).toBe(1);
    expect(successes.length).toBe(1);
    expect(await countPending(pageId)).toBe(0);
  });

  it('concurrent appends during compaction survive: only the snapshotted ids are deleted', async () => {
    const { pageId } = await seedPage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const PageYjsUpdate = models.PageYjsUpdate as any;

    // Seed 3 rows that the snapshot will see.
    for (const ch of ['x', 'y', 'z']) {
      await PageYjsUpdate.create({ pageId, payload: encodeYjsDelta(ch), createdAt: new Date() });
    }

    // Wrap deleteMany so we can sneak a new append in between the
    // snapshot's `find` and its `deleteMany`. Mongoose's `deleteMany`
    // returns a Query whose `.exec()` resolves a result; we keep that
    // contract intact and only delay the await.
    const realDeleteMany = PageYjsUpdate.deleteMany.bind(PageYjsUpdate);
    const deleteSpy = jest.spyOn(PageYjsUpdate, 'deleteMany').mockImplementation(((filter: unknown) => {
      const query = realDeleteMany(filter);
      const originalExec = query.exec.bind(query);
      query.exec = async () => {
        // Append a brand new row *after* the compactor finished its
        // find() but *before* the deleteMany has hit the DB. This is
        // the race we're testing — the new row is not in
        // `collectedIds`, so the delete must leave it alone.
        await PageYjsUpdate.create({
          pageId,
          payload: encodeYjsDelta('late'),
          createdAt: new Date(),
        });
        return originalExec();
      };
      return query;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);

    try {
      const compactor = createCompactor({
        models: { Page: models.Page, PageYjsUpdate: models.PageYjsUpdate },
      });
      const result = await compactor.compactPage(pageId);
      expect(result?.compactedCount).toBe(3);
    } finally {
      deleteSpy.mockRestore();
    }

    // The single late row must survive.
    expect(await countPending(pageId)).toBe(1);
  });

  it('onChange appends to PageYjsUpdate and skips when context.readonly is true', async () => {
    const { pageId } = await seedPage();
    const compactor = createCompactor({
      models: { Page: models.Page, PageYjsUpdate: models.PageYjsUpdate },
    });
    const onChange = createOnChange({
      models: { PageYjsUpdate: models.PageYjsUpdate },
      compactor,
    });

    // Read-only context: no append.
    await onChange({
      documentName: pageId,
      update: new Uint8Array(encodeYjsDelta('ro')),
      context: { userId: 'u1', pageId, readonly: true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(await countPending(pageId)).toBe(0);

    // Normal context: append lands.
    await onChange({
      documentName: pageId,
      update: new Uint8Array(encodeYjsDelta('rw')),
      context: { userId: 'u1', pageId, readonly: false },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(await countPending(pageId)).toBe(1);
  });

  it('onChange fires compactPage when pending count crosses the 100 threshold', async () => {
    const { pageId } = await seedPage();
    const compactor = createCompactor({
      models: { Page: models.Page, PageYjsUpdate: models.PageYjsUpdate },
    });
    const compactSpy = jest.spyOn(compactor, 'compactPage');
    const onChange = createOnChange({
      models: { PageYjsUpdate: models.PageYjsUpdate },
      compactor,
    });

    // Feed 99 deltas — under threshold, no fire.
    for (let i = 0; i < 99; i += 1) {
      await onChange({
        documentName: pageId,
        update: new Uint8Array(encodeYjsDelta(`d${i}`)),
        context: { userId: 'u1', pageId, readonly: false },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    }
    expect(compactSpy).not.toHaveBeenCalled();
    expect(await countPending(pageId)).toBe(99);

    // The 100th delta triggers (count % 10 === 0 check + db count >= 100).
    await onChange({
      documentName: pageId,
      update: new Uint8Array(encodeYjsDelta('d99')),
      context: { userId: 'u1', pageId, readonly: false },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    // The compactPage call is fire-and-forget inside onChange — we
    // need to let the microtask queue drain so the spy assertion can
    // see the call.
    await new Promise((resolve) => setImmediate(resolve));
    expect(compactSpy).toHaveBeenCalledWith(pageId);

    // And we wait for the actual compaction to flush before asserting
    // pending count, since compactPage runs async. Poll instead of a
    // fixed wait — under heavy parallel jest load the 50ms-fixed wait
    // sometimes raced the in-memory mongodb DELETE; up to ~500ms is
    // still well below any reasonable per-test budget.
    for (let i = 0; i < 25; i += 1) {
      if ((await countPending(pageId)) === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await countPending(pageId)).toBe(0);
  });

  it('onStoreDocument: time-trigger is skipped when storeCheckpoint successfully compacted pending rows', async () => {
    // Phase 4 simplify (Efficiency F3): when `storeCheckpoint` returns
    // a non-null result, it already folded every pending row into
    // `Page.yjsState` and bumped `yjsCheckpointAt` to now. Firing the
    // time-trigger `compactPage` afterwards would walk an empty
    // `PageYjsUpdate.find()` and return `null` — wasted round-trip.
    // The hook now skips the time-trigger in that case.
    const { pageId } = await seedPage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Page = models.Page as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const PageYjsUpdate = models.PageYjsUpdate as any;

    // Backdate yjsCheckpointAt to 11 min ago + seed pending deltas.
    await Page.updateOne({ _id: pageId }, { $set: { yjsCheckpointAt: new Date(Date.now() - 11 * 60 * 1000) } }).exec();
    for (const ch of ['a', 'b', 'c']) {
      await PageYjsUpdate.create({ pageId, payload: encodeYjsDelta(ch), createdAt: new Date() });
    }

    const compactor = createCompactor({
      models: { Page: models.Page, PageYjsUpdate: models.PageYjsUpdate },
    });
    const compactSpy = jest.spyOn(compactor, 'compactPage');
    const onStoreDocument = createOnStoreDocument({ models: { Page: models.Page }, compactor });

    const doc = new Y.Doc();
    doc.getText(CONTENT_FIELD).insert(0, 'live edit ');
    await onStoreDocument({
      documentName: pageId,
      document: doc,
      lastContext: { userId: 'u1', pageId, readonly: false },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    // Drain microtasks so any (incorrectly) scheduled time-trigger
    // compactPage would have a chance to surface.
    await new Promise((resolve) => setImmediate(resolve));
    expect(compactSpy).not.toHaveBeenCalled();
    // storeCheckpoint did all the work — pending rows already gone
    // and yjsCheckpointAt is fresh.
    expect(await countPending(pageId)).toBe(0);
    // hydrated `.exec()` (no `.lean()`) so `yjsState` round-trips as
    // a real Node Buffer — `.lean()` returns it as a bson Binary
    // whose `.length` is a method, not a number.
    const fresh = await Page.findById(pageId).select('yjsCheckpointAt yjsState').exec();
    expect((fresh?.yjsCheckpointAt as Date).getTime()).toBeGreaterThan(Date.now() - 60 * 1000);
    expect((fresh?.yjsState as Buffer).length).toBeGreaterThan(0);
  });

  it('onStoreDocument: time-trigger fires when storeCheckpoint is skipped via the in-flight mutex', async () => {
    // Complementary path: when `storeCheckpoint` returns `null`
    // because another compaction holds the inflight mutex, the
    // time-trigger has to step in so an aged checkpoint eventually
    // recovers. We simulate the mutex by stubbing storeCheckpoint to
    // return null — the hook should fall through to compactPage.
    const { pageId } = await seedPage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Page = models.Page as any;
    await Page.updateOne({ _id: pageId }, { $set: { yjsCheckpointAt: new Date(Date.now() - 11 * 60 * 1000) } }).exec();

    const compactor = createCompactor({
      models: { Page: models.Page, PageYjsUpdate: models.PageYjsUpdate },
    });
    jest.spyOn(compactor, 'storeCheckpoint').mockResolvedValue(null);
    const compactSpy = jest.spyOn(compactor, 'compactPage');
    const onStoreDocument = createOnStoreDocument({ models: { Page: models.Page }, compactor });

    await onStoreDocument({
      documentName: pageId,
      document: new Y.Doc(),
      lastContext: { userId: 'u1', pageId, readonly: false },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    await new Promise((resolve) => setImmediate(resolve));
    expect(compactSpy).toHaveBeenCalledWith(pageId);
  });

  it('crash recovery: onLoadDocument applies Page.yjsState + every residual PageYjsUpdate in order', async () => {
    const { pageId } = await seedPage();
    await seedRevision(pageId, 'unused-body');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Page = models.Page as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const PageYjsUpdate = models.PageYjsUpdate as any;

    // Build a baseline state ('AB') + a chain of incremental updates
    // produced from the same ydoc, mimicking what compaction-then-
    // crash would leave behind (last checkpoint = 'AB', three deltas
    // appending C, D, E that compaction never folded in). Capture the
    // deltas via `Y.Doc.update` events (the same way Hocuspocus does
    // in production).
    const liveDoc = new Y.Doc();
    liveDoc.getText(CONTENT_FIELD).insert(0, 'AB');
    const baseState = Buffer.from(Y.encodeStateAsUpdate(liveDoc));
    await Page.updateOne({ _id: pageId }, { $set: { yjsState: baseState, yjsCheckpointAt: new Date() } }).exec();

    const deltas: Buffer[] = [];
    const captureUpdate = (update: Uint8Array): void => {
      deltas.push(Buffer.from(update));
    };
    liveDoc.on('update', captureUpdate);
    for (const ch of ['C', 'D', 'E']) {
      liveDoc.getText(CONTENT_FIELD).insert(liveDoc.getText(CONTENT_FIELD).length, ch);
    }
    liveDoc.off('update', captureUpdate);
    expect(deltas.length).toBe(3);
    for (let i = 0; i < deltas.length; i += 1) {
      await PageYjsUpdate.create({
        pageId,
        payload: deltas[i],
        createdAt: new Date(Date.now() + i),
      });
    }

    const onLoadDocument = createOnLoadDocument({
      models: { Page: models.Page, Revision: models.Revision, PageYjsUpdate: models.PageYjsUpdate },
    });
    const restored = new Y.Doc();
    await onLoadDocument({
      documentName: pageId,
      document: restored,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(restored.getText(CONTENT_FIELD).toString()).toBe('ABCDE');
    // Residual rows are NOT cleared by load — only compaction deletes
    // them. They're re-applied idempotently on every load and will be
    // cleaned up by the next compactor pass (or the 1h TTL).
    expect(await countPending(pageId)).toBe(3);
  });

  it('onLoadDocument: corrupt yjsState falls back to body seed and still applies residual updates without throwing', async () => {
    // Path coverage: yjsState is invalid → applyUpdate throws → seed
    // from revision body → replay residual rows. The residual rows
    // were originally encoded against a different clientID so the
    // merged CRDT state isn't a literal concatenation, but the load
    // must (a) not throw and (b) produce non-empty content. This is
    // the best-effort recovery contract documented in `onLoadDocument`.
    const { pageId } = await seedPage();
    await seedRevision(pageId, 'fallback seed');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Page = models.Page as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const PageYjsUpdate = models.PageYjsUpdate as any;

    await Page.updateOne({ _id: pageId }, { $set: { yjsState: Buffer.from([0xff, 0xff, 0xff, 0xff]) } }).exec();
    await PageYjsUpdate.create({ pageId, payload: encodeYjsDelta('residual'), createdAt: new Date() });

    const onLoadDocument = createOnLoadDocument({
      models: { Page: models.Page, Revision: models.Revision, PageYjsUpdate: models.PageYjsUpdate },
    });
    const doc = new Y.Doc();
    await expect(
      onLoadDocument({
        documentName: pageId,
        document: doc,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    ).resolves.not.toThrow();
    expect(doc.getText(CONTENT_FIELD).toString().length).toBeGreaterThan(0);
  });

  it('onLoadDocument: corrupt PageYjsUpdate rows are deleted on load so warnings do not repeat', async () => {
    // Reviewer-driven (Quality F9): poisoned rows survive the per-row
    // try/catch in `replayResidualUpdates`, so they would warn on every
    // load until the 1h TTL clears them. After the load they should be
    // gone — Y.applyUpdate's `Unexpected end of array` failure on a
    // 0xff…0xff payload triggers the cleanup path.
    const { pageId } = await seedPage();
    await seedRevision(pageId, 'seed');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const PageYjsUpdate = models.PageYjsUpdate as any;
    await PageYjsUpdate.create({ pageId, payload: Buffer.from([0xff, 0xff, 0xff, 0xff]), createdAt: new Date() });
    await PageYjsUpdate.create({ pageId, payload: encodeYjsDelta('ok'), createdAt: new Date() });
    expect(await countPending(pageId)).toBe(2);

    const onLoadDocument = createOnLoadDocument({
      models: { Page: models.Page, Revision: models.Revision, PageYjsUpdate: models.PageYjsUpdate },
    });
    await onLoadDocument({
      documentName: pageId,
      document: new Y.Doc(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    // The corrupt row is gone; the well-formed one is left in place
    // because only compaction (not load) removes successful rows.
    expect(await countPending(pageId)).toBe(1);
  });

  it('payloadToUint8Array: forwards a raw Uint8Array as-is (covers the test-side branch)', () => {
    const arr = new Uint8Array([1, 2, 3, 4]);
    const out = payloadToUint8Array(arr);
    expect(out).toBe(arr);
  });

  it('TTL index regression: PageYjsUpdate has expireAfterSeconds=3600 on createdAt', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const PageYjsUpdate = models.PageYjsUpdate as any;
    // Index info varies slightly across Mongo driver versions; both
    // `getIndexes()` and `indexInformation({full: true})` work but the
    // latter exposes the expireAfterSeconds option directly.
    const indexes = await PageYjsUpdate.collection.indexInformation({ full: true });
    const ttl = (indexes as Array<{ name: string; key: Record<string, number>; expireAfterSeconds?: number }>).find((idx) => idx.name === 'pageYjsUpdate_ttl');
    expect(ttl).toBeDefined();
    expect(ttl?.key).toEqual({ createdAt: 1 });
    expect(ttl?.expireAfterSeconds).toBe(3600);
  });
});
