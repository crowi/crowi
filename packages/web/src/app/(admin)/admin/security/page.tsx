'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { useAdminSecuritySettings } from '@/lib/use-admin-security';
import { SecurityForm } from './security-form';
import { m } from '@paraglide/messages.js';

/**
 * /admin/security
 *
 * Manages the registration `security:*` config keys: registrationMode and
 * registrationWhiteList. (Legacy site-wide HTTP Basic auth was removed — gate
 * the site at a reverse proxy instead.) Authorization (admin only) is already
 * enforced by the surrounding (admin) layout, so this page assumes the current
 * user is admin and only handles fetch / form state.
 */
export default function AdminSecurityPage() {
  const { data, isLoading, error } = useAdminSecuritySettings();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{m['admin.nav_security']()}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{m['admin.nav_security_summary']()}</p>
      </div>

      <Card>
        <CardContent className="pt-6">
          {isLoading && <LoadingSpinner />}

          {!isLoading && error && (
            <Alert variant="destructive">
              <AlertDescription>{error instanceof Error ? error.message : m['admin.security.failed_to_load']()}</AlertDescription>
            </Alert>
          )}

          {!isLoading && !error && data && <SecurityForm settings={data} />}
        </CardContent>
      </Card>
    </div>
  );
}
