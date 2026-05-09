'use client';

import { Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorAlert } from '@/components/ui/error-alert';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { PluginConfigForm } from '@/components/admin/plugin-config-form';
import { useAdminPluginConfig } from '@/lib/use-admin-plugins';
import { m } from '@paraglide/messages.js';

/**
 * Single-plugin admin config page. Reached either from the dynamic
 * sidebar entry that the plugin contributes (e.g. "AWS S3") or from
 * the /admin/plugins list. The plugin name comes from the `?name=`
 * query string (path-encoding plugin names is brittle because they
 * contain `/`, see RFC-0001 round-2 notes).
 */
export default function AdminPluginEditPage() {
  return (
    <Suspense fallback={<LoadingSpinner />}>
      <PluginEditContent />
    </Suspense>
  );
}

function PluginEditContent() {
  const router = useRouter();
  const params = useSearchParams();
  const name = params.get('name');

  const { data, isLoading, error } = useAdminPluginConfig(name);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => router.push('/admin/plugins')}>
          <ArrowLeft className="h-4 w-4 mr-1" />
          {m['admin.plugins.back_to_list']()}
        </Button>
      </div>

      {!name && <ErrorAlert message={m['admin.plugins.edit_missing_name']()} />}
      {name && isLoading && <LoadingSpinner />}
      {name && !isLoading && error && <ErrorAlert message={error.message} />}
      {name && !isLoading && !error && data && (
        <Card>
          <CardHeader>
            <CardTitle className="font-mono">{data.name}</CardTitle>
            <CardDescription>{m['admin.plugins.edit_description']()}</CardDescription>
          </CardHeader>
          <CardContent>
            <PluginConfigForm config={data} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
