import { z } from '@hono/zod-openapi';

import { ISSUABLE_SCOPES } from './oauth';

/**
 * RFC-0010 Phase 3 — OAuth 2.0 authorization-server endpoint wire schemas
 * (`/oauth/authorize`, `/oauth/token`, `/oauth/revoke`,
 * `/.well-known/oauth-authorization-server`).
 *
 * These are intentionally separate from `schemas/oauth.ts`, which owns the
 * scope **catalog** (a single-responsibility module shared by API / web /
 * consent screen). The endpoint request/response shapes here follow the
 * relevant RFCs (6749 / 7009 / 8414) verbatim — in particular the error
 * envelope is RFC 6749 §5.2's `{ error, error_description? }`, NOT Crowi's
 * usual `{ error: { code, message } }`, so CLIs / SDKs can parse it with a
 * standard OAuth client.
 */

/**
 * RFC 6749 §5.2 OAuth error codes the token / authorize endpoints emit, plus
 * the RFC 8628 §3.5 device-grant polling codes (`authorization_pending`,
 * `slow_down`, `expired_token`; `access_denied` is shared with §5.2). Kept as
 * a const tuple so the same values drive both the Zod enum and any exhaustive
 * handler-side switch.
 */
export const OAUTH_ERROR_CODES = [
  'invalid_request',
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
  'unsupported_grant_type',
  'invalid_scope',
  'access_denied',
  // RFC 8628 §3.5 — device authorization grant polling errors (all 400).
  'authorization_pending',
  'slow_down',
  'expired_token',
] as const;
export type OAuthErrorCode = (typeof OAUTH_ERROR_CODES)[number];

/**
 * RFC 6749 §5.2 error envelope. `error` is the machine code; the optional
 * `error_description` is a human-readable hint. HTTP status is 401 for
 * `invalid_client`, 400 for the rest (set per-response by the handler).
 */
export const OAuthErrorSchema = z.object({
  error: z.enum(OAUTH_ERROR_CODES),
  error_description: z.string().optional(),
});
export type OAuthError = z.infer<typeof OAuthErrorSchema>;

/**
 * `POST /oauth/authorize` request body (sent by the Next.js consent
 * screen after the user approves). PKCE is mandatory: `code_challenge` is
 * required and `code_challenge_method` must be `S256` (RFC-0010 §Security).
 * `scope` is a space-delimited list (RFC 6749 §3.3). `state` is echoed back
 * untouched onto the redirect URI.
 */
export const AuthorizeRequestSchema = z.object({
  client_id: z.string().min(1),
  redirect_uri: z.string().min(1),
  scope: z.string().min(1),
  code_challenge: z.string().min(1),
  code_challenge_method: z.literal('S256'),
  state: z.string().optional(),
});
export type AuthorizeRequest = z.infer<typeof AuthorizeRequestSchema>;

/**
 * `POST /oauth/authorize` response. The server returns the fully-formed
 * redirect URI (callback + `?code=…&state=…`) as JSON rather than a 303 so
 * the consent screen (which calls this with `fetch`) can navigate to it via
 * `window.location.href` — a real 303 followed by `fetch` would hit
 * CORS/credential issues against the loopback callback (RFC-0010,
 * PHASE3-Q3).
 */
export const AuthorizeResponseSchema = z.object({
  redirectUri: z.string(),
});
export type AuthorizeResponse = z.infer<typeof AuthorizeResponseSchema>;

/**
 * `POST /oauth/token` request. The grant_type discriminates the body:
 *
 *  - `authorization_code`: `code` + PKCE `code_verifier` + the same
 *    `redirect_uri` used at authorize time + `client_id`.
 *  - `refresh_token`: the opaque `refresh_token` + `client_id`, optionally
 *    a narrower `scope` to down-scope the rotated token.
 *
 * Accepted as `application/x-www-form-urlencoded` (RFC 6749) **or** JSON.
 * The schema models the JSON/object shape; the handler normalises form
 * bodies into the same shape before validating.
 */
export const TokenRequestSchema = z.discriminatedUnion('grant_type', [
  z.object({
    grant_type: z.literal('authorization_code'),
    code: z.string().min(1),
    code_verifier: z.string().min(1),
    redirect_uri: z.string().min(1),
    client_id: z.string().min(1),
  }),
  z.object({
    grant_type: z.literal('refresh_token'),
    refresh_token: z.string().min(1),
    client_id: z.string().min(1),
    scope: z.string().optional(),
  }),
  // RFC 8628 §3.4 — device authorization grant. The client polls with the
  // opaque `device_code` returned by `/oauth/device/authorize`.
  z.object({
    grant_type: z.literal('urn:ietf:params:oauth:grant-type:device_code'),
    device_code: z.string().min(1),
    client_id: z.string().min(1),
  }),
]);
export type TokenRequest = z.infer<typeof TokenRequestSchema>;

/** RFC 8628 §3.4 device-code grant_type URN (shared by schema + handler). */
export const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

/**
 * `POST /oauth/token` success response (RFC 6749 §5.1). `access_token` is a
 * short-lived scope-bearing JWT; `refresh_token` is the rotated opaque
 * secret; `scope` is the space-delimited granted set.
 */
