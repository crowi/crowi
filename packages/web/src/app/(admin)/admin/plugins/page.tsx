'use client';

import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import type { PluginInfo } from '@crowi/api-contract';
import { ClearAllRenderCacheButton } from '@/components/admin/plugin-clear-cache-button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorAlert } from '@/components/ui/error-alert';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { useAdminPlugins } from '@/lib/use-admin-plugins';
import { m } from '@paraglide/messages.js';

/**
 * Plugin list view. Each loaded plugin shows up here as a row with
 * its npm name, version, registers list, and a click target that
 * routes to `/admin/plugins/edit?name=<name>` for the auto-form.
 *
 * Plugin config is also reachable directly from the dynamic sidebar
 * entries each plugin contributes (storage / mail / notification /
 * auth domain sections plus the "shared services" section). This page
 * exists for power-user-style "show me everything that's installed"
 * navigation.
 */
export default function AdminPluginsPage() {
  const { data, isLoading, error } = useAdminPlugins();

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{m['admin.plugins.heading']()}</h1>
          <p className="text-muted-foreground mt-1 text-sm">{m['admin.plugins.lead']()}</p>
        </div>
        <ClearAllRenderCacheButton />
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
        <Card>
          <CardContent className="p-0">
            <ul className="divide-y">
              {data.plugins.map((plugin) => (
                <li key={plugin.name}>
                  <PluginRow plugin={plugin} />
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

interface PluginRowProps {
  plugin: PluginInfo;
}

function PluginRow({ plugin }: PluginRowProps) {
  const isFailed = plugin.status === 'failed';
  // A failed plugin never made it into the loaded set (see
  // `PluginManager.getFailedPlugins()`), so its config form (which reads
  // `manager.getLoadedPlugin(name)`) has nothing to show — don't link there.
  const href = !isFailed && plugin.hasConfig ? `/admin/plugins/edit?name=${encodeURIComponent(plugin.name)}` : null;

  const inner = (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium">{plugin.adminPlacement.label}</span>
          <span className="text-muted-foreground text-xs font-mono truncate">{plugin.name}</span>
          <span className="text-muted-foreground text-xs">v{plugin.version}</span>
          {isFailed && (
            <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive" title={plugin.error}>
              {m['admin.plugins.status_failed_badge']()}
            </span>
          )}
        </div>
        <PluginRowMeta plugin={plugin} />
      </div>
      {href && <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />}
    </div>
  );

  if (!href) return inner;
  return (
    <Link href={href} className="block hover:bg-muted/50 transition-colors">
      {inner}
    </Link>
  );
}

function PluginRowMeta({ plugin }: { plugin: PluginInfo }) {
  const parts: string[] = [];
  parts.push(`${m['admin.plugins.column_section']()}: ${plugin.adminPlacement.section}`);
  if (plugin.registers.length > 0) parts.push(`${m['admin.plugins.column_registers']()}: ${plugin.registers.join(', ')}`);
  if (plugin.requires && plugin.requires.length > 0) parts.push(`${m['admin.plugins.column_requires']()}: ${plugin.requires.join(', ')}`);
  if (plugin.modelAccess && plugin.modelAccess.length > 0) parts.push(`${m['admin.plugins.column_model_access']()}: ${plugin.modelAccess.join(', ')}`);
  if (!plugin.hasConfig) parts.push(m['admin.plugins.no_config']());
  if (plugin.status === 'failed' && plugin.error) parts.push(m['admin.plugins.status_failed_reason']({ message: plugin.error }));
  return <p className="text-muted-foreground text-xs mt-0.5">{parts.join(' / ')}</p>;
}
