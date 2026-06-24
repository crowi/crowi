import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCollabRecoveryBuffer } from './use-collab-recovery-buffer';

/**
 * editor-preview-reliability §3 — local recovery buffer tests. Drives
 * the hook against the jsdom `localStorage` (real, per-test reset by
 * vitest's `restoreMocks` + an explicit clear).
 */

const KEY = (pageId: string) => `crowi:collab-recovery:${pageId}`;

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
  cleanup();
});

describe('useCollabRecoveryBuffer', () => {
  it('snapshots the editor text to localStorage on the interval while enabled', () => {
    let text = 'hello';
    renderHook(() =>
      useCollabRecoveryBuffer({
        pageId: 'p1',
        getText: () => text,
        enabled: true,
        snapshotIntervalMs: 1000,
      }),
    );

    expect(window.localStorage.getItem(KEY('p1'))).toBeNull();
    text = 'hello world';
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    const stored = JSON.parse(window.localStorage.getItem(KEY('p1'))!);
    expect(stored.text).toBe('hello world');
    expect(typeof stored.savedAt).toBe('number');
  });

  it('does not snapshot while disabled', () => {
    renderHook(() =>
      useCollabRecoveryBuffer({
        pageId: 'p1',
        getText: () => 'unsaved',
        enabled: false,
        snapshotIntervalMs: 1000,
      }),
    );
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(window.localStorage.getItem(KEY('p1'))).toBeNull();
  });

  it('snapshotNow writes immediately', () => {
    const { result } = renderHook(() =>
      useCollabRecoveryBuffer({
        pageId: 'p1',
        getText: () => 'flush me',
        enabled: false,
      }),
    );
    act(() => {
      result.current.snapshotNow();
    });
    expect(JSON.parse(window.localStorage.getItem(KEY('p1'))!).text).toBe('flush me');
  });

  it('surfaces a prior snapshot as `recoverable` on mount and clears it on demand', () => {
    window.localStorage.setItem(KEY('p1'), JSON.stringify({ text: 'recovered draft', savedAt: Date.now() }));
    const { result } = renderHook(() =>
      useCollabRecoveryBuffer({
        pageId: 'p1',
        getText: () => null,
        enabled: false,
      }),
    );
    expect(result.current.recoverable?.text).toBe('recovered draft');

    act(() => {
      result.current.clear();
    });
    expect(result.current.recoverable).toBeNull();
    expect(window.localStorage.getItem(KEY('p1'))).toBeNull();
  });

  it('ignores an expired snapshot (TTL) and sweeps it', () => {
    const stale = Date.now() - 48 * 60 * 60 * 1000; // 48h ago
    window.localStorage.setItem(KEY('p1'), JSON.stringify({ text: 'old', savedAt: stale }));
    const { result } = renderHook(() =>
      useCollabRecoveryBuffer({
        pageId: 'p1',
        getText: () => null,
        enabled: false,
        ttlMs: 24 * 60 * 60 * 1000,
      }),
    );
    expect(result.current.recoverable).toBeNull();
    expect(window.localStorage.getItem(KEY('p1'))).toBeNull();
  });

  it('M2 regression: after clear() (save success / explicit discard) a fresh mount sees no recoverable snapshot', () => {
    // M2 was: the recovery buffer was never cleared on a successful save or
    // an explicit discard, so the 24h TTL left a stale snapshot that
    // spuriously prompted "restore unsaved changes?" on the next mount (and
    // could restore over newer content). `edit-page-client` now calls
    // `recovery.clear()` in both branches; this asserts the hook contract
    // those calls rely on — once cleared, a later mount surfaces nothing.
    const { result, unmount } = renderHook(() =>
      useCollabRecoveryBuffer({
        pageId: 'p1',
        getText: () => 'about to be saved',
        enabled: false,
      }),
    );
    act(() => {
      result.current.snapshotNow();
    });
    expect(window.localStorage.getItem(KEY('p1'))).not.toBeNull();

    // Simulate the save-success / discard path.
    act(() => {
      result.current.clear();
    });
    unmount();

    // A fresh mount (re-open the page) must NOT surface the cleared buffer.
    const { result: remounted } = renderHook(() =>
      useCollabRecoveryBuffer({
        pageId: 'p1',
        getText: () => null,
        enabled: false,
      }),
    );
    expect(remounted.current.recoverable).toBeNull();
  });

  it('B3: never snapshots an EMPTY doc (would offer to replace real content with nothing)', () => {
    // An empty buffer must not be written — a later mount would otherwise
    // prompt "restore unsaved changes?" offering to replace the synced
    // content with an empty string. Both the interval and `snapshotNow`
    // must skip an empty getText.
    let text = '';
    const { result } = renderHook(() =>
      useCollabRecoveryBuffer({
        pageId: 'p1',
        getText: () => text,
        enabled: true,
        snapshotIntervalMs: 1000,
      }),
    );

    act(() => {
      vi.advanceTimersByTime(2000);
      result.current.snapshotNow();
    });
    expect(window.localStorage.getItem(KEY('p1'))).toBeNull();

    // Once it has real content, snapshotting resumes.
    text = 'now there is content';
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(JSON.parse(window.localStorage.getItem(KEY('p1'))!).text).toBe('now there is content');
  });

  it('B2: keeps snapshotting while enabled even after a transient sync dip (the caller gates on hasEverSynced)', () => {
    // The B2 contract the hook relies on: snapshotting is driven by the
    // `enabled` flag the caller passes (`hasEverSynced && !readonly && dirty`,
    // NOT the live `synced`), so offline edits during a transient disconnect
    // are still captured. We simulate "still enabled while offline" and assert
    // the timer keeps writing.
    let text = 'edited while offline';
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useCollabRecoveryBuffer({ pageId: 'p1', getText: () => text, enabled, snapshotIntervalMs: 1000 }),
      {
        initialProps: { enabled: true },
      },
    );

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(JSON.parse(window.localStorage.getItem(KEY('p1'))!).text).toBe('edited while offline');

    // Further offline edits keep being snapshotted while enabled.
    text = 'more offline edits';
    rerender({ enabled: true });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(JSON.parse(window.localStorage.getItem(KEY('p1'))!).text).toBe('more offline edits');
    expect(result.current.recoverable).toBeNull(); // own-session snapshots aren't surfaced as recoverable
  });

  it('tail (round 3): clear() cancels the armed interval so a pending tick cannot resurrect the cleared buffer', () => {
    // The race: `clear()` removes the entry + sets recoverable=null, but the
    // still-armed 5s snapshot interval (active while `enabled`) fires moments
    // later and re-writes the buffer we just cleared, resurrecting a stale
    // "restore unsaved changes?" prompt on the next mount. `clear()` must
    // cancel the timer + suppress the flush handlers until the next enable
    // cycle re-arms them.
    const text = 'unsaved work';
    const { result } = renderHook(() =>
      useCollabRecoveryBuffer({
        pageId: 'p1',
        getText: () => text,
        enabled: true,
        snapshotIntervalMs: 1000,
      }),
    );

    // First tick writes the buffer.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(window.localStorage.getItem(KEY('p1'))).not.toBeNull();

    // Clear (e.g. the user restored / discarded). The interval is still armed
    // (enabled is unchanged), so without the fix the next tick would re-write.
    act(() => {
      result.current.clear();
    });
    expect(window.localStorage.getItem(KEY('p1'))).toBeNull();

    // Advance well past several interval periods — the cancelled timer must
    // not resurrect the buffer.
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(window.localStorage.getItem(KEY('p1'))).toBeNull();

    // A deliberate snapshotNow lifts suppression so the buffer can be kept
    // fresh again (the user is editing once more).
    act(() => {
      result.current.snapshotNow();
    });
    expect(JSON.parse(window.localStorage.getItem(KEY('p1'))!).text).toBe('unsaved work');
  });

  it('is a no-op when pageId is null (create flow)', () => {
    const { result } = renderHook(() =>
      useCollabRecoveryBuffer({
        pageId: null,
        getText: () => 'x',
        enabled: true,
        snapshotIntervalMs: 500,
      }),
    );
    act(() => {
      vi.advanceTimersByTime(2000);
      result.current.snapshotNow();
    });
    expect(window.localStorage.length).toBe(0);
    expect(result.current.recoverable).toBeNull();
  });
});
