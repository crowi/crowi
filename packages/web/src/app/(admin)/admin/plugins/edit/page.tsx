'use client';

import { Suspense, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorAlert } from '@/components/ui/error-alert';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { ClearPluginRenderCacheButton } from '@/components/admin/plugin-clear-cache-button';
import { PluginConfigForm } from '@/components/admin/plugin-config-form';
import { PluginDepsBanner } from '@/components/admin/plugin-deps-banner';
import { useAdminPluginConfig, useAdminPluginConfigs, useAdminPlugins } from '@/lib/use-admin-plugins';
import { m } from '@paraglide/messages.js';

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
  const { data: pluginList } = useAdminPlugins();
  const currentPlugin = pluginList?.plugins.find((p) => p.name === name);
  const requires = useMemo(() => currentPlugin?.requires ?? [], [currentPlugin?.requires]);
  const depConfigQueries = useAdminPluginConfigs(requires);
  const depConfigs = requires.map((depName, i) => ({ name: depName, data: depConfigQueries[i]?.data }));

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
      {name && !isLoading && !error && data && pluginList && (
        <>
          <PluginDepsBanner requires={currentPlugin?.requires} installedPlugins={pluginList.plugins} depConfigs={depConfigs} />
          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-4">
              <div>
                <CardTitle className="font-mono">{data.name}</CardTitle>
                <CardDescription>{m['admin.plugins.edit_description']()}</CardDescription>
              </div>
              <ClearPluginRenderCacheButton pluginName={data.name} />
            </CardHeader>
            <CardContent>
              {/* key= forces a fresh useState snapshot when the URL plugin changes. */}
              <PluginConfigForm key={data.name} config={data} />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
