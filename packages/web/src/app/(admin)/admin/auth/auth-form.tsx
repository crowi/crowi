'use client';

import { Alert, AlertDescription } from '@/components/ui/alert';
import type { AuthSettings } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';

interface AuthFormProps {
  settings: AuthSettings;
}

/**
 * Read-only view of the two `auth:*` keys (`requireThirdPartyAuth`,
 * `disablePasswordAuth`).
 *
 * Both settings depend on third-party (Google / GitHub) sign-in, which was
 * removed from core in the 2.0.0-alpha line — `User.hasValidThirdPartyId()` is
 * now permanently false, so enabling either would lock every account out of
 * password login. The config keys and schema are kept (inert) for a future
 * auth provider plugin, but the editable toggles are hidden and the API
 * rejects (400) any attempt to enable them. This component only surfaces an
 * explanatory notice; `settings` is accepted (and the current inert value
 * shown) so the page keeps its existing fetch path without special-casing.
 */
export function AuthForm({ settings }: AuthFormProps) {
  const enabled = settings.requireThirdPartyAuth || settings.disablePasswordAuth;

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{m['admin.auth.section_password_heading']()}</h2>
        <p className="text-muted-foreground text-sm">{m['admin.auth.section_password_lead']()}</p>
      </section>

      <Alert>
        <AlertDescription>{m['admin.auth.thirdparty_unavailable_notice']()}</AlertDescription>
      </Alert>

      {enabled && (
        <Alert variant="destructive">
          <AlertDescription>{m['admin.auth.thirdparty_unavailable_stale']()}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
