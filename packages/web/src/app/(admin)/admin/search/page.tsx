'use client';

import Link from 'next/link';
import { CheckCircle2, ChevronRight, Info, Search } from 'lucide-react';
import type { SearchDriverEntry } from '@crowi/api-contract';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorAlert } from '@/components/ui/error-alert';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { useAdminSearch } from '@/lib/use-admin-search';
import { m } from '@paraglide/messages.js';

export default function AdminSearchPage() {
  const { data, isLoading, error } = useAdminSearch();
  const activeSupportsRebuild = data?.active?.supportsRebuild ?? false;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{m['admin.search.heading']()}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{m['admin.search.lead']()}</p>
      </div>

      {isLoading && <LoadingSpinner />}
      {!isLoading && error && <ErrorAlert message={error.message} />}

      {!isLoading && !error && data && (
        <>
          <ActiveDriverCard active={data.active} />

          <Card>
            <CardHeader>
              <CardTitle>{m['admin.search.installed_heading']()}</CardTitle>
              <CardDescription>{m['admin.search.installed_lead']()}</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {data.drivers.length === 0 ? (
                <p className="px-4 py-3 text-muted-foreground text-sm">{m['admin.search.installed_empty']()}</p>
              ) : (
                <ul className="divide-y">
                  {data.drivers.map((driver) => (
                    <li key={driver.driverName}>
                      <DriverRow driver={driver} />
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription>
              <div className="space-y-1.5">
                <p>{m['admin.search.hint_switch']()}</p>
                {activeSupportsRebuild && (
                  <p>
                    <span className="text-muted-foreground">{m['admin.search.hint_rebuild_label']()}</span>{' '}
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{m['admin.search.hint_rebuild_command']()}</code>
                  </p>
                )}
              </div>
            </AlertDescription>
          </Alert>
        </>
      )}
    </div>
  );
}

function ActiveDriverCard({ active }: { active: { driverName: string; pluginName: string } | null }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Search className="h-5 w-5" />
          {m['admin.search.active_heading']()}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {active ? (
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="space-y-0.5">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                <span className="font-medium">{active.driverName}</span>
              </div>
              <p className="text-muted-foreground text-xs font-mono">{active.pluginName}</p>
            </div>
            <Link
              href={`/admin/plugins/edit?name=${encodeURIComponent(active.pluginName)}`}
              className="text-sm text-primary hover:underline inline-flex items-center gap-1"
            >
              {m['admin.search.configure_link']()}
              <ChevronRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">{m['admin.search.active_none']()}</p>
        )}
      </CardContent>
    </Card>
  );
}

function DriverRow({ driver }: { driver: SearchDriverEntry }) {
  const href = `/admin/plugins/edit?name=${encodeURIComponent(driver.pluginName)}`;
  return (
    <Link href={href} className="block hover:bg-muted/50 transition-colors">
      <div className="flex items-center justify-between gap-4 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium">{driver.driverName}</span>
            {driver.isActive && (
              <span className="inline-flex items-center rounded-md bg-primary/10 text-primary px-1.5 py-0.5 text-xs font-medium">
                {m['admin.search.badge_active']()}
              </span>
            )}
            {!driver.supportsRebuild && (
              <span className="inline-flex items-center rounded-md bg-muted text-muted-foreground px-1.5 py-0.5 text-xs">
                {m['admin.search.badge_no_rebuild']()}
              </span>
            )}
          </div>
          <p className="text-muted-foreground text-xs font-mono mt-0.5 truncate">{driver.pluginName}</p>
        </div>
        <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
      </div>
    </Link>
  );
}
