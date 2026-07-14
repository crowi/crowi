import mongoose from 'mongoose';
import * as Y from 'yjs';
import type { CollabModels } from '../models';
import { persistYjsState } from '../persist-yjs-state';
import { CONTENT_FIELD } from '../yjs-doc';
import { registerTestModels, type SmokeMongo, startInMemoryMongo } from './setup';

/**
 * RFC-0017 Phase 1 §4.2/AC-16 — `persistYjsState`'s epoch + deleted-status
 * CAS. Zero-match on the `updateOne` filter is treated as "do not
 * persist" — same no-data-loss policy as an anti-shrink reject.
 */
describe('persistYjsState — RFC-0017 Phase 1 epoch/status CAS', () => {
  let memMongo: SmokeMongo;
  let models: CollabModels;
  let warnSpy: jest.SpyInstance;

  beforeAll(async () => {
    memMongo = await startInMemoryMongo();
    const reg = registerTestModels();
    models = reg.models;
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

  const seedPage = async (overrides: Record<string, unknown> = {}) => {
    const page = await Page().create({
      path: `/__persist-epoch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      creator: new mongoose.Types.ObjectId(),
      grant: 1,
      status: 'published',
      ...overrides,
    });
    return page._id.toString();
  };

  const makeDoc = (text: string): Y.Doc => {
    const doc = new Y.Doc();
    doc.getText(CONTENT_FIELD).insert(0, text);
    return doc;
  };

  test('AC-16: a matching expectedEpoch persists normally', async () => {
    const pageId = await seedPage({ collabLifecycleVersion: 2 });
    const result = await persistYjsState(Page(), { pageId, document: makeDoc('hello'), baselineBody: null, origin: 'save', expectedEpoch: 2 });
    expect(result.ok).toBe(true);

    const page = await Page().findById(pageId).exec();
    expect(page.yjsState).toBeTruthy();
  });

  test('AC-16: a stale expectedEpoch (page transitioned since load) rejects — zero-match is treated as "do not persist"', async () => {
    const pageId = await seedPage({ collabLifecycleVersion: 3 });
    // expectedEpoch (1) is stale — the page has already moved to epoch 3.
    const result = await persistYjsState(Page(), { pageId, document: makeDoc('stale write'), baselineBody: null, origin: 'save', expectedEpoch: 1 });
    expect(result).toEqual({ ok: false, reason: 'epoch-mismatch' });

    const page = await Page().findById(pageId).exec();
    expect(page.yjsState ?? null).toBeNull();
  });

  test('AC-16: a STATUS_DELETED page rejects even when the epoch matches (belt-and-suspenders status predicate)', async () => {
    const pageId = await seedPage({ collabLifecycleVersion: 0, status: 'deleted' });
    const result = await persistYjsState(Page(), {
      pageId,
      document: makeDoc('targeting a deleted page'),
      baselineBody: null,
      origin: 'save',
      expectedEpoch: 0,
    });
    expect(result).toEqual({ ok: false, reason: 'epoch-mismatch' });
  });

  test('AC-16: a legacy row (status predicate only, no expectedEpoch) still rejects a deleted page', async () => {
    const pageId = await seedPage({ status: 'deleted' });
    // No `expectedEpoch` at all (fail-safe fallback) — the status predicate
    // alone must still guard against writing into a deleted page.
    const result = await persistYjsState(Page(), { pageId, document: makeDoc('no epoch known'), baselineBody: null, origin: 'store-only' });
    expect(result).toEqual({ ok: false, reason: 'epoch-mismatch' });
  });

  test('an unknown expectedEpoch (undefined) on a live, non-deleted page persists normally (fail-safe fallback, not a bypass)', async () => {
    const pageId = await seedPage({ collabLifecycleVersion: 9 });
    const result = await persistYjsState(Page(), { pageId, document: makeDoc('fresh process, no epoch recorded'), baselineBody: null, origin: 'full-merge' });
    expect(result.ok).toBe(true);

    const page = await Page().findById(pageId).exec();
    expect(page.yjsState).toBeTruthy();
  });
});
