'use client';

import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import type { ListPluginsResponse, PluginConfigResponse, PluginField } from '@crowi/api-contract';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { m } from '@paraglide/messages.js';
import { PLUGIN_WARNING_ALERT_CLASS, PLUGIN_WARNING_ALERT_DESCRIPTION_CLASS } from './plugin-warning-alert-styles';

interface PluginDepsBannerProps {
  requires: string[] | undefined;
  installedPlugins: ListPluginsResponse['plugins'];
  depConfigs: { name: string; data: PluginConfigResponse | undefined }[];
}

interface MissingBanner {
  kind: 'missing';
  depName: string;
}

interface IncompleteBanner {
  kind: 'incomplete';
  depName: string;
  unsetFields: string[];
}

type Banner = MissingBanner | IncompleteBanner;

export function PluginDepsBanner({ requires, installedPlugins, depConfigs }: PluginDepsBannerProps) {
  if (!requires || requires.length === 0) return null;

  const banners: Banner[] = [];
  for (const depName of requires) {
    const installed = installedPlugins.some((p) => p.name === depName);
    if (!installed) {
      banners.push({ kind: 'missing', depName });
      continue;
    }
    const config = depConfigs.find((c) => c.name === depName)?.data;
    if (!config) continue;

    const unsetFields = config.fields.filter((field) => !field.optional && !isFieldValueSet(config.values[field.name], field.kind)).map((field) => field.name);

    if (unsetFields.length > 0) {
      banners.push({ kind: 'incomplete', depName, unsetFields });
    }
  }

  if (banners.length === 0) return null;

  return (
    <div className="space-y-3">
      {banners.map((b) => (
        <BannerRow key={b.depName} banner={b} />
      ))}
    </div>
  );
}

function BannerRow({ banner }: { banner: Banner }) {
  const href = `/admin/plugins/edit?name=${encodeURIComponent(banner.depName)}`;

  return (
    <Alert className={PLUGIN_WARNING_ALERT_CLASS}>
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>{titleFor(banner)}</AlertTitle>
      <AlertDescription className={PLUGIN_WARNING_ALERT_DESCRIPTION_CLASS}>
        {banner.kind === 'missing' ? (
          m['admin.plugins.deps_hint_missing_body']({ cmd: `crowi-admin plugin add ${banner.depName}` })
        ) : (
          <Link href={href} className="underline underline-offset-2 hover:no-underline">
            {m['admin.plugins.deps_hint_incomplete_link']({ name: banner.depName })}
          </Link>
        )}
      </AlertDescription>
    </Alert>
  );
}

function titleFor(banner: Banner): string {
  if (banner.kind === 'missing') {
    return m['admin.plugins.deps_hint_missing_title']({ name: banner.depName });
  }
  return m['admin.plugins.deps_hint_incomplete_title']({
    name: banner.depName,
    fields: banner.unsetFields.join(' / '),
  });
}

// `false` and `0` are valid values for boolean / number fields; only
// empty / null / undefined should count as unset.
function isFieldValueSet(value: unknown, kind: PluginField['kind']): boolean {
  if (kind === 'secret') {
    const meta = value as { hasValue?: boolean } | null | undefined;
    return Boolean(meta?.hasValue);
  }
  if (value === null || value === undefined) return false;
  if (typeof value === 'string' && value === '') return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}
