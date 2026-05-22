'use client';

import { useEffect } from 'react';
import { useAppInfo } from './use-app-info';

/** Fixed product name — always the last segment of the document title. */
const PRODUCT_NAME = 'Crowi';

/**
 * Sets `document.title` to `<name> - <wikiName?> - Crowi`.
 *
 * `wikiName` is the operator-configured site title (`appInfo.title`); it is
 * dropped when unset. Pass `null` / `undefined` for `name` to drop the
 * leading segment too — used by the top page, where the path segment would
 * be empty.
 *
 * Document-title-only (not Next.js metadata): the app is client-rendered and
 * route data is fetched via react-query, so a server-side `generateMetadata`
 * cannot know the title. The static `<title>Crowi</title>` from the root
 * layout is the SSR fallback until this effect runs on the client.
 */
export function usePageTitle(name: string | null | undefined): void {
  const { data: appInfo } = useAppInfo();
  const wikiName = appInfo?.title ?? null;

  useEffect(() => {
    const segments = [name, wikiName, PRODUCT_NAME].filter((s): s is string => Boolean(s && s.trim()));
    document.title = segments.join(' - ');
  }, [name, wikiName]);
}
