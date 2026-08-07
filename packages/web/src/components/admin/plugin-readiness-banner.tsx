'use client';

import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import type { ConfigReadinessIssue } from '@crowi/api-contract';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { cn } from '@/lib/utils';
import { useAdminPluginReadiness } from '@/lib/use-admin-plugins';
import { m } from '@paraglide/messages.js';
import { PLUGIN_WARNING_ALERT_CLASS, PLUGIN_WARNING_ALERT_DESCRIPTION_CLASS } from './plugin-warning-alert-styles';

interface PluginReadinessBannerProps {
  /**
   * Whether the current user is an admin. The readiness query is only
   * enabled when this is `true` — a non-admin (or a still-resolving
   * auth state) never issues the `GET /admin/plugins/readiness`
   * request, matching the "non-admin never sees the banner or triggers
   * the endpoint" invariant (AC-5).
   */
  isAdmin: boolean;
  /**
   * Extra classes for the outer wrapper — callers pass their own
   * content-width convention (`max-w-4xl` for the wiki shell,
   * `max-w-7xl` for the admin shell) so the banner lines up with the
   * header above it in either layout.
   */
  containerClassName?: string;
}

/**
 * Shared wiki + admin banner (feature-plugin-config-readiness,
 * feature-core-config-readiness-and-mail): surfaces active plugins whose
 * own `readiness` declaration says required config is still unset — S3
 * with no `bucket`, an active search driver with no `url`, etc. — plus
 * core config declarations that are unset (e.g. `mail:from`). Both
 * `source`s render identically here (generic `label`/`href`/`fields`);
 * the distinction only matters to the admin plugins list page, which
 * shows plugin issues inline on their own row and excludes core issues.
 * Renders nothing for a non-admin, while auth/readiness are still
 * loading, or when nothing is unset. Never renders a field's value —
 * only its name — and only ever links to the server-supplied `href`
 * (a plugin's own config-edit screen, or a core screen like `/admin/mail`).
 */
export function PluginReadinessBanner({ isAdmin, containerClassName }: PluginReadinessBannerProps) {
  const { data } = useAdminPluginReadiness(isAdmin);
  const issues = data?.issues ?? [];

  if (!isAdmin || issues.length === 0) return null;

  return (
    <div className={cn('space-y-3 px-4 pt-3', containerClassName)}>
      {issues.map((issue) => (
        <PluginReadinessBannerRow key={issue.id} issue={issue} />
      ))}
    </div>
  );
}

function PluginReadinessBannerRow({ issue }: { issue: ConfigReadinessIssue }) {
  const fieldNames = issue.fields.map((field) => field.name).join(' / ');
  const label = issue.label;

  return (
    <Alert className={PLUGIN_WARNING_ALERT_CLASS}>
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>{m['admin.plugins.readiness_banner_title']({ name: label, fields: fieldNames })}</AlertTitle>
      <AlertDescription className={PLUGIN_WARNING_ALERT_DESCRIPTION_CLASS}>
        <Link href={issue.href} className="underline underline-offset-2 hover:no-underline">
          {m['admin.plugins.readiness_banner_link']({ name: label })}
        </Link>
      </AlertDescription>
    </Alert>
  );
}
