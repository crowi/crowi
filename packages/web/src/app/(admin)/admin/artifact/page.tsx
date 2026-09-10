'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { useAdminArtifactSettings } from '@/lib/use-admin-artifact';
import { ArtifactForm } from './artifact-form';
import { m } from '@paraglide/messages.js';

/**
 * /admin/artifact
 *
 * feature-html-artifact-delivery-policy §A 表 — HTML artifact delivery mode
 * (separate-origin / same-origin / disabled) and settings (same-origin
 * toggle, web fonts, payload size limit). Authorization (admin only) is
 * already enforced by the surrounding (admin) layout, so this page assumes
 * the current user is admin and only handles fetch / form state.
 */
export default function AdminArtifactPage() {
  const { data, isLoading, error } = useAdminArtifactSettings();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{m['admin.artifact.heading']()}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{m['admin.artifact.lead']()}</p>
      </div>

      <Card>
        <CardContent className="pt-6">
          {isLoading && <LoadingSpinner />}

          {!isLoading && error && (
            <Alert variant="destructive">
              <AlertDescription>{error instanceof Error ? error.message : m['admin.artifact.failed_to_load']()}</AlertDescription>
            </Alert>
          )}

          {!isLoading && !error && data && <ArtifactForm settings={data} />}
        </CardContent>
      </Card>
    </div>
  );
}
