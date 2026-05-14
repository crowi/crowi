import { createContributorsTracker } from '../contributors';

describe('createContributorsTracker', () => {
  test('record + drain returns the recorded ids and clears the set', () => {
    const t = createContributorsTracker();
    t.record('page-a', 'alice');
    t.record('page-a', 'bob');
    expect(t._peek('page-a').sort()).toEqual(['alice', 'bob']);

    const drained = t.drain('page-a').sort();
    expect(drained).toEqual(['alice', 'bob']);
    // Second drain is empty — drain has read-and-clear semantics.
    expect(t.drain('page-a')).toEqual([]);
  });

  test('record is idempotent (Set semantics)', () => {
    const t = createContributorsTracker();
    t.record('page-a', 'alice');
    t.record('page-a', 'alice');
    t.record('page-a', 'alice');
    expect(t.drain('page-a')).toEqual(['alice']);
  });

  test('per-pageId isolation: page A drain does not affect page B', () => {
    const t = createContributorsTracker();
    t.record('page-a', 'alice');
    t.record('page-b', 'bob');
    expect(t.drain('page-a')).toEqual(['alice']);
    // page-b untouched
    expect(t.drain('page-b')).toEqual(['bob']);
  });

  test('drain on an unseen page returns []', () => {
    const t = createContributorsTracker();
    expect(t.drain('never-recorded')).toEqual([]);
  });

  test('empty pageId / userId are silently dropped (defensive)', () => {
    const t = createContributorsTracker();
    t.record('', 'alice');
    t.record('page-a', '');
    expect(t._peek('page-a')).toEqual([]);
    expect(t.drain('')).toEqual([]);
  });

  test('clear() drops the entry entirely (vs. drain which keeps the bucket)', () => {
    const t = createContributorsTracker();
    t.record('page-a', 'alice');
    t.clear('page-a');
    expect(t.drain('page-a')).toEqual([]);
  });
});
