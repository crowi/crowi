'use client';

import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState } from 'react';
import { MAIN_CONTENT_ID } from '@/lib/use-route-focus';
import { READING_WIDTH_ATTRIBUTE, READING_WIDTH_STORAGE_KEY, type ReadingWidth, parseReadingWidth } from '@/lib/reading-width';

export interface ReadingWidthContextValue {
  preference: ReadingWidth;
  setPreference: (next: ReadingWidth) => void;
}

const ReadingWidthContext = createContext<ReadingWidthContextValue>({ preference: 'standard', setPreference: () => {} });

export function useReadingWidth(): ReadingWidthContextValue {
  return useContext(ReadingWidthContext);
}

/** Moves focus to the `<main>` landmark without scrolling. */
export function focusMainContent(): void {
  document.getElementById(MAIN_CONTENT_ID)?.focus({ preventScroll: true });
}

/** Connected, not inert, and rendered: a control focus can legitimately rest on. */
export function isFocusTarget(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement) || !el.isConnected || el === document.body) return false;
  if (el.closest('[inert]')) return false;
  return el.checkVisibility?.({ visibilityProperty: true }) ?? true;
}

// Elements the width change can hide; focus left on one would be stranded.
const HIDEABLE_SELECTOR = '[data-reading-left-rail], [data-reading-right-rail], [data-reading-toc-control], [data-reading-width-toggle]';

/**
 * Owns the reading-width preference for the authenticated shell. The server
 * and the first client render both use `standard`; the real value is the
 * attribute the `<head>` bootstrap already put on `<html>`, adopted in a
 * layout effect so it lands before the first paint. The attribute is only
 * written back once that adoption is done, otherwise the initial `standard`
 * would clobber the bootstrapped value.
 */
export function ReadingWidthProvider({ children }: { children: React.ReactNode }) {
  const [preference, setPreferenceState] = useState<ReadingWidth>('standard');
  const [initialized, setInitialized] = useState(false);

  useLayoutEffect(() => {
    // The SSR markup must match hydration (always `standard`), while the
    // stored width must apply before paint: adopting it here is the only
    // point that satisfies both.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPreferenceState(parseReadingWidth(document.documentElement.getAttribute(READING_WIDTH_ATTRIBUTE)));
    setInitialized(true);
  }, []);

  useLayoutEffect(() => {
    if (!initialized) return;
    const root = document.documentElement;
    if (root.getAttribute(READING_WIDTH_ATTRIBUTE) === preference) return;
    const before = document.activeElement;
    const guarded = before instanceof HTMLElement && before !== document.body ? before.closest(HIDEABLE_SELECTOR) : null;
    root.setAttribute(READING_WIDTH_ATTRIBUTE, preference);
    // A visible width toggle that already holds focus keeps it; anything else
    // that the new width just hid hands focus to <main>.
    if (guarded && !guarded.matches('[data-reading-width-toggle]') && !isFocusTarget(before)) focusMainContent();
  }, [initialized, preference]);

  const setPreference = useCallback((next: ReadingWidth) => {
    setPreferenceState(next);
    try {
      window.localStorage.setItem(READING_WIDTH_STORAGE_KEY, next);
    } catch {
      // Storage may be unavailable; the choice still holds for this document.
    }
  }, []);

  const value = useMemo(() => ({ preference, setPreference }), [preference, setPreference]);
  return <ReadingWidthContext.Provider value={value}>{children}</ReadingWidthContext.Provider>;
}
