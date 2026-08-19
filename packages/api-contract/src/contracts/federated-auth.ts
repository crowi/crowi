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

import { ApiErrorSchema, AuthenticationRequiredErrorSchema, InternalServerErrorSchema, ValidationErrorSchema } from '../schemas/common';
import {
  CompleteProviderLinkConflictErrorSchema,
  CompleteProviderLinkResponseSchema,
  FederatedHandoffRequestSchema,
  FederatedHandoffResponseSchema,
  LinkCompletionCodeSchema,
  LinkCompletionConsumedErrorSchema,
  LinkedAuthProviderListResponseSchema,
  PendingLinkCompletionResponseSchema,
  ProviderListResponseSchema,
  StartProviderLinkResponseSchema,
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
  summary: 'Top-level navigation that redirects the browser to the named provider (public sign-in ONLY)',
  request: {
    params: z.object({ name: z.string() }),
    query: z.object({
      continue: ContinuePathSchema,
      /** base64url(JSON) of the sender's P-256 public JWK. */
      handoff_jwk: z.string().min(1),
      /** base64url ES256 signature over the start canonical message. */
      handoff_proof: z.string().min(1),
    }),
  },
  responses: {
    302: { description: 'Redirect to the provider authorization endpoint' },
    400: {
      description:
        'Malformed continue / sender proof, OR a raw `link` query key is present (any value) — ' +
        'the retired link-via-GET flow is gone entirely; a raw `link` key is always rejected rather than silently downgraded to public sign-in.',
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

/**
 * Stage 1: an authenticated web-session
 * POST mints the IdP authorization URL and a flow-specific state cookie.
 * `createJwtAuth` is installed via `app.use(...)` BEFORE `.openapi(...)`
 * registration (see `hono/handlers/federated-auth.ts`), so credential
 * resolution — and any PAT `lastUsedAt` bump — happens strictly before this
 * route's own Zod validation runs: an unauthenticated/malformed-credential
 * request never reaches this handler at all (401), regardless of the path
 * shape.
 */
export const startProviderLinkRoute = createRoute({
  method: 'post',
  path: '/auth/providers/{name}/link-start',
  tags: ['federatedAuth'],
  summary: 'Mint an IdP authorization URL + flow-specific state cookie for the current web session (stage 1 of 3)',
  request: {
    params: z.object({ name: z.string() }),
  },
  responses: {
    200: {
      description: 'Authorization URL to navigate the browser to. Sets a flow-specific, 300s state cookie.',
      content: { 'application/json': { schema: StartProviderLinkResponseSchema } },
    },
    400: {
      description:
        'The signed link-state cookie value would exceed its per-cookie byte limit, or the aggregate Cookie-header admission budget cannot be satisfied even after pruning — no Set-Cookie or authorizationUrl is returned.',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    401: {
      description: "Authentication required (credential missing/invalid — resolved by middleware before this route's own validation)",
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    403: {
      description: 'Non-web credential (PAT / OAuth access token) — linking is a session-level account change',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    404: {
      description: 'Unknown, unconfigured, or credential-kind provider',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    500: {
      description: 'Internal server error (e.g. a declared multi-instance topology with no reachable Redis)',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

/**
 * Stage 3a: authenticated, non-
 * destructive confirmation read. Same auth-before-validation ordering as
 * `link-start` — an unauthenticated request is always 401 regardless of
 * whether `{code}` is well-formed.
 */
export const getProviderLinkCompletionRoute = createRoute({
  method: 'get',
  path: '/auth/providers/{name}/link-completions/{code}',
  tags: ['federatedAuth'],
  summary: "Read a pending link completion's confirmation details (stage 3a — non-destructive)",
  request: {
    params: z.object({ name: z.string(), code: LinkCompletionCodeSchema }),
  },
  responses: {
    200: {
      description: 'Pending, unconsumed completion bound to the caller — provider label fallback + optional display-only accountLabel',
      content: { 'application/json': { schema: PendingLinkCompletionResponseSchema } },
    },
    400: {
      description: 'Authenticated but `{code}` fails the 43-character base64url shape (VALIDATION_ERROR)',
      content: { 'application/json': { schema: ValidationErrorSchema } },
    },
    401: {
      description:
        "Authentication required — resolved by middleware before this route's own `{code}` shape validation, so an unauthenticated + malformed code is still 401, never 400",
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    403: {
      description: 'Non-web credential (PAT / OAuth access token)',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    404: {
      description:
        'Never-issued, expired, retention-expired, or bound to a different user/provider/authVersion — all collapse to the same generic NOT_FOUND (no result-unknown code exists)',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    409: {
      description: "The caller's own completion was already consumed",
      content: { 'application/json': { schema: LinkCompletionConsumedErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

/**
 * Stage 3b: authenticated final
 * confirmation. Atomically consumes `{code}`; a fresh `User` re-read fences
 * ACTIVE status + `authVersion` before the identity insert. Same auth-
 * before-validation ordering as the GET above.
 */
export const completeProviderLinkRoute = createRoute({
  method: 'post',
  path: '/auth/providers/{name}/link-completions/{code}',
  tags: ['federatedAuth'],
  summary: 'Atomically consume a link completion code and insert the identity (stage 3b — terminal)',
  request: {
    params: z.object({ name: z.string(), code: LinkCompletionCodeSchema }),
  },
  responses: {
    200: {
      description: 'Linked (fresh winner OR an already-consumed replay that resolves to the same owner) — the same body either way',
      content: { 'application/json': { schema: CompleteProviderLinkResponseSchema } },
    },
    400: {
      description: 'Authenticated but `{code}` fails the 43-character base64url shape (VALIDATION_ERROR)',
      content: { 'application/json': { schema: ValidationErrorSchema } },
    },
    401: {
      description:
        "Authentication required — resolved by middleware before this route's own `{code}` shape validation, so an unauthenticated + malformed code is still 401, never 400",
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    403: {
      description: 'Non-web credential (PAT / OAuth access token)',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    404: {
      description: 'Never-issued, expired, retention-expired, or bound to a different user/provider — all collapse to the same generic NOT_FOUND',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    409: {
      description:
        'FEDERATED_IDENTITY_IN_USE (provider account owned by someone else, or this user already has a different account of this provider), ' +
        'FEDERATED_LINK_AUTH_STATE_CHANGED (fresh User re-read found the session inactive or authVersion changed since link-start), or ' +
        'FEDERATED_LINK_NOT_LINKED (an already-consumed replay whose original insert has not landed) — no other conflict code exists.',
      content: { 'application/json': { schema: CompleteProviderLinkConflictErrorSchema } },
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
      description:
        'Ordinary sign-in: redirect to the trusted web login/complete page on success, or back to the trusted web /login on failure. ' +
        'Link flow (query `state` in the reserved crowilnk_ namespace): success redirects to `/me?provider=<name>&link_completion=<code>` ' +
        '(provider + completion code ONLY); failure redirects to `/me?provider=<name>&link=link_failed` (provider + the generic marker ONLY — ' +
        'never a completion code, never accountLabel, never the underlying reason).',
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
  startProviderLinkRoute,
  getProviderLinkCompletionRoute,
  completeProviderLinkRoute,
  unlinkAuthProviderRoute,
};
