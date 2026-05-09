'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { useAdminAuthSettings } from '@/lib/use-admin-auth-settings';
import { AuthForm } from './auth-form';
import { m } from '@paraglide/messages.js';

/**
 * /admin/auth
 *
 * Manages the two legacy `auth:*` config keys: requireThirdPartyAuth,
 * disablePasswordAuth. Authorization (admin only) is already enforced by the
 * surrounding (admin) layout, so this page assumes the current user is admin
 * and only handles fetch / form state.
 */
export default function AdminAuthPage() {
  const { data, isLoading, error } = useAdminAuthSettings();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{m['admin.nav_auth']()}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{m['admin.auth.lead']()}</p>
      </div>

      <Card>
        <CardContent className="pt-6">
          {isLoading && <LoadingSpinner />}

          {!isLoading && error && (
            <Alert variant="destructive">
              <AlertDescription>{error instanceof Error ? error.message : m['admin.auth.failed_to_load']()}</AlertDescription>
            </Alert>
          )}

          {!isLoading && !error && data && <AuthForm settings={data} />}
        </CardContent>
      </Card>
    </div>
  );
}
