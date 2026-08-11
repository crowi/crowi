import { HistoryMigratingError, requireHistoryReady } from './tracking-gate';

/**
 * feature-page-history-phase1-model (RFC-0021 §5.5a, Phase 1) —
 * `requireHistoryReady`'s 3-state gate. No writer calls this function yet
 * (Phase 2's command cutover is the first caller) — this suite fixes every
 * branch ahead of that cutover, per RFC §16.1's "add failure-injection
 * tests before enabling writers".
 */

describe('requireHistoryReady (RFC-0021 §5.5a, feature-page-history-phase1-model)', () => {
  test('passes silently for state: "ready"', () => {
    expect(() => requireHistoryReady({ historyTracking: { state: 'ready' } })).not.toThrow();
  });

  test('throws HistoryMigratingError for state: "untracked"', () => {
    expect(() => requireHistoryReady({ historyTracking: { state: 'untracked' } })).toThrow(HistoryMigratingError);
  });

  test('throws HistoryMigratingError for state: "migrating"', () => {
    expect(() => requireHistoryReady({ historyTracking: { state: 'migrating' } })).toThrow(HistoryMigratingError);
  });

  test('treats an entirely absent historyTracking as untracked (legacy Page shape)', () => {
    let caught: unknown;
    try {
      requireHistoryReady({} as { historyTracking: { state: 'untracked' | 'migrating' | 'ready' } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HistoryMigratingError);
    expect((caught as HistoryMigratingError).state).toBe('untracked');
  });

  test('the thrown error carries the retryable 409 history_migrating shape', () => {
    try {
      requireHistoryReady({ historyTracking: { state: 'migrating' } });
      throw new Error('expected requireHistoryReady to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HistoryMigratingError);
      const migratingError = err as HistoryMigratingError;
      expect(migratingError.status).toBe(409);
      expect(migratingError.code).toBe('history_migrating');
      expect(migratingError.state).toBe('migrating');
    }
  });

  test('never mutates the Page argument it was given', () => {
    const page = { historyTracking: { state: 'untracked' as const } };
    const snapshot = JSON.stringify(page);
    expect(() => requireHistoryReady(page)).toThrow(HistoryMigratingError);
    expect(JSON.stringify(page)).toBe(snapshot);
  });
});
