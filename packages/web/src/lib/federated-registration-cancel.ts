'use client';

import { apiClient } from './api-client';
import { clearTokens } from './auth-token';

/**
 * Best-effort cancel of a pending federated registration grant (RFC-0014
 * phase 2), followed by clearing any local tokens. Shared by
 * `FederatedRegisterForm`'s own "cancel and sign in another way" action and
 * `FederatedRegisterFormFallback`'s logout link (the outer Suspense
 * fallback, rendered before the form itself has hydrated) so both exits run
 * the exact same invalidation regardless of which sub-view the visitor's
 * click landed on. The API call's success or failure never blocks leaving —
 * this is a mid-registration state, not a signed-in session (AC-2). The
 * caller owns navigation.
 */
export async function cancelFederatedRegistration(token: string | null): Promise<void> {
  if (token) {
    try {
      await apiClient.auth['federated-registration'][':token'].logout.$post({ param: { token } });
    } catch {
      // Best-effort — proceed to clear local state and leave regardless.
    }
  }
  clearTokens();
}
