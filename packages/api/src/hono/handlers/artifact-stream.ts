/**
 * Neither route here is a contract route (both return raw HTML bytes, not
 * JSON). The token-delivery route sits outside /pages/* specifically to
 * avoid its auth middleware — the signed token is the only credential
 * available on the artifact origin, which never receives Crowi's session
 * cookie. The download route sits inside /pages/* and requires pages:read
 * scope via requireScope (same as the attachment routes). Both must
 * register after registerRevisionRoutes to inherit the /pages/* JWT
 * middleware.
 */
import type { OpenAPIHono } from '@hono/zod-openapi';
import Debug from 'debug';
import { Types } from 'mongoose';

import { buildArtifactContentSecurityPolicy, extractArtifactDigestMarkers } from 'src/artifact/csp';
import { artifactDownloadFilename, resolveArtifactTokenKey, verifyArtifactToken } from 'src/artifact/delivery';
import { resolveArtifactPolicySnapshot } from 'src/artifact/policy';
import { resolveTargetRevision } from 'src/artifact/revision-lookup';
import type Crowi from 'src/crowi';
import type { RevisionDocument } from 'src/models/revision';
import { loadGrantedPage } from 'src/util/ts-rest-helpers';

import type { CrowiHonoBindings } from '../app';
import { requireScope } from '../middleware/require-scope';

import { PAGE_NOT_FOUND_BODY } from './_helpers/errors';
import { encodeRfc8187 } from './attachment-stream';

const debug = Debug('crowi:hono:handlers:artifact-stream');

// V-1 through V-5 all return this fixed text; never distinguish error causes.
const NOT_FOUND_TEXT = 'Not found.';
// V-6 is distinguished because the caller already holds a valid token.
const SERVE_FAILED_TEXT = 'Artifact could not be served.';

const textResponse = (status: number, body: string): Response => new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

const notFoundResponse = (): Response => textResponse(404, NOT_FOUND_TEXT);
const serveFailedResponse = (): Response => textResponse(500, SERVE_FAILED_TEXT);

/** `ValidationErrorSchema` envelope for a malformed `revision` query param. */
const INVALID_REVISION_ID_BODY = {
  error: { code: 'VALIDATION_ERROR' as const, message: 'Invalid revision id' as const },
};

