'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * editor-preview-reliability §3 — local recovery buffer for the collab
 * editor.
 *
 * The realtime editor keeps the in-progress document in an in-memory
 * Y.Doc / CodeMirror buffer that is destroyed by any of:
 *   - `force-reload` (`window.location.reload()` after a server
 *     `crowi:force-reload` or a save `CONFLICT`),
 *   - the 20-editor-cap readonly flip (writes silently rejected),
 *   - `auth-failed` (the WebSocket is rejected; unsynced local edits
 *     never reached the server).
 *
 * In every one of those cases the user's most recent typing may only
 * exist in the browser. This hook periodically snapshots the current
 * editor text into `localStorage` (page-scoped, TTL'd) so that, after a
 * reload / recovery, we can offer to restore it. The buffer is the ONLY
 * sanctioned client-buffer use (the spec keeps the server Document as
 * the save source of truth — see the spec's architecture note); it never
 * feeds a save, only a restore proposal the user explicitly accepts.
 *
 * Storage shape (one key per page): `crowi:collab-recovery:<pageId>` →
 * `{ text, savedAt }`. We keep only the latest snapshot per page; the
 * TTL sweeps stale entries on read so a one-off crash doesn't leave a
 * forever-pending restore prompt.
 */

const KEY_PREFIX = 'crowi:collab-recovery:';

/** Default snapshot cadence — frequent enough to bound loss, cheap (one localStorage write). */
const DEFAULT_SNAPSHOT_INTERVAL_MS = 5_000;

/** Entries older than this are treated as expired and ignored / swept. */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

interface RecoveryEntry {
  text: string;
  savedAt: number;
}

export interface RecoverySnapshot {
  text: string;
  savedAt: number;
}

export interface UseCollabRecoveryBufferOptions {
  /** Page the buffer is scoped to. `null` disables the buffer (create flow). */
  pageId: string | null | undefined;
  /**
   * Live getter for the current editor text. Called on the snapshot
   * interval; return `null` to skip a snapshot (editor not ready). Keep
   * it cheap — it runs on a timer.
   */
  getText: () => string | null;
  /**
   * Whether snapshotting is active. Callers pass `synced && !readonly` so
   * we only snapshot a real editing session, and `dirty` so an untouched
   * doc doesn't overwrite a meaningful buffer with its seed text.
   */
  enabled: boolean;
  snapshotIntervalMs?: number;
  ttlMs?: number;
}

export interface UseCollabRecoveryBufferResult {
  /**
   * A restorable snapshot from a previous session for this page, or
   * `null` when none exists / it expired. Read once on mount; the caller
   * surfaces a "restore unsaved changes?" prompt and calls `clear()`
   * after the user accepts or dismisses.
   */
  recoverable: RecoverySnapshot | null;
  /** Force a snapshot now (e.g. just before a known-destructive reload). */
  snapshotNow: () => void;
  /** Drop the stored buffer for this page (after restore / dismiss). */
  clear: () => void;
}

function storageKey(pageId: string): string {
  return `${KEY_PREFIX}${pageId}`;
}

function readEntry(pageId: string, ttlMs: number): RecoveryEntry | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(storageKey(pageId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RecoveryEntry>;
    if (typeof parsed?.text !== 'string' || typeof parsed?.savedAt !== 'number') return null;
    if (Date.now() - parsed.savedAt > ttlMs) {
      // Expired — sweep it so a stale prompt never resurfaces.
      window.localStorage.removeItem(storageKey(pageId));
      return null;
    }
    return { text: parsed.text, savedAt: parsed.savedAt };
  } catch {
    // Corrupt JSON / disabled storage — treat as "nothing to recover".
    return null;
  }
}

function writeEntry(pageId: string, text: string): void {
  if (typeof window === 'undefined') return;
  // B3 — never snapshot an EMPTY doc as recoverable. An empty buffer would
  // later prompt "restore unsaved changes?" offering to replace the real
  // synced content with nothing. An empty recovery snapshot carries no
  // recoverable work, so a write of '' is a no-op (it also can't usefully
  // overwrite a meaningful earlier snapshot — see `snapshotNow` / the timer).
  if (text.length === 0) return;
  try {
    const entry: RecoveryEntry = { text, savedAt: Date.now() };
    window.localStorage.setItem(storageKey(pageId), JSON.stringify(entry));
  } catch {
    // Quota / disabled storage — best-effort, drop silently.
  }
}

function removeEntry(pageId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(storageKey(pageId));
  } catch {
    // ignore
  }
}

export function useCollabRecoveryBuffer(options: UseCollabRecoveryBufferOptions): UseCollabRecoveryBufferResult {
  const { pageId, getText, enabled } = options;
  const snapshotIntervalMs = options.snapshotIntervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;

  // Keep the live getter in a ref so the snapshot interval effect doesn't
  // re-subscribe on every parent render (the getter is usually an inline
  // closure with an unstable identity).
  const getTextRef = useRef(getText);
  useEffect(() => {
    getTextRef.current = getText;
  }, [getText]);

  // Read any prior snapshot ONCE on mount (per page). Reading after the
  // first snapshot write would echo back this session's own text.
  const [recoverable, setRecoverable] = useState<RecoverySnapshot | null>(null);
  useEffect(() => {
    // Reading the prior snapshot once on mount IS the external-resource
    // sync this effect exists for (localStorage is the external store) —
    // the classic "subscribe + publish" shape the lint rule exempts in
    // spirit. We seed state from localStorage exactly when `pageId`
    // changes; same pattern as `use-presence.ts`'s mount reset.
    if (!pageId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRecoverable(null);
      return;
    }
    setRecoverable(readEntry(pageId, ttlMs));
  }, [pageId, ttlMs]);

  const snapshotNow = useCallback(() => {
    if (!pageId) return;
    const text = getTextRef.current();
    if (text == null) return;
    writeEntry(pageId, text);
  }, [pageId]);

  const clear = useCallback(() => {
    if (!pageId) return;
    removeEntry(pageId);
    setRecoverable(null);
  }, [pageId]);

  // Periodic snapshot while an active editing session is enabled.
  useEffect(() => {
    if (!pageId || !enabled) return;
    const timer = setInterval(() => {
      const text = getTextRef.current();
      if (text == null) return;
      writeEntry(pageId, text);
    }, snapshotIntervalMs);
    return () => clearInterval(timer);
  }, [pageId, enabled, snapshotIntervalMs]);

  // Best-effort final snapshot on tab close / hide — `pagehide` covers
  // the bfcache + actual unload, `visibilitychange` the background tab.
  useEffect(() => {
    if (!pageId || !enabled) return;
    const flush = () => {
      const text = getTextRef.current();
      if (text == null) return;
      writeEntry(pageId, text);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [pageId, enabled]);

  return { recoverable, snapshotNow, clear };
}
