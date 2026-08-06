/**
 * RFC-0014 phase 2 — federated registration screen + JIT provisioning.
 *
 * `{token}` is a one-time secret (a registration grant) — treated like the
 * activation / invite / password-reset tokens elsewhere in this package:
 * public (no JWT), the token itself is the credential. Unknown, expired, and
 * cancelled grants are deliberately indistinguishable (all 404) so a probe
 * can't learn which case it hit.
 */
import { createRoute, z } from '@hono/zod-openapi';

import { ApiErrorSchema, InternalServerErrorSchema } from '../schemas/common';
import {
  FederatedRegistrationResultSchema,
  FederatedRegistrationSnapshotSchema,
  FederatedRegistrationSubmitRequestSchema,
} from '../schemas/federated-registration';

const TokenParamSchema = z.object({ token: z.string().min(1) });

export const getFederatedRegistrationRoute = createRoute({
  method: 'get',
  path: '/auth/federated-registration/{token}',
  tags: ['federatedRegistration'],
  summary: 'Read-only snapshot (email/provider/providerLabel) for a pending federated registration',
  request: {
    params: TokenParamSchema,
  },
  responses: {
    200: {
      description: 'Pending registration snapshot',
      content: { 'application/json': { schema: FederatedRegistrationSnapshotSchema } },
    },
    404: {
      description: 'Grant is unknown, expired, or cancelled',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const submitFederatedRegistrationRoute = createRoute({
  method: 'post',
  path: '/auth/federated-registration/{token}',
  tags: ['federatedRegistration'],
  summary: 'Submit the chosen username; provisions the User (JIT) and activates or queues approval',
  request: {
    params: TokenParamSchema,
    body: { content: { 'application/json': { schema: FederatedRegistrationSubmitRequestSchema } } },
  },
  responses: {
    200: {
      description: 'Open: account is active — a Phase 1 handoff code, redeemed via POST /auth/handoff. Restricted: awaiting admin approval.',
      content: { 'application/json': { schema: FederatedRegistrationResultSchema } },
    },
    400: {
      description: 'Username fails the shared username contract',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    404: {
      description: 'Grant is unknown, expired, or cancelled',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    409: {
      description: 'Username/email already taken, or the identity is already linked to a different user',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const logoutFederatedRegistrationRoute = createRoute({
  method: 'post',
  path: '/auth/federated-registration/{token}/logout',
  tags: ['federatedRegistration'],
  summary: 'Cancel a pending federated registration and invalidate the grant',
  request: {
    params: TokenParamSchema,
  },
  responses: {
    204: { description: 'Grant cancelled (or was already inactive) — idempotent' },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const federatedRegistrationRoutes = {
  getFederatedRegistrationRoute,
  submitFederatedRegistrationRoute,
  logoutFederatedRegistrationRoute,
};
