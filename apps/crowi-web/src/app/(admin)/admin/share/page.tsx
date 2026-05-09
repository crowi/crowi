'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { useAdminShareSettings } from '@/lib/use-admin-share';
import { ShareForm } from './share-form';
import { m } from '@paraglide/messages.js';

/**
 * /admin/share
 *
 * Manages the legacy `app:externalShare` config key — i.e. the site-wide
 * on/off switch for share-link viewing and the share CRUD endpoints.
 * Authorization (admin only) is already enforced by the surrounding (admin)
 * layout, so this page assumes the current user is admin and only handles
 * fetch / form state.
 */
export default function AdminSharePage() {
  const { data, isLoading, error } = useAdminShareSettings();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{m['admin.nav_share']()}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{m['admin.nav_share_summary']()}</p>
      </div>

      <Card>
        <CardContent className="pt-6">
          {isLoading && <LoadingSpinner />}

          {!isLoading && error && (
            <Alert variant="destructive">
              <AlertDescription>{error instanceof Error ? error.message : m['admin.share.failed_to_load']()}</AlertDescription>
            </Alert>
          )}

          {!isLoading && !error && data && <ShareForm settings={data} />}
        </CardContent>
      </Card>
    </div>
  );
}
