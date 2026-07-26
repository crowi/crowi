'use client';

import { useMediaQuery } from '@/lib/use-media-query';

/**
 * Live `md`-breakpoint (≥768px) viewport test.
 *
 * Use this ONLY where the two viewports must render different DOM — not
 * merely a different presentation of the same DOM. Responsive styling
 * belongs in Tailwind's `md:` utilities, which need no JS and no
 * hydration round-trip; this hook exists for the cases where a
 * `display: none` subtree is still wrong:
 *
 *   - `PageHeader`'s pre-title presence/TOC row, which must not exist at
 *     all below 768px (RFC-0005 round 3: the row itself, not just its
 *     contents — a `hidden` row still participates in the vertical
 *     rhythm's sibling chain, and its mobile-irrelevant children would
 *     still mount, run effects and hold state);
 *   - the editor's wide two-pane layout, where mounting both the wide and
 *     the narrow editor would mean two live editor instances.
 *
 * SSR/first-hydration snapshot is `false` (narrow) — see `useMediaQuery`.
 * React re-renders with the real value immediately after hydration, so a
 * wide viewport shows the narrow tree for at most one commit — acceptable
 * because both hosts are client-data-driven anyway (they render their
 * skeleton, not the final tree, during SSR).
 */
export const WIDE_VIEWPORT_QUERY = '(min-width: 768px)';

export function useWideViewport(): boolean {
  return useMediaQuery(WIDE_VIEWPORT_QUERY);
}
