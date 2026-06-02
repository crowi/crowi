'use client';

import { useEffect } from 'react';

/**
 * Mirror a page's `grant` onto `<html data-page-grant=...>` so the CSS in
 * globals.css (`--page-grant-accent`) can tint the header accent strip /
 * grant chip / lock icons for the page currently being viewed.
 *
 * Split into two effects so navigating between two grants of the same
 * level (or briefly passing through `undefined` during a refetch) doesn't
 * delete-then-rewrite the attribute — the value only updates on grant
 * change, and the attribute is only cleared on unmount.
 *
 * Shared by the single-page view and the portal view so both light the
 * accent strip consistently for non-public pages.
 */
export function usePageGrantAccent(grant: number | null | undefined): void {
  useEffect(() => {
    if (grant == null) return;
    document.documentElement.dataset.pageGrant = String(grant);
  }, [grant]);

  useEffect(() => {
    return () => {
      delete document.documentElement.dataset.pageGrant;
    };
  }, []);
}
