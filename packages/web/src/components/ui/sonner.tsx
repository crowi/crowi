'use client';

import { useTheme } from 'next-themes';
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
 * Theme follows the *app* theme (`next-themes`) rather than sonner's
 * built-in `'system'` mode, so an explicit light/dark choice in the
 * Crowi theme toggle also flips the toasts. We pass `theme` through
 * directly: it is `'light' | 'dark' | 'system'`, matching sonner's
 * accepted values 1:1, and `undefined` before mount falls back to
 * sonner's default (`'system'`).
 */
export function Toaster(props: ToasterProps) {
  const { theme } = useTheme();
  return <SonnerToaster theme={theme as ToasterProps['theme']} position="bottom-right" richColors closeButton {...props} />;
}
