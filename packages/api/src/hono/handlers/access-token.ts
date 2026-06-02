/**
 * RFC-0010 §Endpoints — Personal Access Token (PAT) management.
 *
 * Replaces the legacy `GET/POST /me/apiToken`. Three endpoints under
 * `/me/*`, riding the broad `createJwtAuth(crowi)` that `registerMeRoutes`
 * already installs (so no second auth apply / second `User.findById`):
 *
 *   GET    /me/access-tokens       — list metadata (never the secret)
 *   POST   /me/access-tokens       — issue a PAT; returns plaintext once
 *   DELETE /me/access-tokens/:id   — revoke a PAT
 *
 * **Web-session only** (RFC-0010 §Security, PHASE2-Q4): a PAT or OAuth
 * token presenting itself here is rejected with 403 `FORBIDDEN`. Minting
 * a fresh PAT from an existing token would be a privilege escalation
 * (longer-lived, possibly broader-scoped), so token management is gated
 * to interactive web sessions.
 *
 * Scope validation: `POST` rejects (400 `INVALID_SCOPE`) any requested
 * scope outside `ISSUABLE_SCOPES` (catalog scopes minus `admin:*`).
 */
import type { CreateAccessTokenResponse, ForbiddenError, InvalidScopeError } from '@crowi/api-contract';
import { createAccessTokenRoute, deleteAccessTokenRoute, isIssuableScope, listAccessTokensRoute } from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import Debug from 'debug';
import { Types } from 'mongoose';

import type Crowi from 'src/crowi';
import type { PersonalAccessTokenDocument } from 'src/models/personal-access-token';

import type { CrowiHonoBindings } from '../app';

const debug = Debug('crowi:hono:handlers:access-token');

const FORBIDDEN_BODY: ForbiddenError = {
  error: {
    code: 'FORBIDDEN',
    message: 'Personal access tokens can only be managed from a web session.',
  },
};

/** Serialise a PAT document to its public metadata (never the secret). */
const toAccessTokenResponse = (doc: PersonalAccessTokenDocument) => ({
  id: doc._id.toString(),
  name: doc.name,
  scopes: doc.scopes,
  expiresAt: doc.expiresAt ? doc.expiresAt.toISOString() : null,
  lastUsedAt: doc.lastUsedAt ? doc.lastUsedAt.toISOString() : null,
  createdAt: doc.createdAt.toISOString(),
});

export const registerAccessTokenRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(app: E, crowi: Crowi) => {
  const PersonalAccessToken = crowi.model('PersonalAccessToken');

  // No `app.use('/me/*', createJwtAuth)` here — `registerMeRoutes` owns
  // that broad apply and MUST register first (see `hono/index.ts`). These
  // routes therefore see `c.get('user')` / `c.get('authContext')` already
  // populated.

  return app
    .openapi(listAccessTokensRoute, async (c) => {
      if (c.get('authContext').kind !== 'web') {
        return c.json(FORBIDDEN_BODY, 403);
      }
      const user = c.get('user');
      try {
        const tokens = await PersonalAccessToken.listByUser(user._id);
        return c.json({ accessTokens: tokens.map(toAccessTokenResponse) }, 200);
      } catch (err) {
        debug('listAccessTokens failed:', err);
        return c.json({ error: { code: 'INTERNAL_ERROR' as const, message: 'Internal server error' as const } }, 500);
      }
    })
    .openapi(createAccessTokenRoute, async (c) => {
      if (c.get('authContext').kind !== 'web') {
        return c.json(FORBIDDEN_BODY, 403);
      }
      const user = c.get('user');
      const { name, scopes, expiresAt } = c.req.valid('json');

      // Reject any requested scope outside the issuable set (catalog minus
      // `admin:*`). Deduplicate to keep the stored array tidy.
      const invalidScopes = scopes.filter((s) => !isIssuableScope(s));
      if (invalidScopes.length > 0) {
        const body: InvalidScopeError = {
          error: {
            code: 'INVALID_SCOPE',
            message: `One or more requested scopes cannot be issued: ${invalidScopes.join(', ')}`,
            details: { invalidScopes },
          },
        };
        return c.json(body, 400);
      }
      const uniqueScopes = [...new Set(scopes)];

      try {
        const { token, tokenHash } = PersonalAccessToken.generateToken();
        const created = await PersonalAccessToken.create({
          tokenHash,
          userId: user._id,
          name,
          scopes: uniqueScopes,
          expiresAt: expiresAt ? new Date(expiresAt) : null,
        });

        const body: CreateAccessTokenResponse = { ...toAccessTokenResponse(created), token };
        return c.json(body, 201);
      } catch (err) {
        debug('createAccessToken failed:', err);
        return c.json({ error: { code: 'INTERNAL_ERROR' as const, message: 'Internal server error' as const } }, 500);
      }
    })
    .openapi(deleteAccessTokenRoute, async (c) => {
      if (c.get('authContext').kind !== 'web') {
        return c.json(FORBIDDEN_BODY, 403);
      }
      const user = c.get('user');
      const { id } = c.req.valid('param');

      if (!Types.ObjectId.isValid(id)) {
        return c.json({ error: { code: 'NOT_FOUND' as const, message: 'No such access token' } }, 404);
      }

      try {
        // Scope the lookup to the caller so one user cannot revoke
        // another's token (an unknown / already-revoked id is a 404).
        const doc = await PersonalAccessToken.findOne({ _id: new Types.ObjectId(id), userId: user._id });
        if (!doc) {
          return c.json({ error: { code: 'NOT_FOUND' as const, message: 'No such access token' } }, 404);
        }
        if (!doc.revokedAt) {
          doc.revokedAt = new Date();
          await doc.save();
        }
        return c.json(toAccessTokenResponse(doc), 200);
      } catch (err) {
        debug('deleteAccessToken failed:', err);
        return c.json({ error: { code: 'INTERNAL_ERROR' as const, message: 'Internal server error' as const } }, 500);
      }
    });
};
