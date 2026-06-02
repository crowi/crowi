'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { m } from '@paraglide/messages.js';
import { apiClientV2 } from '@/lib/api-client';
import { clientDisplayName } from '@/lib/oauth-clients';
import { ConsentCard } from './consent-card';

/**
 * RFC-0010 Phase 3 — OAuth consent screen.
 *
 * Reads the authorization request from the query string, shows the
 * requested scopes, and on approval calls `POST /api/v2/oauth/authorize`
 * (server-side validation of client / redirect_uri / scope / PKCE is the
 * source of truth). The server returns the fully-formed loopback callback
 * URL (`redirectUri`) which we navigate to. On denial we bounce back to
 * the registered redirect_uri with `error=access_denied` (RFC 6749).
 *
 * Lives under `(auth)`, so an unauthenticated user is redirected to login
 * first and returns here via `continue`.
 */
function ConsentScreen() {
  const params = useSearchParams();
  const clientId = params.get('client_id') ?? '';
  const redirectUri = params.get('redirect_uri') ?? '';
  const scope = params.get('scope') ?? '';
  const codeChallenge = params.get('code_challenge') ?? '';
  const codeChallengeMethod = params.get('code_challenge_method') ?? 'S256';
  const state = params.get('state') ?? undefined;

  const scopes = scope.split(/\s+/).filter((s) => s.length > 0);
  const requestValid = clientId !== '' && redirectUri !== '' && scopes.length > 0 && codeChallenge !== '' && codeChallengeMethod === 'S256';

  const [isApproving, setIsApproving] = useState(false);
  const [error, setError] = useState<string | null>(requestValid ? null : m['oauth.consent.error_invalid_request']());

  const handleApprove = async () => {
    if (!requestValid) return;
    setIsApproving(true);
    setError(null);
    try {
      const response = await apiClientV2.oauth.authorize.$post({
        json: {
          client_id: clientId,
          redirect_uri: redirectUri,
          scope,
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
          ...(state != null ? { state } : {}),
        },
      });
      if (response.status === 200) {
        const body = await response.json();
        window.location.href = body.redirectUri;
        return;
      }
      setError(m['oauth.consent.error_failed']());
    } catch {
      setError(m['oauth.consent.error_failed']());
    } finally {
      setIsApproving(false);
    }
  };

  const handleDeny = () => {
    // Bounce back to the (untrusted-but-validated-by-the-user) redirect_uri
    // with the standard denial error. If the URI is unusable we just stay.
    if (!redirectUri) return;
    try {
      const url = new URL(redirectUri);
      url.searchParams.set('error', 'access_denied');
      if (state != null) url.searchParams.set('state', state);
      window.location.href = url.toString();
    } catch {
      setError(m['oauth.consent.error_invalid_request']());
    }
  };

  return (
    <div className="flex justify-center py-8">
      <ConsentCard
        clientName={clientDisplayName(clientId)}
        scopes={scopes}
        error={error}
        isApproving={isApproving}
        onApprove={handleApprove}
        onDeny={handleDeny}
      />
    </div>
  );
}

export default function OAuthAuthorizePage() {
  return (
    <Suspense fallback={<div className="py-8 text-center text-muted-foreground">…</div>}>
      <ConsentScreen />
    </Suspense>
  );
}
