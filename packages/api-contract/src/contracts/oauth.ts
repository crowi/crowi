/**
 * RFC-0010 Phase 3 — OAuth 2.0 authorization-server endpoint contracts.
 *
 *   POST /oauth/authorize                          — JWT (web session only)
 *   POST /oauth/token                              — public (RFC 6749)
 *   POST /oauth/revoke                             — public (RFC 7009)
 *   GET  /.well-known/oauth-authorization-server   — public (RFC 8414)
 *
 * Only `/oauth/authorize` carries `security: [{ bearerAuth: [] }]`; the
 * other three are public (no auth) — the matching handler registers them
 * without an `app.use(jwtAuth)`, exactly like `/auth/login` etc.
 *
 * `/oauth/token` accepts `application/x-www-form-urlencoded` (RFC 6749) as
 * well as JSON. The contract declares JSON as the canonical body shape;
 * the handler additionally parses form bodies into the same shape before
 * validating (so the OpenAPI doc stays single-shape while the runtime is
 * spec-compliant).
 */
import { createRoute, z } from '@hono/zod-openapi';

import { ForbiddenErrorSchema, InternalServerErrorSchema, NotFoundErrorSchema } from '../schemas/common';
import {
  AuthorizeRequestSchema,
  AuthorizeResponseSchema,
  DeviceAuthorizeRequestSchema,
  DeviceAuthorizeResponseSchema,
  DeviceInfoResponseSchema,
  DeviceVerifyRequestSchema,
  DeviceVerifyResponseSchema,
  DiscoveryResponseSchema,
  OAuthErrorSchema,
  RevokeResponseSchema,
  TokenResponseSchema,
} from '../schemas/oauth-endpoints';

export const authorizeRoute = createRoute({
  method: 'post',
  path: '/oauth/authorize',
  tags: ['oauth'],
  security: [{ bearerAuth: [] }],
  summary: 'Issue an authorization code for the consenting web user (PKCE)',
  request: {
    body: {
      content: { 'application/json': { schema: AuthorizeRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Authorization code issued; `redirectUri` carries `code` + `state`',
      content: { 'application/json': { schema: AuthorizeResponseSchema } },
    },
    400: {
      description: 'Invalid request / scope / client (RFC 6749 §4.1.2.1)',
      content: { 'application/json': { schema: OAuthErrorSchema } },
    },
    403: {
      description: 'Authorization codes can only be issued from a web session',
      content: { 'application/json': { schema: ForbiddenErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const tokenRoute = createRoute({
  method: 'post',
  path: '/oauth/token',
  tags: ['oauth'],
  summary: 'Exchange an authorization code or refresh token for an access token',
  // The request body is intentionally NOT declared as a validated schema:
  // RFC 6749 mandates `application/x-www-form-urlencoded`, which the
  // zod-openapi `json` validator would reject (and the resulting
  // VALIDATION_ERROR envelope is not the RFC 6749 §5.2 OAuth shape). The
  // handler parses both form and JSON bodies itself and validates with
  // `TokenRequestSchema`, emitting `{ error, error_description }`. The
  // request schema is still published under `components.schemas`
  // (`TokenRequest`) for documentation by `generate-openapi.ts`.
  responses: {
    200: {
      description: 'Access + refresh token issued (RFC 6749 §5.1)',
      content: { 'application/json': { schema: TokenResponseSchema } },
    },
    400: {
      description: 'invalid_grant / invalid_request / unsupported_grant_type (RFC 6749 §5.2)',
      content: { 'application/json': { schema: OAuthErrorSchema } },
    },
    401: {
      description: 'invalid_client (RFC 6749 §5.2)',
      content: { 'application/json': { schema: OAuthErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const revokeRoute = createRoute({
  method: 'post',
  path: '/oauth/revoke',
  tags: ['oauth'],
  summary: 'Revoke a refresh token or personal access token (RFC 7009)',
  // Body not declared for the same reason as `/oauth/token`: RFC 7009 uses
  // `application/x-www-form-urlencoded`. The handler parses form + JSON and
  // validates with `RevokeRequestSchema`. (`RevokeRequest` is published in
  // `components.schemas` for documentation.)
  responses: {
    200: {
      description: 'Revocation processed (200 even for unknown tokens, RFC 7009)',
      content: { 'application/json': { schema: RevokeResponseSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const discoveryRoute = createRoute({
  method: 'get',
  path: '/.well-known/oauth-authorization-server',
  tags: ['oauth'],
  summary: 'OAuth 2.0 authorization-server metadata (RFC 8414)',
  responses: {
    200: {
      description: 'Authorization-server metadata',
      content: { 'application/json': { schema: DiscoveryResponseSchema } },
    },
  },
});

export const deviceAuthorizeRoute = createRoute({
  method: 'post',
  path: '/oauth/device/authorize',
  tags: ['oauth'],
  summary: 'Start a device authorization grant — issue device_code + user_code (RFC 8628)',
  // Public, no PKCE / redirect_uri. JSON body is validated (CLIs post JSON,
  // mirroring PHASE3-Q3); the device grant on /oauth/token still parses form
  // bodies itself.
  request: {
    body: {
      content: { 'application/json': { schema: DeviceAuthorizeRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Device + user code issued (RFC 8628 §3.2)',
      content: { 'application/json': { schema: DeviceAuthorizeResponseSchema } },
    },
    400: {
      description: 'invalid_client / invalid_scope (RFC 6749 §5.2)',
      content: { 'application/json': { schema: OAuthErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const deviceInfoRoute = createRoute({
  method: 'get',
  path: '/oauth/device',
  tags: ['oauth'],
  summary: 'Look up a pending device authorization by user_code (consent screen)',
  // Public + lightweight: returns only the requesting client + requested
  // scopes so the web consent screen can show them before approval. Reveals
  // no secret. Unknown / expired / non-pending → 404 (PHASE4-Q9 option A).
  request: {
    query: z.object({ user_code: z.string().min(1) }),
  },
  responses: {
    200: {
      description: 'Pending device authorization metadata',
      content: { 'application/json': { schema: DeviceInfoResponseSchema } },
    },
    404: {
      description: 'No pending device authorization for this user_code',
      content: { 'application/json': { schema: NotFoundErrorSchema } },
    },
  },
});

export const deviceVerifyRoute = createRoute({
  method: 'post',
  path: '/oauth/device/verify',
  tags: ['oauth'],
  security: [{ bearerAuth: [] }],
  summary: 'Approve or deny a device authorization by user_code (web session only)',
  request: {
    body: {
      content: { 'application/json': { schema: DeviceVerifyRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Device authorization approved or denied',
      content: { 'application/json': { schema: DeviceVerifyResponseSchema } },
    },
    403: {
      description: 'Device approvals can only come from a web session',
      content: { 'application/json': { schema: ForbiddenErrorSchema } },
    },
    404: {
      description: 'No pending device authorization for this user_code',
      content: { 'application/json': { schema: NotFoundErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const oauthRoutes = {
  authorizeRoute,
  tokenRoute,
  revokeRoute,
  discoveryRoute,
  deviceAuthorizeRoute,
  deviceInfoRoute,
  deviceVerifyRoute,
};
