'use client';

import { use } from 'react';
import { notFound } from 'next/navigation';
import { IdRedirector } from '@/components/id-redirector';
import { isObjectId } from '@/lib/object-id';

interface IdRedirectAliasPageProps {
  params: Promise<{
    id: string;
  }>;
}

export default function IdRedirectAliasPage({ params }: IdRedirectAliasPageProps) {
  const { id } = use(params);

  if (!isObjectId(id)) {
    notFound();
  }

  return <IdRedirector pageId={id} />;
}
