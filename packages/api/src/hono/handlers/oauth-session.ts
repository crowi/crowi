/**
 * Self-service OAuth session (refresh-token rotation-chain tip) list + revoke.
 *
 *   GET    /me/oauth-sessions       — list active tips (metadata only)
 *   DELETE /me/oauth-sessions/:id   — revoke the reachable rotation-chain component
 *
 * Mirrors `./access-token.ts`'s web-session-only pattern and rides `registerMeRoutes`'s broad `/me/*` `createJwtAuth` apply (no second install here — see `hono/index.ts`).
 *
 * A "session" here is one active `OAuthRefreshToken` rotation-chain TIP document, not a stable identity: the public `id` is the tip's `_id`, which changes on every rotation. `DELETE` therefore does its ownership lookup WITHOUT an active-tip filter (a rotated-away id still resolves while its document exists, pre-TTL) and revokes via the existing `revokeChain` graph traversal, then re-confirms the SAME `_id + userId` is now revoked before returning 200 — `revokeChain` can no-op (its origin document TTL-deleted between the ownership lookup and the traversal) without throwing, so this re-check is the only way to avoid reporting success for a component that is, in fact, still active.
 */
import type { ForbiddenError, NotFoundError, OAuthSession } from '@crowi/api-contract';
import { deleteOAuthSessionRoute, listOAuthSessionsRoute } from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import Debug from 'debug';
import { Types } from 'mongoose';

import type Crowi from 'src/crowi';
import type { OAuthClientModel } from 'src/models/oauth-client';
import type { OAuthRefreshTokenDocument } from 'src/models/oauth-refresh-token';

import type { CrowiHonoBindings } from '../app';
import { INTERNAL_ERROR_BODY } from './_helpers/errors';

const debug = Debug('crowi:hono:handlers:oauth-session');

const FORBIDDEN_BODY: ForbiddenError = {
  error: {
    code: 'FORBIDDEN',
    message: 'OAuth sessions can only be managed from a web session.',
  },
};

const NOT_FOUND_BODY: NotFoundError = {
  error: {
    code: 'NOT_FOUND',
    message: 'No such OAuth session',
  },
};

/** The subset of a tip document's fields that make up an `OAuthSession` response. */
type OAuthSessionFields = {
  id: Types.ObjectId;
  clientId: string;
  scopes: string[];
  authorizedAt: Date;
  lastRefreshedAt: Date;
  expiresAt: Date;
};

/** Project a tip document down to its response fields (chain-origin `authorizedAt` fallback applied here, once). */
const toSessionFields = (tip: OAuthRefreshTokenDocument): OAuthSessionFields => ({
  id: tip._id,
  clientId: tip.clientId,
  scopes: tip.scopes,
  authorizedAt: tip.authorizedAt ?? tip.createdAt,
  lastRefreshedAt: tip.createdAt,
  expiresAt: tip.expiresAt,
});

/** Serialise session fields to public metadata (never the tokenHash). */
const toOAuthSessionResponse = (fields: OAuthSessionFields, clientName: string): OAuthSession => ({
  id: fields.id.toString(),
  clientId: fields.clientId,
  clientName,
  scopes: fields.scopes,
  authorizedAt: fields.authorizedAt.toISOString(),
  lastRefreshedAt: fields.lastRefreshedAt.toISOString(),
  expiresAt: fields.expiresAt.toISOString(),
});

/**
 * `clientId -> OAuthClient.name` for the given ids, in one batch query. A query failure or an unregistered client id is never fatal — callers fall back to the raw `clientId` because a display-name lookup failure must not fail the request or leave a token alive.
 */
const resolveClientNames = async (OAuthClient: OAuthClientModel, clientIds: string[]): Promise<Map<string, string>> => {
  try {
    const clients = await OAuthClient.find({ clientId: { $in: clientIds } }).exec();
    return new Map(clients.map((client) => [client.clientId, client.name]));
  } catch {
    debug('oauth-session: client name lookup failed');
    return new Map();
  }
};