export const TokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.literal('Bearer'),
  expires_in: z.number(),
  refresh_token: z.string(),
  scope: z.string(),
});
export type TokenResponse = z.infer<typeof TokenResponseSchema>;

/**
 * `POST /oauth/revoke` request (RFC 7009). `token` is the secret to revoke
 * (a `crowi_rt_…` refresh token or a `crowi_pat_…` PAT). `token_type_hint`
 * is advisory and ignored — the prefix already identifies the type.
 */
export const RevokeRequestSchema = z.object({
  token: z.string().min(1),
  token_type_hint: z.string().optional(),
});
export type RevokeRequest = z.infer<typeof RevokeRequestSchema>;

/** `POST /oauth/revoke` always returns 200 with an empty object (RFC 7009). */
export const RevokeResponseSchema = z.object({});
export type RevokeResponse = z.infer<typeof RevokeResponseSchema>;

/**
 * `POST /oauth/device/authorize` request (RFC 8628 §3.1). A headless client
 * (no browser) starts the device flow with its `client_id` and the
 * space-delimited `scope` it wants. Public endpoint — no PKCE, no
 * redirect_uri (the user verifies out-of-band at `verification_uri`).
 */
export const DeviceAuthorizeRequestSchema = z.object({
  client_id: z.string().min(1),
  scope: z.string().min(1),
});
export type DeviceAuthorizeRequest = z.infer<typeof DeviceAuthorizeRequestSchema>;

/**
 * `POST /oauth/device/authorize` response (RFC 8628 §3.2). `device_code` is
 * the opaque secret the client polls with; `user_code` is the human-typed
 * handle; `verification_uri(_complete)` is where the user approves; `interval`
 * is the minimum poll spacing in seconds; `expires_in` is the code lifetime.
 */
export const DeviceAuthorizeResponseSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  verification_uri_complete: z.string(),
  expires_in: z.number(),
  interval: z.number(),
});
export type DeviceAuthorizeResponse = z.infer<typeof DeviceAuthorizeResponseSchema>;

/**
 * `POST /oauth/device/verify` request — the web consent screen approves or
 * denies a `user_code`. `user_code` is normalised (case / dash insensitive)
 * server-side before lookup.
 */
export const DeviceVerifyRequestSchema = z.object({
  user_code: z.string().min(1),
  action: z.enum(['approve', 'deny']),
});
export type DeviceVerifyRequest = z.infer<typeof DeviceVerifyRequestSchema>;

/** `POST /oauth/device/verify` response — the resulting device-code status. */
export const DeviceVerifyResponseSchema = z.object({
  status: z.enum(['approved', 'denied']),
});
export type DeviceVerifyResponse = z.infer<typeof DeviceVerifyResponseSchema>;

/**
 * `GET /oauth/device` lookup response (PHASE4-Q9 option A). The web consent
 * screen reads this *before* approving to show the requesting client + the
 * scopes it asked for — the same transparency the authorize-code consent
 * screen gives. Carries only non-secret metadata.
 */
export const DeviceInfoResponseSchema = z.object({
  client_id: z.string(),
  scopes: z.array(z.string()),
});
export type DeviceInfoResponse = z.infer<typeof DeviceInfoResponseSchema>;

/**
 * `GET /oauth/client-info` lookup response (RFC-0016 §4.4). The web
 * authorize page reads this *before* deciding whether to render the
 * consent screen or auto-approve — a `trusted` client skips `ConsentCard`
 * entirely. Carries only non-secret metadata: no `redirectUris` /
 * `allowedScopes`, mirroring `DeviceInfoResponseSchema`'s own minimalism.
 */
export const ClientInfoResponseSchema = z.object({
  clientId: z.string(),
  name: z.string(),
  firstParty: z.boolean(),
  trusted: z.boolean(),
});
export type ClientInfoResponse = z.infer<typeof ClientInfoResponseSchema>;

/**
 * Grant types the server advertises in discovery — `authorization_code` +
 * `refresh_token` (Phase 3) and the device-code grant URN (Phase 4, RFC 8628).
 */
export const GRANT_TYPES_SUPPORTED = ['authorization_code', 'refresh_token', DEVICE_CODE_GRANT_TYPE] as const;

/**
 * `GET /.well-known/oauth-authorization-server` response (RFC 8414). Lets
 * CLIs / SDKs auto-discover endpoints. `authorization_endpoint` is the
 * **web** consent screen origin; `token_endpoint` / `revocation_endpoint`
 * are the `/api/v2/oauth/*` API (the two live on different base URLs —
 * RFC-0010, PHASE3-Q6). `device_authorization_endpoint` is optional so
 * Phase 4 can add it without a schema break.
 */
export const DiscoveryResponseSchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  revocation_endpoint: z.string(),
  device_authorization_endpoint: z.string().optional(),
  scopes_supported: z.array(z.string()),
  response_types_supported: z.array(z.string()),
  grant_types_supported: z.array(z.string()),
  code_challenge_methods_supported: z.array(z.string()),
  token_endpoint_auth_methods_supported: z.array(z.string()),
});
export type DiscoveryResponse = z.infer<typeof DiscoveryResponseSchema>;

/** Scopes advertised in discovery — issuable catalog (admin:* excluded). */
export const DISCOVERY_SCOPES_SUPPORTED: readonly string[] = ISSUABLE_SCOPES;
