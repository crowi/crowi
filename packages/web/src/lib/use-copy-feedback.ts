'use client';

import { m } from '@paraglide/messages.js';
import { useCallback, useEffect, useRef, useState } from 'react';

const DEFAULT_FEEDBACK_MS = 1500;

/**
 * Why a copy failed, so the caller can pick a reason-specific message
 * instead of a generic "failed":
 * - `unavailable` — `navigator.clipboard` doesn't exist. An environment
 *   problem (typically a non-secure origin); the caller should point at
 *   HTTPS.
 * - `rejected` — `writeText` rejected (permission denial, browser quirk).
 *   The cause isn't known, so the caller must not guess at one.
 */
export type CopyFailureReason = 'unavailable' | 'rejected';

/**
 * Localizes a `CopyFailureReason`, or `null` when there is none — callers
 * combine it with their own idle/success labels via `?? <idle label>`
 * instead of repeating the reason branches at every call site.
 */
export function copyFailureMessage(failed: CopyFailureReason | null): string | null {
  switch (failed) {
    case 'unavailable':
      return m['common.copy_unavailable']();
    case 'rejected':
      return m['common.copy_failed']();
    default:
      return null;
  }
}

/**
 * Copy `text` to the clipboard and flash a transient `copied` (success) or
 * `failed` (failure reason) flag for `feedbackMs` (icon/label swap). The two
 * are mutually exclusive and both reset — synchronously, before the new
 * attempt starts — on every `copy()` call, so a second click never shows a
 * stale result from the previous one.
 *
 * `writeText` settlement order isn't guaranteed to match call order (two
 * overlapping `copy()` calls can resolve out of turn), and a settlement can
 * also arrive after unmount. Both are handled the same way: each `copy()`
 * call — and unmount itself — bumps an attempt counter, and a settlement
 * only applies if it's still the current attempt. A stale settlement (from
 * a superseded attempt or a settle-after-unmount) is a no-op: it neither
 * touches state nor starts a reset timer.
 *
 * Shared by the heading-anchor copy button, code-block copy button,
 * `RestrictedShareBanner`, `CopyPageMarkdownButton`, and the MCP setup
 * section; the keyed multi-row variant in `link-share-popover` keeps its
 * own state.
 */
export function useCopyFeedback(feedbackMs = DEFAULT_FEEDBACK_MS) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState<CopyFailureReason | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);

  useEffect(
    () => () => {
      attemptRef.current += 1;
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const settle = useCallback(
    (attempt: number, next: { copied: boolean; failed: CopyFailureReason | null }) => {
      if (attempt !== attemptRef.current) return;
      if (timerRef.current) clearTimeout(timerRef.current);
      setCopied(next.copied);
      setFailed(next.failed);
      timerRef.current = setTimeout(() => {
        setCopied(false);
        setFailed(null);
      }, feedbackMs);
    },
    [feedbackMs],
  );

  const copy = useCallback(
    (text: string) => {
      const attempt = ++attemptRef.current;
      if (timerRef.current) clearTimeout(timerRef.current);
      setCopied(false);
      setFailed(null);

      // Bumping the attempt and resetting state above (before this check)
      // matters even for a no-op call: it invalidates whatever attempt is
      // still pending, so that attempt's late settlement can't revive a
      // display the user has already moved past.
      if (!text || typeof navigator === 'undefined') return;

      // No optional-chaining short-circuit here: an absent
      // `navigator.clipboard` (any non-secure-origin self-host) must
      // surface as a reported failure, not a silent no-op.
      if (!navigator.clipboard) {
        settle(attempt, { copied: false, failed: 'unavailable' });
        return;
      }

      navigator.clipboard
        .writeText(text)
        .then(() => settle(attempt, { copied: true, failed: null }))
        .catch(() => settle(attempt, { copied: false, failed: 'rejected' }));
    },
    [settle],
  );

  return { copied, failed, copy };
}