export const registerOAuthSessionRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(app: E, crowi: Crowi) => {
  const OAuthRefreshToken = crowi.model('OAuthRefreshToken');
  const OAuthClient = crowi.model('OAuthClient');

  // No `app.use('/me/*', createJwtAuth)` here — `registerMeRoutes` owns
  // that broad apply and MUST register first (see `hono/index.ts`).

  return app
    .openapi(listOAuthSessionsRoute, async (c) => {
      if (c.get('authContext').kind !== 'web') {
        return c.json(FORBIDDEN_BODY, 403);
      }
      const currentUser = c.get('user');

      try {
        // One request-local instant governs both the active-tip filter and
        // the response — a rotation/DELETE elsewhere mid-request is simply
        // not reflected in THIS response; the client's next refetch sees it.
        const now = new Date();
        const tips = await OAuthRefreshToken.listActiveByUser(currentUser._id, now);
        if (tips.length === 0) {
          return c.json({ oauthSessions: [] }, 200);
        }

        const clientNames = await resolveClientNames(OAuthClient, [...new Set(tips.map((tip) => tip.clientId))]);
        return c.json({ oauthSessions: tips.map((tip) => toOAuthSessionResponse(toSessionFields(tip), clientNames.get(tip.clientId) ?? tip.clientId)) }, 200);
      } catch {
        debug('listOAuthSessions: query failed');
        return c.json(INTERNAL_ERROR_BODY, 500);
      }
    })
    .openapi(deleteOAuthSessionRoute, async (c) => {
      if (c.get('authContext').kind !== 'web') {
        return c.json(FORBIDDEN_BODY, 403);
      }
      const currentUser = c.get('user');
      const { id } = c.req.valid('param');

      if (!Types.ObjectId.isValid(id)) {
        return c.json(NOT_FOUND_BODY, 404);
      }

      try {
        // No active-tip filter: a rotated-away (no longer a tip) id must
        // still resolve here as long as its document has not been
        // TTL-deleted, so `revokeChain` can walk the chain it belongs to.
        const doc = await OAuthRefreshToken.findOne({ _id: new Types.ObjectId(id), userId: currentUser._id }).exec();
        if (!doc) {
          return c.json(NOT_FOUND_BODY, 404);
        }

        // Non-secret snapshot taken BEFORE `revokeChain` — the response is
        // built from this snapshot, never from a later re-read (there is
        // no guarantee a later read would still find the same shape).
        const snapshot = toSessionFields(doc);

        try {
          await OAuthRefreshToken.revokeChain(doc.tokenHash);
        } catch {
          debug('deleteOAuthSession: revokeChain failed');
          return c.json(INTERNAL_ERROR_BODY, 500);
        }

        // `revokeChain` no-ops (without throwing) when its own origin
        // document was TTL-deleted between the ownership lookup above and
        // its own re-query — re-confirm the addressed document is now
        // revoked before reporting success, so that race never returns a
        // 200 for a component that is still active.
        let revokedNow: boolean;
        try {
          revokedNow = (await OAuthRefreshToken.exists({ _id: snapshot.id, userId: currentUser._id, revokedAt: { $ne: null } })) != null;
        } catch {
          debug('deleteOAuthSession: post-revoke check failed');
          return c.json(INTERNAL_ERROR_BODY, 500);
        }
        if (!revokedNow) {
          return c.json(NOT_FOUND_BODY, 404);
        }

        const clientNames = await resolveClientNames(OAuthClient, [snapshot.clientId]);
        return c.json(toOAuthSessionResponse(snapshot, clientNames.get(snapshot.clientId) ?? snapshot.clientId), 200);
      } catch {
        debug('deleteOAuthSession: query failed');
        return c.json(INTERNAL_ERROR_BODY, 500);
      }
    });
};
