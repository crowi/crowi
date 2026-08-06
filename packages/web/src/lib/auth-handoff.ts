'use client';

import { m } from '@paraglide/messages.js';
import { apiClient, apiOrigin } from './api-client';
import { storeTokens } from './auth-token';
import { buildHandoffCanonicalMessage, buildStartCanonicalMessage, createAndStoreSenderKey, takeStoredSenderKey } from './handoff-sender-key';

/**
 * RFC-0014 phase 4 — the two browser-side halves of a federated sign-in:
 * leaving for the provider, and coming back.
 *
 * Both exist because the handoff is sender-constrained (see
 * `handoff-sender-key.ts`). The `/start` URL is not a plain link: it
 * carries this browser's public key and a signature proving possession of
 * the private half, so the code the flow eventually returns is only
 * redeemable here.
 */

/** Where the api lives, as the SIGNATURE sees it — must match the origin the server reconstructs the canonical message from. */
function resolveApiOrigin(): string {
  return apiOrigin() || window.location.origin;
}

/**
 * Build the `/auth/providers/<provider>/start` URL for this browser,
 * generating and persisting the sender key it will need on the way back.
 *
 * `continuePath` must already be sanitized by the caller
 * (`safeContinueUrl`) — it is signed into the canonical message and echoed
 * by the server after the round trip, so an unvalidated value here would
 * become an open redirect later.
 */
export async function buildProviderStartUrl(provider: string, continuePath: string): Promise<string> {
  const apiUrl = resolveApiOrigin();
  const senderKey = await createAndStoreSenderKey();
  const signature = await senderKey.sign(buildStartCanonicalMessage(apiUrl, provider, continuePath, senderKey.publicJwkB64));

  const url = new URL(`${apiUrl}/api/auth/providers/${encodeURIComponent(provider)}/start`);
  url.searchParams.set('continue', continuePath);
  url.searchParams.set('handoff_jwk', senderKey.publicJwkB64);
  url.searchParams.set('handoff_proof', signature);
  return url.toString();
}

/**
 * The link-mode variant: same `/start`, but the api additionally demands
 * a single-use grant minted by the signed-in session and pinned to this
 * browser's key. Minting has to happen AFTER the key exists (the grant
 * is bound to its thumbprint) and BEFORE the navigation, so the two
 * steps cannot be collapsed into a plain href.
 */
export async function buildProviderLinkStartUrl(provider: string, continuePath: string): Promise<string> {
  const apiUrl = resolveApiOrigin();
  const senderKey = await createAndStoreSenderKey();

  const grantResponse = await apiClient.auth.providers[':name']['link-grants'].$post({
    param: { name: provider },
    json: { handoffChallenge: await senderKey.thumbprint() },
  });
  if (grantResponse.status !== 200) throw new Error('link grant request failed');
  const { linkGrant } = await grantResponse.json();

  const signature = await senderKey.sign(buildStartCanonicalMessage(apiUrl, provider, continuePath, senderKey.publicJwkB64));
  const url = new URL(`${apiUrl}/api/auth/providers/${encodeURIComponent(provider)}/start`);
  url.searchParams.set('continue', continuePath);
  url.searchParams.set('handoff_jwk', senderKey.publicJwkB64);
  url.searchParams.set('handoff_proof', signature);
  url.searchParams.set('link', '1');
  url.searchParams.set('link_grant', linkGrant);
  return url.toString();
}

export type CompleteAuthHandoffResult = { ok: true; username: string } | { ok: false; message: string };

/**
 * Redeem a handoff code for a session, exactly once.
 *
 * Every failure path leaves stored tokens untouched — a failed redemption
 * must never half-sign-in the browser, and the code is consumed
 * server-side on the first valid attempt, so there is nothing to retry
 * with. The sender key is taken (and deleted) before the request, so a
 * second call for the same code cannot even build a proof.
 */
export async function completeAuthHandoff(code: string | null | undefined): Promise<CompleteAuthHandoffResult> {
  if (!code) return { ok: false, message: m['auth.handoff.invalid']() };

  const senderKey = await takeStoredSenderKey();
  // No key means this browser did not start the flow (a copied
  // `/login/complete` URL, a different tab, or an attempt already
  // completed). It could not produce a valid proof anyway.
  if (!senderKey) return { ok: false, message: m['auth.handoff.invalid']() };

  try {
    const signature = await senderKey.sign(buildHandoffCanonicalMessage(resolveApiOrigin(), code));
    const response = await apiClient.auth.handoff.$post({
      json: { code, proof: { publicJwk: senderKey.publicJwk, signature } },
    });

    if (response.status !== 200) {
      return { ok: false, message: m['auth.handoff.invalid']() };
    }

    const body = await response.json();
    storeTokens(body, body.expiresIn);
    return { ok: true, username: body.user.username };
  } catch {
    return { ok: false, message: m['auth.common.server_error']() };
  }
}
