'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { m } from '@paraglide/messages.js';
import { ErrorAlert } from '@/components/ui/error-alert';
import { apiClientV2 } from '@/lib/api-client';
import { clientDisplayName } from '@/lib/oauth-clients';
import { useOAuthClientInfo } from '@/lib/use-oauth-client-info';
import { ConsentCard } from './consent-card';

/**
 * RFC-0010 Phase 3 — OAuth consent screen.
 * RFC-0016 §4.4/§14 — trusted first-party clients (`crowi-ios`) skip it.
 *
 * Reads the authorization request from the query string, looks up the
 * client's non-secret metadata (`GET /oauth/client-info`), and:
 *
 *  - **trusted client**: skips `ConsentCard` entirely — for the whole
 *    lifetime of the screen, including on failure — and auto-submits the
 *    same `POST /oauth/authorize` a manual approval would (showing an
 *    interim "signing in…" state). The server still does every real
 *    validation (client / redirect_uri / scope / PKCE), this only removes
 *    the click. If the auto-submit itself fails, a dedicated retry alert is
 *    shown instead of falling back to `ConsentCard` (AC4: a trusted client
 *    must never render it).
 *  - **everything else** (incl. `crowi-cli`): unchanged — `ConsentCard`
 *    renders and waits for the user to click Authorize/Cancel.
 *
 * The server returns the fully-formed callback URL (`redirectUri`) which we
 * navigate to. On denial we bounce back to the registered redirect_uri with
 * `error=access_denied` (RFC 6749).
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

  const clientInfoQuery = useOAuthClientInfo(requestValid ? clientId : '');
  const isTrusted = clientInfoQuery.data?.trusted === true;

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

  // Trusted first-party clients auto-submit the moment the client-info
  // lookup confirms `trusted`. The once-only guard lives in a ref, not
  // `useState`: React StrictMode (dev) double-invokes a mount effect body
  // before the first invocation's `setState` call has flushed, so a
  // `useState` guard would still read its pre-update (`false`) value on the
  // second invocation and fire `handleApprove` a second time — a real
  // double-submit of `POST /oauth/authorize`. A ref mutation is synchronous,
  // so the second invocation observes it immediately and skips (same
  // pattern as `useMarkSeenOnView` in `use-seen.ts`).
  const autoApproveFiredRef = useRef(false);
  useEffect(() => {
    if (!requestValid || !isTrusted || autoApproveFiredRef.current) return;
    autoApproveFiredRef.current = true;
    void handleApprove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestValid, isTrusted]);

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

  // While the client-info lookup is still pending we don't yet know
  // whether to skip the card, so stay on the interim state rather than
  // flashing `ConsentCard`; once `trusted` is confirmed (and no error has
  // occurred) we remain on it until the redirect fires.
  const showInterim = requestValid && error == null && (clientInfoQuery.isLoading || isTrusted);

  if (showInterim) {
    return (
      <div className="flex justify-center py-8">
        <p className="py-8 text-center text-muted-foreground">{m['oauth.consent.auto_approving']()}</p>
      </div>
    );
  }

  // A trusted client never renders `ConsentCard`, even if the auto-submit
  // above failed (AC4) — show a dedicated retry alert instead of falling
  // back to the manual-approval card.
  if (requestValid && isTrusted && error != null) {
    return (
      <div className="flex justify-center py-8">
        <div className="w-full max-w-md">
          <ErrorAlert message={error} onRetry={() => void handleApprove()} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-center py-8">
      <ConsentCard
        clientName={clientInfoQuery.data?.name ?? clientDisplayName(clientId)}
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
