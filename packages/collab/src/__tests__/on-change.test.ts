import mongoose from 'mongoose';
import type { Compactor } from '../compaction';
import { createDocEpochStore } from '../doc-epoch';
import { createOnChange } from '../hooks/on-change';
import type { CollabModels } from '../models';
import { registerTestModels, type SmokeMongo, startInMemoryMongo } from './setup';

/**
 * RFC-0017 Phase 1 §4.2/AC-14 — `onChange`'s epoch stamp + best-effort
 * stale-connection refuse.
 */
describe('createOnChange — RFC-0017 Phase 1 epoch stamp/refuse', () => {
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const PageYjsUpdate = () => models.PageYjsUpdate as any;

  const noopCompactor: Pick<Compactor, 'compactPage'> = { compactPage: async () => null };

  const makePayload = (documentName: string, context: Record<string, unknown>) =>
    ({
      documentName,
      update: new Uint8Array([1, 2, 3]),
      context,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

  test('AC-14: stamps the appended row with the doc-level epoch store value', async () => {
    const documentName = new mongoose.Types.ObjectId().toString();
    const docEpochRevisions = createDocEpochStore();
    docEpochRevisions.set(documentName, 3);

    const onChange = createOnChange({ models: { PageYjsUpdate: models.PageYjsUpdate }, compactor: noopCompactor, docEpochRevisions });
    await onChange(makePayload(documentName, { userId: 'u1', pageId: documentName, readonly: false, epoch: 3 }));

    const rows = await PageYjsUpdate().find({ pageId: documentName }).lean().exec();
    expect(rows).toHaveLength(1);
    expect(rows[0].collabLifecycleVersion).toBe(3);
  });

  test('AC-14: refuses the append (best-effort skip) when the connection epoch diverges from the CURRENT doc-level epoch', async () => {
    const documentName = new mongoose.Types.ObjectId().toString();
    const docEpochRevisions = createDocEpochStore();
    // A fresh materialisation (e.g. post-rename reconnect) recorded epoch 1
    // for this documentName...
    docEpochRevisions.set(documentName, 1);

    const onChange = createOnChange({ models: { PageYjsUpdate: models.PageYjsUpdate }, compactor: noopCompactor, docEpochRevisions });
    // ...but THIS connection authenticated back when the epoch was still 0
    // (a stale, drain-detached connection that never reconnected).
    await onChange(makePayload(documentName, { userId: 'stale-user', pageId: documentName, readonly: false, epoch: 0 }));

    const rows = await PageYjsUpdate().find({ pageId: documentName }).lean().exec();
    expect(rows).toHaveLength(0);
  });

  test('matching connection epoch and doc-level epoch appends normally', async () => {
    const documentName = new mongoose.Types.ObjectId().toString();
    const docEpochRevisions = createDocEpochStore();
    docEpochRevisions.set(documentName, 2);

    const onChange = createOnChange({ models: { PageYjsUpdate: models.PageYjsUpdate }, compactor: noopCompactor, docEpochRevisions });
    await onChange(makePayload(documentName, { userId: 'u1', pageId: documentName, readonly: false, epoch: 2 }));

    const rows = await PageYjsUpdate().find({ pageId: documentName }).lean().exec();
    expect(rows).toHaveLength(1);
    expect(rows[0].collabLifecycleVersion).toBe(2);
  });

  test('fail-safe: an unknown doc-level epoch (never recorded) does not refuse — stamps with the connection epoch instead', async () => {
    const documentName = new mongoose.Types.ObjectId().toString();
    const docEpochRevisions = createDocEpochStore(); // nothing recorded

    const onChange = createOnChange({ models: { PageYjsUpdate: models.PageYjsUpdate }, compactor: noopCompactor, docEpochRevisions });
    await onChange(makePayload(documentName, { userId: 'u1', pageId: documentName, readonly: false, epoch: 4 }));

    const rows = await PageYjsUpdate().find({ pageId: documentName }).lean().exec();
    expect(rows).toHaveLength(1);
    expect(rows[0].collabLifecycleVersion).toBe(4);
  });

  test('fail-safe: an unknown connection epoch (context.epoch undefined) does not refuse — stamps with the doc-level epoch', async () => {
    const documentName = new mongoose.Types.ObjectId().toString();
    const docEpochRevisions = createDocEpochStore();
    docEpochRevisions.set(documentName, 7);

    const onChange = createOnChange({ models: { PageYjsUpdate: models.PageYjsUpdate }, compactor: noopCompactor, docEpochRevisions });
    await onChange(makePayload(documentName, { userId: 'u1', pageId: documentName, readonly: false }));

    const rows = await PageYjsUpdate().find({ pageId: documentName }).lean().exec();
    expect(rows).toHaveLength(1);
    expect(rows[0].collabLifecycleVersion).toBe(7);
  });

  test('readonly context still skips the append regardless of epoch (existing defence-in-depth, unaffected)', async () => {
    const documentName = new mongoose.Types.ObjectId().toString();
    const docEpochRevisions = createDocEpochStore();
    docEpochRevisions.set(documentName, 0);

    const onChange = createOnChange({ models: { PageYjsUpdate: models.PageYjsUpdate }, compactor: noopCompactor, docEpochRevisions });
    await onChange(makePayload(documentName, { userId: 'u1', pageId: documentName, readonly: true, epoch: 0 }));

    const rows = await PageYjsUpdate().find({ pageId: documentName }).lean().exec();
    expect(rows).toHaveLength(0);
  });

  test('omitting docEpochRevisions entirely (synthetic driver) still appends, without a collabLifecycleVersion stamp', async () => {
    const documentName = new mongoose.Types.ObjectId().toString();
    const onChange = createOnChange({ models: { PageYjsUpdate: models.PageYjsUpdate }, compactor: noopCompactor });
    await onChange(makePayload(documentName, { userId: 'u1', pageId: documentName, readonly: false }));

    const rows = await PageYjsUpdate().find({ pageId: documentName }).lean().exec();
    expect(rows).toHaveLength(1);
    expect(rows[0].collabLifecycleVersion).toBeUndefined();
  });
});
