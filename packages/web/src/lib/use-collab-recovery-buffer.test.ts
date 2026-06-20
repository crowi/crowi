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
