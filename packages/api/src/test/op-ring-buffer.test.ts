/**
 * Deterministic coverage for `op-ring-buffer.ts` (feature-flake-failure-taxonomy
 * AC-2): dispatch start/end bookkeeping, the bounded window, and the
 * `expect.getState().currentTestName` tagging that lets
 * `crowi-environment.js`'s `handleTestEvent` correlate entries to the test
 * that produced them.
 */
import { __resetRingBufferForTests, recordDispatchEnd, recordDispatchStart, snapshotRecentOps } from './op-ring-buffer';

beforeEach(() => {
  __resetRingBufferForTests();
});

describe('recordDispatchStart / recordDispatchEnd', () => {
  it('pushes an in-flight entry (httpStatus: null, finishedAt: null) and finalizes it in place', () => {
    const entry = recordDispatchStart('GET', '/api/pages');
    expect(snapshotRecentOps()).toEqual([expect.objectContaining({ method: 'GET', path: '/api/pages', dispatched: true, httpStatus: null, finishedAt: null })]);

    recordDispatchEnd(entry, 200);
    const snapshot = snapshotRecentOps();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].httpStatus).toBe(200);
    expect(typeof snapshot[0].finishedAt).toBe('string');
  });

  it('records httpStatus: null when the caller finalizes with null (fetchFn threw before producing a Response)', () => {
    const entry = recordDispatchStart('POST', '/api/pages');
    recordDispatchEnd(entry, null);
    expect(snapshotRecentOps()[0]).toMatchObject({ dispatched: true, httpStatus: null });
    // still finalized (finishedAt set) — distinguishable from "still in flight".
    expect(snapshotRecentOps()[0].finishedAt).not.toBeNull();
  });

  it('tags each entry with expect.getState().currentTestName at push time', () => {
    const entry = recordDispatchStart('GET', '/api/pages');
    expect(entry.testFullName).toBe(expect.getState().currentTestName);
  });

  it('records multiple parallel requests within one test (autocomplete.test.ts-style burst)', () => {
    const entries = Array.from({ length: 5 }, () => recordDispatchStart('GET', '/api/users/autocomplete'));
    entries.forEach((entry, i) => recordDispatchEnd(entry, i % 2 === 0 ? 200 : 429));

    const snapshot = snapshotRecentOps();
    expect(snapshot).toHaveLength(5);
    expect(snapshot.filter((op) => op.httpStatus === 429)).toHaveLength(2);
  });

  it('caps the buffer at the most recent MAX_ENTRIES (20) — older entries are evicted', () => {
    for (let i = 0; i < 25; i++) {
      recordDispatchEnd(recordDispatchStart('GET', `/api/probe/${i}`), 200);
    }
    const snapshot = snapshotRecentOps();
    expect(snapshot).toHaveLength(20);
    // The oldest 5 (probe/0..4) were evicted — the window starts at probe/5.
    expect(snapshot[0].path).toBe('/api/probe/5');
    expect(snapshot[snapshot.length - 1].path).toBe('/api/probe/24');
  });
});

describe('snapshotRecentOps', () => {
  it('returns an empty array when nothing has been recorded', () => {
    expect(snapshotRecentOps()).toEqual([]);
  });

  it('returns a copy, not a live reference — mutating the snapshot does not affect the buffer', () => {
    recordDispatchStart('GET', '/api/pages');
    const snapshot = snapshotRecentOps();
    snapshot.pop();
    expect(snapshotRecentOps()).toHaveLength(1);
  });
});

describe('__resetRingBufferForTests', () => {
  it('clears every entry', () => {
    recordDispatchStart('GET', '/api/pages');
    expect(snapshotRecentOps()).toHaveLength(1);
    __resetRingBufferForTests();
    expect(snapshotRecentOps()).toEqual([]);
  });
});
