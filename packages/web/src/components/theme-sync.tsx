'use client';

import { useTheme } from 'next-themes';
import { useEffect, useRef } from 'react';
import { ThemeSchema, type Theme } from '@crowi/api-contract';
import { useProfile, useUpdateTheme } from '@/lib/use-profile';

// `ThemeSchema` (the api-contract Zod enum) is the single source of truth for
// the accepted theme values, so the guard can't drift from the wire contract.
function isTheme(value: string | undefined): value is Theme {
  return ThemeSchema.safeParse(value).success;
}

/**
 * Reconciles `next-themes` (per-device, localStorage) with the authenticated
 * user's `User.theme` (cross-device). Mounts inside the auth layouts so it
 * only runs for signed-in users. Mirrors `LocaleSync`, with one extra job:
 * because the theme toggle drives `next-themes` directly (there is no profile
 * form to hook a write-back onto, unlike `lang`), `ThemeSync` also pushes
 * local changes back to the server.
 *
 * Two phases, gated to avoid a reconcile→push feedback loop:
 *
 *  1. On first load, once the profile resolves, adopt the server value as the
 *     source of truth: if it differs from the current `next-themes` theme,
 *     `setTheme(server)`. `next-themes` has already applied the localStorage
 *     value pre-hydration (so no FOUC); this only corrects a device whose
 *     local choice diverges from the account. `lastSynced` is seeded with the
 *     adopted value so the change `setTheme` triggers is not echoed back.
 *  2. After reconcile, any further `theme` change (a real toggle interaction)
 *     that differs from `lastSynced` is PATCHed to the server and recorded.
 */
export function ThemeSync() {
  const { data: profile } = useProfile();
  const { theme, setTheme } = useTheme();
  // Destructure the stable `mutate` reference: the mutation object itself is a
  // fresh identity every render, so depending on it would re-run the Phase 2
  // effect on every render. `mutate` is referentially stable (react-query).
  const { mutate: persistTheme } = useUpdateTheme();

  const reconciled = useRef(false);
  // Last theme value we know the server holds; suppresses pushing back the
  // value we just adopted from the server during reconciliation.
  const lastSynced = useRef<Theme | null>(null);

  // Phase 1: adopt the server value once the profile is available.
  useEffect(() => {
    if (reconciled.current) return;
    if (!profile) return;

    const serverTheme: Theme = isTheme(profile.theme) ? profile.theme : 'system';
    reconciled.current = true;
    lastSynced.current = serverTheme;

    if (isTheme(theme) && theme !== serverTheme) {
      setTheme(serverTheme);
    }
  }, [profile, theme, setTheme]);

  // Phase 2: push local toggle changes to the server.
  useEffect(() => {
    if (!reconciled.current) return;
    if (!isTheme(theme)) return;
    if (theme === lastSynced.current) return;

    lastSynced.current = theme;
    persistTheme(theme);
  }, [theme, persistTheme]);

  return null;
}
