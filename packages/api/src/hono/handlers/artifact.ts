/**
 * Must register after registerRevisionRoutes in buildHonoApp — this route
 * relies on the /pages/* JWT middleware that registration installs, and
 * Hono composes middleware/handlers in registration order. Scope is
 * enforced explicitly via applyScope because JWT middleware alone
 * authenticates and does not check scope.
 */
import { mintArtifactUrlRoute } from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import Debug from 'debug';
import { Types } from 'mongoose';

import {
  ARTIFACT_TOKEN_TTL_SECONDS,
  ARTIFACT_URL_ERROR_MESSAGES,
  type ArtifactUrlErrorReason,
  mintArtifactToken,
  resolveArtifactTokenKey,
} from 'src/artifact/delivery';
import { resolveArtifactPolicySnapshot } from 'src/artifact/policy';
import type Crowi from 'src/crowi';
import type { RevisionDocument, RevisionModel } from 'src/models/revision';
import { isValidObjectId, loadGrantedPage } from 'src/util/ts-rest-helpers';

import type { CrowiHonoBindings } from '../app';
import { applyScope } from '../middleware/require-scope';
import { INTERNAL_ERROR_BODY, INVALID_PAGE_ID_BODY, PAGE_NOT_FOUND_BODY } from './_helpers/errors';

const debug = Debug('crowi:hono:handlers:artifact');

const artifactUrlUnavailableBody = (reason: ArtifactUrlErrorReason) => ({
  error: { code: 'ARTIFACT_URL_UNAVAILABLE' as const, reason, message: ARTIFACT_URL_ERROR_MESSAGES[reason] },
});

/** `ValidationErrorSchema` envelope for a malformed `revisionId` body field. */
const INVALID_REVISION_ID_BODY = {
  error: { code: 'VALIDATION_ERROR' as const, message: 'Invalid revision id' as const },
};

type ResolveTargetRevisionResult =
  | { ok: true; revision: RevisionDocument }
  | { ok: false; reason: 'invalid-id' }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'pointerless' };

/** Given an optional explicit revision id and the Page's populated current revision, resolves which Revision the request targets. */
async function resolveTargetRevision(
  Revision: RevisionModel,
  explicitRevisionId: string | undefined,
  currentRevision: RevisionDocument | undefined,
  normalizedPageId: string,
): Promise<ResolveTargetRevisionResult> {
  if (explicitRevisionId !== undefined) {
    if (!isValidObjectId(explicitRevisionId)) return { ok: false, reason: 'invalid-id' };
    const revision = (await Revision.findRevision(new Types.ObjectId(explicitRevisionId))) as RevisionDocument | null;
    // Don't distinguish "missing" from "belongs to another page" — both
    // report as 'not-found' — to avoid leaking information about other
    // pages' revisions.
    if (!revision || revision.page == null || revision.page.toString() !== normalizedPageId) return { ok: false, reason: 'not-found' };
    return { ok: true, revision };
  }
  if (!currentRevision) return { ok: false, reason: 'pointerless' };
  return { ok: true, revision: currentRevision };
}

export const registerArtifactRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(app: E, crowi: Crowi) => {
  const Page = crowi.model('Page');
  const Revision = crowi.model('Revision');

  // Minting a URL grants the same effective read access as fetching the
  // page itself, so this must require the same scope explicitly —
  // otherwise a token scoped only to e.g. attachments:read could mint a
  // URL and read the full artifact body through it.
  applyScope(app, mintArtifactUrlRoute, 'pages:read');

  return app.openapi(mintArtifactUrlRoute, async (c) => {
    const user = c.get('user');
    const { id: pageId } = c.req.valid('param');
    const { revisionId } = c.req.valid('json');

    // `loadGrantedPage` owns both the `isValidObjectId` shape check
    // (400 INVALID_PAGE_ID) and the throw-swallowing existence/grant check
    // (404 PAGE_NOT_FOUND); this handler distinguishes only those 2
    // statuses, same as `handlers/attachment.ts`'s `getAttachmentUsageRoute`.
    const loaded = await loadGrantedPage(Page, pageId, user);
    if ('error' in loaded) {
      if (loaded.error.status === 400) return c.json(INVALID_PAGE_ID_BODY, 400);
      return c.json(PAGE_NOT_FOUND_BODY, 404);
    }

    // `loadGrantedPage`'s `isValidObjectId` gate already forces `pageId`
    // lowercase, so this and `pageId` are the same string today — but the
    // URL/token this handler mints is built from the loaded document's own
    // id rather than re-threading `pageId`, so a future change to that gate
    // (or to `loadGrantedPage` itself) can't silently start minting a
    // case-mismatched pair.
    const normalizedPageId = loaded.page._id.toString();

    // Populated once target revision is resolved so errors can be classified
    // without logging details; used only for categorization, never in response.
    let resolvedRevisionId: string | undefined;
    try {
      // `loadGrantedPage` -> `findPageByIdAndGrantedUser` -> `findPageById`
      // -> `populatePageData` already populates `revision` into a live
      // document; a pointerless Page leaves it unset.
      const currentRevision = loaded.page.revision as unknown as RevisionDocument | undefined;
      const resolved = await resolveTargetRevision(Revision, revisionId, currentRevision, normalizedPageId);
      if (!resolved.ok) {
        // invalid-id is the only reason with its own status/body; 'not-found'
        // and 'pointerless' both collapse into PAGE_NOT_FOUND_BODY.
        if (resolved.reason === 'invalid-id') return c.json(INVALID_REVISION_ID_BODY, 400);
        return c.json(PAGE_NOT_FOUND_BODY, 404);
      }
      const targetRevision = resolved.revision;
      resolvedRevisionId = targetRevision._id.toString();

      if (targetRevision.contentType !== 'artifact') {
        // The specific reason is only ever the response body's own `reason`
        // field, never the debug log — the log's `outcome` stays a plain
        // ok/error status so it never grows a 3rd value future error
        // reasons would otherwise need to be added to.
        debug('mintArtifactUrl', { pageId: normalizedPageId, revisionId: resolvedRevisionId, outcome: 'error' });
        return c.json(artifactUrlUnavailableBody('NOT_AN_ARTIFACT'), 400);
      }

      // Resolved exactly once per request to avoid inconsistency if config changes mid-request.
      const snapshot = resolveArtifactPolicySnapshot(crowi);
      if (snapshot.deliveryMode === 'disabled') {
        debug('mintArtifactUrl', { pageId: normalizedPageId, revisionId: resolvedRevisionId, outcome: 'error' });
        return c.json(artifactUrlUnavailableBody('ARTIFACT_DELIVERY_NOT_CONFIGURED'), 422);
      }
      const key = resolveArtifactTokenKey();

      const nowMs = Date.now();
      const expiresAtMs = nowMs + ARTIFACT_TOKEN_TTL_SECONDS * 1000;
      const token = mintArtifactToken(key, { p: normalizedPageId, r: resolvedRevisionId, u: user._id.toString(), e: expiresAtMs });
      const url = `${snapshot.artifactOrigin}/api/artifact/${normalizedPageId}/${resolvedRevisionId}?t=${token}`;

      debug('mintArtifactUrl', { pageId: normalizedPageId, revisionId: resolvedRevisionId, outcome: 'ok' });
      return c.json({ url, expiresAt: new Date(expiresAtMs).toISOString() }, 200);
    } catch {
      // Log only the classification, never the caught error's message.
      debug('mintArtifactUrl', { pageId: normalizedPageId, revisionId: resolvedRevisionId, outcome: 'error' });
      return c.json(INTERNAL_ERROR_BODY, 500);
    }
  });
};
