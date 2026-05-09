'use client';

import { useEffect, useRef } from 'react';
import { getLocale, setLocale, locales, type Locale } from '@paraglide/runtime.js';
import { useProfile } from '@/lib/use-profile';

/**
 * Map a `User.lang` value (which can be a regional variant like `en-US` /
 * `en-GB`) onto a paraglide locale we actually have messages for.
 */
function profileLangToLocale(lang: string | undefined | null): Locale | null {
  if (!lang) return null;
  const lower = lang.toLowerCase().replace('_', '-');
  if (locales.includes(lower as Locale)) return lower as Locale;
  const base = lower.split('-')[0];
  return locales.includes(base as Locale) ? (base as Locale) : null;
}

/**
 * Reconciles the paraglide cookie with the authenticated user's
 * configured `lang`. Mounts inside the auth layouts so it only runs
 * for signed-in users; on a mismatch it calls `setLocale` (which
 * reloads the page so Server Components re-render with the new
 * strings).
 */
export function LocaleSync() {
  const { data: profile } = useProfile();
  const synced = useRef(false);

  useEffect(() => {
    if (synced.current) return;
    if (!profile?.lang) return;
    const target = profileLangToLocale(profile.lang);
    if (!target || target === getLocale()) {
      synced.current = true;
      return;
    }
    synced.current = true;
    setLocale(target);
  }, [profile?.lang]);

  return null;
}
