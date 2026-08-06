/**
 * RFC-0014 phase 1 — federated (OAuth2/OIDC) sign-in flow skeleton.
 *
 * `start` / `callback` are top-level browser navigations, not `fetch()`
 * calls — their success responses are real HTTP redirects, declared here
 * with a `302` entry that has NO `content` key. `@hono/zod-openapi`'s
 * generated handler type only allows a plain `Response` return (in
 * addition to the schema-typed union) once at least one declared response
 * status has no `content` — see `HandlerFromRoute` in
 * `@hono/zod-openapi`'s `dist/index.d.ts`. That is what lets
 * `hono/handlers/federated-auth.ts` `return c.redirect(url, 302)`
 * directly without fighting the typed-response system.
 */
import { createRoute, z } from '@hono/zod-openapi';

import { ApiErrorSchema, AuthenticationRequiredErrorSchema, InternalServerErrorSchema } from '../schemas/common';
import {
  CreateLinkGrantRequestSchema,
  CreateLinkGrantResponseSchema,
  LinkedAuthProviderListResponseSchema,
  FederatedHandoffRequestSchema,
  FederatedHandoffResponseSchema,
  ProviderListResponseSchema,
  UnlinkAuthProviderErrorSchema,
} from '../schemas/federated-auth';

/**
 * `/` (root) or a single-leading-slash local path — never `//host`
 * (protocol-relative). Bounded at 2000 chars: `continue` is embedded
 * verbatim into the signed state-cookie payload (`util/federated-auth-
 * state.ts`), and the whole cookie VALUE must stay under the 4KB
 * invariant (RFC-0014 phase 1 §"契約・不変条件") with ample headroom for the
 * payload's other fixed-length fields (state/nonce/PKCE verifier/JKT are
 * each ~43 base64url chars) plus base64url/JSON overhead — 2000 chars is
 * far beyond any legitimate client-side route.
 *
 * The pattern anchors BOTH ends (`^...$`) and forbids backslash and C0
 * control characters (`\x00`-`\x1F`) ANYWHERE in the value, not only in
 * the first two characters. A prefix-only check (`^\/(?!\/)`) is not
 * enough: `new URL()` (and browsers generally) treat `\` as a path
 * separator equivalent to `/`, and strip C0 control chars such as tab/LF/
 * CR before resolving — so e.g. `/\evil.example` or `/<TAB>/evil.example`
 * both collapse to the protocol-relative `//evil.example` this schema is
 * meant to reject, even though neither literally starts with `//`.
 */
const ContinuePathSchema = z
  .string()
  .regex(/^\/(?!\/)[^\\\x00-\x1F\x7F]*$/, 'continue must be a local path starting with a single "/" and contain no backslash or control characters')
  .max(2000, 'continue must be at most 2000 characters');

