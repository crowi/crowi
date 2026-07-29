'use client';

import { use } from 'react';
import { PageList } from '@/components/page-list/page-list';
import { decodeRouteParamSegment } from '@/lib/page-path';
import { usePageTitle } from '@/lib/use-page-title';
import { m } from '@paraglide/messages.js';

interface TrashCatchAllPageProps {
  params: Promise<{ slug?: string[] }>;
}

export default function TrashCatchAllPage({ params }: TrashCatchAllPageProps) {
  const { slug } = use(params);

  // Build the API path the same way the legacy deletedPageListShow did:
  //   /trash + getPathFromRequest(req)  →  /trash/<sub>/  (always trailing-slashed)
  // For the bare /trash route the API path is just '/trash/'.
  //
  // Unlike the main catch-all (`[[...slug]]/page.tsx`), which reads
  // `usePathname()` (percent-encoded, needs `decodePagePathFromUrl`'s full
  // decode), `params.slug[]` segments here are already `decodeURIComponent`d
  // by Next's route matcher — using `decodePagePathFromUrl` again would
  // double-decode. `decodeRouteParamSegment` applies only the `+`-as-space
  // half of the contract, matching what this already-decoded input needs.
  const subSegments = (slug ?? []).map((segment) => decodeRouteParamSegment(segment));
  const subPath = subSegments.join('/');
  const path = subPath === '' ? '/trash/' : `/trash/${subPath}/`;

  usePageTitle(m['doc_title.trash']());

  return <PageList variant="trash" initialParams={{ path, include_deleted: true }} />;
}
