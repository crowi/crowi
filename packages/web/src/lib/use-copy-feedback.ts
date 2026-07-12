'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const DEFAULT_FEEDBACK_MS = 1500;

/**
 * Copy `text` to the clipboard and flash a transient `copied` flag for
 * `feedbackMs` (icon swap / "Copied" label). The reset timer is held in a
 * ref and cleared on re-copy and on unmount, so a late `setCopied(false)`
 * never lands on an unmounted component. Clipboard failures (insecure
 * context / denied) are swallowed — `copied` simply stays `false`.
 *
 * Shared by the heading-anchor copy button, code-block copy button, and
 * `RestrictedShareBanner`; the keyed multi-row variant in
 * `link-share-popover` keeps its own state.
 */
export function useCopyFeedback(feedbackMs = DEFAULT_FEEDBACK_MS) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const copy = useCallback(
    (text: string) => {
      if (!text || typeof navigator === 'undefined') return;
      navigator.clipboard
        ?.writeText(text)
        .then(() => {
          setCopied(true);
          if (timerRef.current) clearTimeout(timerRef.current);
          timerRef.current = setTimeout(() => setCopied(false), feedbackMs);
        })
        .catch(() => {});
    },
    [feedbackMs],
  );

  return { copied, copy };
}