export const listFederatedProvidersRoute = createRoute({
  method: 'get',
  path: '/auth/providers',
  tags: ['federatedAuth'],
  summary: 'List enabled OAuth2/OIDC federated sign-in providers',
  responses: {
    200: {
      description: 'Enabled providers, in name order',
      content: { 'application/json': { schema: ProviderListResponseSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const startFederatedProviderRoute = createRoute({
  method: 'get',
  path: '/auth/providers/{name}/start',
  tags: ['federatedAuth'],
  summary: 'Top-level navigation that redirects the browser to the named provider',
  request: {
    params: z.object({ name: z.string() }),
    query: z.object({
      continue: ContinuePathSchema,
      /** base64url(JSON) of the sender's P-256 public JWK. */
      handoff_jwk: z.string().min(1),
      /** base64url ES256 signature over the start canonical message. */
      handoff_proof: z.string().min(1),
      /**
       * RFC-0014 phase 3 — `'1'` switches this start into LINK mode: the
       * request must carry a web-session JWT, and the flow attaches the
       * resulting identity to that session's user instead of signing
       * anyone in. Absent (the ordinary sign-in start) the route stays
       * fully public.
       */
      link: z.literal('1').optional(),
      /** The opaque id from `POST /auth/providers/{name}/link-grants`. Required when `link=1`, ignored otherwise. */
      link_grant: z.string().min(1).optional(),
    }),
  },
  responses: {
    302: { description: 'Redirect to the provider authorization endpoint' },
    400: {
      description: 'Malformed continue / sender proof, or an invalid/expired/mismatched link grant',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    401: {
      description: 'link=1 without a web-session JWT — never downgraded to the public sign-in start',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    403: {
      description: 'link=1 with a non-web credential (PAT / OAuth access token)',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    404: {
      description: 'Unknown, unconfigured, or credential-kind provider',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const listLinkedAuthProvidersRoute = createRoute({
  method: 'get',
  path: '/auth/providers/identities',
  tags: ['federatedAuth'],
  summary: 'List the provider slugs the current user has linked',
  responses: {
    200: {
      description: 'Linked provider slugs, in name order',
      content: { 'application/json': { schema: LinkedAuthProviderListResponseSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const createAuthProviderLinkGrantRoute = createRoute({
  method: 'post',
  path: '/auth/providers/{name}/link-grants',
  tags: ['federatedAuth'],
  summary: 'Mint a short-lived, opaque grant that authorizes ONE link start for the current web session',
  request: {
    params: z.object({ name: z.string() }),
    body: { content: { 'application/json': { schema: CreateLinkGrantRequestSchema } } },
  },
  responses: {
    200: {
      description: 'Opaque single-use grant id',
      content: { 'application/json': { schema: CreateLinkGrantResponseSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    403: {
      description: 'Non-web credential (PAT / OAuth access token)',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    404: {
      description: 'Unknown, unconfigured, or credential-kind provider',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const unlinkAuthProviderRoute = createRoute({
  method: 'delete',
  path: '/auth/providers/{name}/identity',
  tags: ['federatedAuth'],
  summary: "Disconnect the current user's identity for this provider",
  request: {
    params: z.object({ name: z.string() }),
  },
  responses: {
    204: { description: 'Identity removed' },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    403: {
      description: 'Non-web credential (PAT / OAuth access token)',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    404: {
      description: 'No identity linked for this provider',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    409: {
      description: 'Refused: password auth is disabled instance-wide, or this user has no password set',
      content: { 'application/json': { schema: UnlinkAuthProviderErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const callbackFederatedProviderRoute = createRoute({
  method: 'get',
  path: '/auth/providers/{name}/callback',
  tags: ['federatedAuth'],
  summary: 'Provider redirect target; completes the OAuth2/OIDC exchange',
  request: {
    params: z.object({ name: z.string() }),
    query: z.object({
      code: z.string().optional(),
      state: z.string().optional(),
      error: z.string().optional(),
    }),
  },
  responses: {
    302: {
      description: 'Redirect to the trusted web login/complete page on success, or back to the trusted web /login on failure',
    },
    404: {
      description: 'Unknown or unconfigured provider (also used when trusted origins cannot be resolved)',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const federatedHandoffRoute = createRoute({
  method: 'post',
  path: '/auth/handoff',
  tags: ['federatedAuth'],
  summary: 'Exchange a sender-constrained federated handoff code for session tokens',
  request: {
    body: { content: { 'application/json': { schema: FederatedHandoffRequestSchema } } },
  },
  responses: {
    200: {
      description: 'Session tokens — same shape as POST /auth/login',
      content: { 'application/json': { schema: FederatedHandoffResponseSchema } },
    },
    401: {
      description: 'Invalid / expired handoff code, or sender proof did not verify',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    409: {
      description: 'Handoff code already consumed',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const federatedAuthRoutes = {
  listFederatedProvidersRoute,
  startFederatedProviderRoute,
  callbackFederatedProviderRoute,
  federatedHandoffRoute,
  listLinkedAuthProvidersRoute,
  createAuthProviderLinkGrantRoute,
  unlinkAuthProviderRoute,
};
