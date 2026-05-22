'use client';

import { use } from 'react';
import { PageList } from '@/components/page-list/page-list';
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
  const subSegments = (slug ?? []).map((segment) => decodeURIComponent(segment));
  const subPath = subSegments.join('/');
  const path = subPath === '' ? '/trash/' : `/trash/${subPath}/`;

  usePageTitle(m['doc_title.trash']());

  return <PageList variant="trash" initialParams={{ path, include_deleted: true }} />;
}
