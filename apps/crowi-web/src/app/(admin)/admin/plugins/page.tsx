'use client';

import { Loader2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorAlert } from '@/components/ui/error-alert';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { PluginConfigForm } from '@/components/admin/plugin-config-form';
import { useAdminPluginConfig, useAdminPlugins } from '@/lib/use-admin-plugins';
import type { PluginInfo } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';

export default function AdminPluginsPage() {
  const { data, isLoading, error } = useAdminPlugins();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{m['admin.plugins.heading']()}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{m['admin.plugins.lead']()}</p>
      </div>

      {isLoading && <LoadingSpinner />}
      {!isLoading && error && <ErrorAlert message={error.message} />}

      {!isLoading && !error && data && data.plugins.length === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{m['admin.plugins.empty_title']()}</CardTitle>
            <CardDescription>{m['admin.plugins.empty_body']()}</CardDescription>
          </CardHeader>
        </Card>
      )}

      {!isLoading && !error && data && data.plugins.length > 0 && (
        <div className="space-y-4">
          {data.plugins.map((plugin) => (
            <PluginCard key={plugin.name} plugin={plugin} />
          ))}
        </div>
      )}
    </div>
  );
}

interface PluginCardProps {
  plugin: PluginInfo;
}

function PluginCard({ plugin }: PluginCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-mono text-base">
          {plugin.name}
          <span className="text-muted-foreground ml-2 text-xs">v{plugin.version}</span>
        </CardTitle>
        <CardDescription>
          <PluginMetaLine plugin={plugin} />
        </CardDescription>
      </CardHeader>
      <CardContent>
        {plugin.hasConfig ? <PluginConfigSection name={plugin.name} /> : <p className="text-muted-foreground text-sm">{m['admin.plugins.no_config']()}</p>}
      </CardContent>
    </Card>
  );
}

function PluginMetaLine({ plugin }: { plugin: PluginInfo }) {
  const parts: React.ReactNode[] = [];
  if (plugin.registers && plugin.registers.length > 0) {
    parts.push(
      <span key="registers">
        <strong>{m['admin.plugins.column_registers']()}: </strong>
        {plugin.registers.join(', ')}
      </span>,
    );
  }
  if (plugin.requires && plugin.requires.length > 0) {
    parts.push(
      <span key="requires">
        <strong>{m['admin.plugins.column_requires']()}: </strong>
        {plugin.requires.join(', ')}
      </span>,
    );
  }
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
      {parts.map((part, i) => (
        <span key={i}>{part}</span>
      ))}
    </div>
  );
}

function PluginConfigSection({ name }: { name: string }) {
  const { data, isLoading, error } = useAdminPluginConfig(name);
  if (isLoading)
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  if (error) return <ErrorAlert message={error.message} />;
  if (!data) return null;
  return <PluginConfigForm config={data} />;
}
