'use client';

import { type Locale, overwriteGetLocale } from '@paraglide/runtime.js';
import type { ReactNode } from 'react';

/**
 * Seeds the *client* module graph's `getLocale` with the per-request locale the
 * root layout resolved from the PARAGLIDE_LOCALE cookie.
 *
 * Next.js gives Server Components and Client Components separate module
 * instances even during SSR. The root layout (a Server Component) calls
 * `overwriteGetLocale`, but that only patches the RSC graph. Client Components
 * (e.g. the login form) resolve their `m[...]` strings through the *client*
 * graph's `getLocale`, which on the server cannot read `document.cookie`, so it
 * falls back to baseLocale (ja) during SSR and then flips to the cookie locale
 * (e.g. en) on hydration — React reports a hydration mismatch and the visible
 * text "switches" after load.
 *
 * Running `overwriteGetLocale` synchronously in this client component's render
 * body — as an ancestor of every localized Client Component — sets the locale
 * before any descendant renders, in the same pass, on both the server (client
 * graph) and the client. The `locale` prop is the same server-resolved value on
 * both sides, so the SSR output and the first client paint agree.
 */
export function LocaleBridge({ locale, children }: { locale: Locale; children: ReactNode }) {
  overwriteGetLocale(() => locale);
  return children;
}