export const registerArtifactStreamRoutes = (app: OpenAPIHono<CrowiHonoBindings>, crowi: Crowi) => {
  const Page = crowi.model('Page');
  const Revision = crowi.model('Revision');

  // Same guard shape `attachment-stream.ts` installs for `/original` and
  // `/download` (`requireScope`, not `applyScope` — this is a hand-coded
  // route, not a `createRoute(...)` contract). MUST run after the
  // `/pages/*` `createJwtAuth` apply so `authScopes` is populated.
  app.use('/pages/:id{[0-9a-fA-F]{24}}/artifact-download', requireScope('pages:read'));

  app.get('/artifact/:pageId{[0-9a-fA-F]{24}}/:revisionId{[0-9a-fA-F]{24}}', async (c) => {
    // The mint route always builds this URL from the exact `p`/`r` values it
    // just signed into the token, so a legitimate request's path segments
    // are already byte-identical to the token's payload. A path that
    // differs only in case therefore never comes from the mint route —
    // comparing it verbatim (no normalization) is what makes the token's
    // MAC the sole authority over `p`/`r`, rather than something a client
    // could satisfy by adjusting casing.
    const pathPageId = c.req.param('pageId');
    const pathRevisionId = c.req.param('revisionId');
    const token = c.req.query('t');

    const finish = (outcome: string, response: Response, loggedPageId: string = pathPageId, loggedRevisionId: string = pathRevisionId): Response => {
      debug('serveArtifact', { pageId: loggedPageId, revisionId: loggedRevisionId, outcome });
      return response;
    };

    if (typeof token !== 'string' || token.length === 0) return finish('V-1', notFoundResponse());

    const key = resolveArtifactTokenKey();
    const payload = verifyArtifactToken(key, token, { pageId: pathPageId, revisionId: pathRevisionId }, Date.now());
    if (payload === null) return finish('V-1', notFoundResponse());

    let revision: RevisionDocument | null;
    try {
      revision = (await Revision.findRevision(new Types.ObjectId(pathRevisionId))) as RevisionDocument | null;
    } catch {
      // A DB-level failure here is reported the same way a marker/CSP
      // failure below is (500, fixed text) — reuse that classification
      // rather than inventing a 3rd, undocumented log outcome.
      return finish('V-6', serveFailedResponse());
    }
    if (!revision) return finish('V-2', notFoundResponse());

    // Logged from here on using the loaded document's own ids, not the raw
    // path segments, so a future change upstream of this point can't
    // silently start logging a case- or value-mismatched pair.
    const loadedRevisionId = revision._id.toString();
    if (revision.contentType !== 'artifact') return finish('V-3', notFoundResponse(), pathPageId, loadedRevisionId);
    if (revision.page == null || revision.page.toString() !== pathPageId) return finish('V-4', notFoundResponse(), pathPageId, loadedRevisionId);
    const loadedPageId = revision.page.toString();

    // Resolved once per request. The mint route resolves its own snapshot
    // independently, so configuration changes between requests are
    // possible (accepted tradeoff).
    const snapshot = resolveArtifactPolicySnapshot(crowi);
    if (snapshot.deliveryMode === 'disabled') return finish('V-5', notFoundResponse(), loadedPageId, loadedRevisionId);

    const markersResult = extractArtifactDigestMarkers(revision.body);
    if (!markersResult.ok) return finish('V-6', serveFailedResponse(), loadedPageId, loadedRevisionId);
    const cspResult = buildArtifactContentSecurityPolicy(markersResult.markers, snapshot);
    if (!cspResult.ok) return finish('V-6', serveFailedResponse(), loadedPageId, loadedRevisionId);

    const headers: Record<string, string> = {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': cspResult.header,
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      'Content-Length': String(Buffer.byteLength(revision.body, 'utf8')),
    };
    return finish('ok', new Response(revision.body, { status: 200, headers }), loadedPageId, loadedRevisionId);
  });

  app.get('/pages/:id{[0-9a-fA-F]{24}}/artifact-download', async (c) => {
    const user = c.get('user');
    const pageId = c.req.param('id');
    const revisionQuery = c.req.query('revision');

    // Mirrors the token-delivery route's `finish` — same allow-listed
    // fields. `revisionId` is only ever passed once it is a confirmed
    // 24-hex ObjectId (validated by `isValidObjectId` or looked up from the
    // Page/Revision itself) — the raw, author-controlled `revision` query
    // string never reaches the log, including on the `invalid-revision`
    // branch where it is, by definition, not a valid id.
    const finish = <T extends Response>(outcome: string, response: T, loggedPageId: string, revisionId?: string): T => {
      debug('downloadArtifact', { pageId: loggedPageId, revisionId, outcome });
      return response;
    };

    // The route's own `{[0-9a-fA-F]{24}}` constraint accepts uppercase hex
    // (Hono's own unmatched-route 404 only blocks a non-hex-shaped id), but
    // `isValidObjectId` inside `loadGrantedPage` is lowercase-only, so an
    // uppercase-hex id still reaches — and is rejected by — its 400
    // INVALID_PAGE_ID branch, same as every other `isValidObjectId`-gated
    // route in the API.
    const grant = await loadGrantedPage(Page, pageId, user);
    if ('error' in grant) {
      return finish('not-granted', c.json(grant.error.body, grant.error.status), pageId);
    }

    // Same rationale as the mint route's own normalization
    // (`handlers/artifact.ts`): `pageId` and this are the same string today
    // (both gated lowercase by `isValidObjectId`), but every log call from
    // here on uses the loaded document's own id so a future change to that
    // gate can't silently mismatch them.
    const normalizedPageId = grant.page._id.toString();

    const currentRevision = grant.page.revision as unknown as RevisionDocument | undefined;
    const resolved = await resolveTargetRevision(Revision, revisionQuery, currentRevision, normalizedPageId);
    if (!resolved.ok) {
      if (resolved.reason === 'invalid-id') return finish('invalid-revision', c.json(INVALID_REVISION_ID_BODY, 400), normalizedPageId);
      if (resolved.reason === 'not-found') return finish('revision-mismatch', c.json(PAGE_NOT_FOUND_BODY, 404), normalizedPageId, revisionQuery);
      return finish('pointerless', c.json(PAGE_NOT_FOUND_BODY, 404), normalizedPageId);
    }
    const targetRevision = resolved.revision;

    // Markdown page download is not this route's job — collapse into the
    // same not-found response rather than a distinct diagnostic (unlike the
    // mint route's 400 NOT_AN_ARTIFACT: this route has no JSON error
    // envelope of its own to carry a reason in).
    if (targetRevision.contentType !== 'artifact') {
      return finish('not-artifact', c.json(PAGE_NOT_FOUND_BODY, 404), normalizedPageId, targetRevision._id.toString());
    }

    const filename = artifactDownloadFilename(grant.page.path);
    return finish(
      'ok',
      new Response(targetRevision.body, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeRfc8187(filename)}`,
          'Content-Length': String(Buffer.byteLength(targetRevision.body, 'utf8')),
        },
      }),
      normalizedPageId,
      targetRevision._id.toString(),
    );
  });

  return app;
};
