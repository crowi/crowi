'use client';

import { Toaster as SonnerToaster, type ToasterProps } from 'sonner';

/**
 * Thin shadcn-style wrapper around `sonner`'s `<Toaster />`. Used by
 * the `(auth)` shell to host RFC-0003 Phase 7 connection-status
 * notifications (offline / reconnected / auth-failed).
 *
 * Position + theme defaults match Crowi's UI conventions:
 *   - bottom-right: out of the way of header/sidebar interactions
 *   - rich colours: distinguishes error / success at a glance
 *   - close button: lets users dismiss the persistent "offline" toast
 *     once they've seen it
 *
 * Theme follows the `prefers-color-scheme` system setting via sonner's
 * built-in `'system'` mode — Crowi's design tokens are CSS variables
 * already, so sonner's themed defaults blend in without explicit
 * colour overrides.
 */
export function Toaster(props: ToasterProps) {
  return <SonnerToaster theme="system" position="bottom-right" richColors closeButton {...props} />;
}
