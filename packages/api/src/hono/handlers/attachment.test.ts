import fs from 'node:fs';
import path from 'node:path';
import { Types } from 'mongoose';
import { app, crowi } from 'src/test/setup';
import { bearerAuthHeaders as authHeaders, createPageViaApi, createTestUser, createWideJpeg } from 'src/test/test-helpers';
import * as imageDisplayDerivative from 'src/util/image-display-derivative';
import request from 'supertest';

const cleanupPathPrefix = async (prefix: string) => {
  const Page = crowi.model('Page');
  const Revision = crowi.model('Revision');
  const Attachment = crowi.model('Attachment');
  const filter = { path: { $regex: `^${prefix}` } };
  const pages = await Page.find(filter).select('_id').lean();
  const pageIds = pages.map((p: { _id: Types.ObjectId }) => p._id);
  await Promise.all([Page.deleteMany(filter), Revision.deleteMany(filter), Attachment.deleteMany({ page: { $in: pageIds } })]);
};

describe('Routes /api/v2 attachments (Hono)', () => {
  const PATH_PREFIX = '/hono-attachment-test/';
  let accessToken: string;
  let otherAccessToken: string;
  let adminAccessToken: string;
  let userId: string;

  // A 1x1 transparent PNG (decoded from base64). Small enough to ship inline
  // and recognisable as a valid image by anything that only sniffs the magic
  // header.
  const pngBuffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=', 'base64');

  beforeAll(async () => {
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

  describe('GET /api/v2/pages/:pageId/attachments (list)', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/v2/pages/000000000000000000000000/attachments');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 400 when pageId is malformed', async () => {
      const res = await request(app).get('/api/v2/pages/not-an-objectid/attachments').set(authHeaders(accessToken));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PAGE_ID');
    });

    it('returns 404 when the user has no grant on the page', async () => {
      const ownerCreate = await createPageViaApi(accessToken, `${PATH_PREFIX}private-list`, '# secret', 4 /* GRANT_OWNER */);
      const res = await request(app).get(`/api/v2/pages/${ownerCreate._id}/attachments`).set(authHeaders(otherAccessToken));
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
    });

    it('returns an empty list for a public page with no attachments', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}empty-list`, '# nope');
      const res = await request(app).get(`/api/v2/pages/${page._id}/attachments`).set(authHeaders(accessToken));
      expect(res.status).toBe(200);
      expect(res.body.attachments).toEqual([]);
    });
  });

  describe('GET /api/v2/pages/:pageId/attachments — inUse detection (Phase 7)', () => {
    /** Upload a PNG to a page and return its attachment id. */
    const uploadTo = async (pageId: string) => {
      const res = await request(app)
        .post(`/api/v2/pages/${pageId}/attachments`)
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
      const res = await request(app).get(`/api/v2/pages/${pageId}/attachments`).set(authHeaders(accessToken));
      expect(res.status).toBe(200);
      return res.body.attachments as Array<{ _id: string; inUse: boolean }>;
    };

    it('marks an attachment inUse when the latest revision body references its /api/v2/attachments/<id> URI', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}inuse-new-uri`, '# placeholder');
      const id = await uploadTo(page._id);
      await setBody(page._id, `# doc\n\n![pixel](/api/v2/attachments/${id})\n`);

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
        .post(`/api/v2/pages/${page._id}/attachments`)
        .set(authHeaders(accessToken))
        .attach('file', pngBuffer, { filename: 'pixel.png', contentType: 'image/png' });
      expect(res.status).toBe(200);
      expect(res.body.attachment.inUse).toBe(false);
    });
  });

  describe('GET /api/v2/pages/:pageId/attachments/usage (Phase 8)', () => {
    /** Upload a PNG to a page and return its attachment id. */
    const uploadTo = async (pageId: string) => {
      const res = await request(app)
        .post(`/api/v2/pages/${pageId}/attachments`)
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
      const res = await request(app).get(`/api/v2/pages/${pageId}/attachments/usage`).set(authHeaders(accessToken));
      expect(res.status).toBe(200);
      return res.body as {
        pagePath: string;
        latest: Array<{ _id: string }>;
        past: Array<{ attachment: { _id: string }; referencingRevisions: Array<{ revisionId: string; createdAt: string }> }>;
      };
    };

    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/v2/pages/000000000000000000000000/attachments/usage');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 400 when pageId is malformed', async () => {
      const res = await request(app).get('/api/v2/pages/not-an-objectid/attachments/usage').set(authHeaders(accessToken));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PAGE_ID');
    });

    it('returns 404 when the user has no grant on the page', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}usage-private`, '# secret', 4 /* GRANT_OWNER */);
      const res = await request(app).get(`/api/v2/pages/${page._id}/attachments/usage`).set(authHeaders(otherAccessToken));
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

  describe('POST /api/v2/pages/:pageId/attachments (add)', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app)
        .post('/api/v2/pages/000000000000000000000000/attachments')
        .attach('file', pngBuffer, { filename: 'pixel.png', contentType: 'image/png' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 400 when no file is provided', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}no-file`, '# x');
      const res = await request(app).post(`/api/v2/pages/${page._id}/attachments`).set(authHeaders(accessToken));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('FILE_MISSING');
    });

    it('returns 404 when the page does not exist', async () => {
      const res = await request(app)
        .post('/api/v2/pages/000000000000000000000000/attachments')
        .set(authHeaders(accessToken))
        .attach('file', pngBuffer, { filename: 'pixel.png', contentType: 'image/png' });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAGE_NOT_FOUND');
    });

    it('uploads a file and returns the populated attachment', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}upload`, '# add');

      const res = await request(app)
        .post(`/api/v2/pages/${page._id}/attachments`)
        .set(authHeaders(accessToken))
        .attach('file', pngBuffer, { filename: 'pixel.png', contentType: 'image/png' });

      expect(res.status).toBe(200);
      expect(res.body.attachment).toBeDefined();
      expect(res.body.attachment._id).toBeDefined();
      expect(res.body.attachment.page).toBe(page._id);
      expect(res.body.attachment.fileFormat).toBe('image/png');
      expect(res.body.attachment.originalName).toBe('pixel.png');
      expect(res.body.attachment.creator._id).toBe(userId);
      expect(res.body.attachment.url).toBe(`/api/v2/attachments/${res.body.attachment._id}`);
      expect(res.body.url).toBe(res.body.attachment.url);

      // The Attachment row exists in the DB.
      const Attachment = crowi.model('Attachment');
      const stored = await Attachment.findById(res.body.attachment._id);
      expect(stored).not.toBeNull();
    });

    describe('feature-image-derivative-optimization Phase 1 — display derivative generation', () => {
      it('calls the shared generator exactly once and persists a resized derivative for a large image', async () => {
        const page = await createPageViaApi(accessToken, `${PATH_PREFIX}derivative-resized`, '# add');
        const wideJpeg = await createWideJpeg();

        const spy = jest.spyOn(imageDisplayDerivative, 'generateDisplayDerivativeForUpload');
        const res = await request(app)
          .post(`/api/v2/pages/${page._id}/attachments`)
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
          .post(`/api/v2/pages/${page._id}/attachments`)
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

  describe('GET /api/v2/attachments/:id (raw stream)', () => {
    // The placeholder image shipped at `packages/api/public/images/file-not-found.png`.
    // `crowi` is not booted at module-eval time, so read it lazily in beforeAll.
    let fileNotFoundImage: Buffer;

    beforeAll(() => {
      fileNotFoundImage = fs.readFileSync(path.resolve(crowi.publicDir, 'images', 'file-not-found.png'));
    });

    // Buffer the raw response bytes so placeholder/image assertions can compare
    // the streamed body directly.
    const bufferParser = (response: NodeJS.ReadableStream, callback: (err: Error | null, body: Buffer) => void) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => callback(null, Buffer.concat(chunks)));
      response.on('error', (err) => callback(err, Buffer.alloc(0)));
    };

    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/v2/attachments/000000000000000000000000');
      expect(res.status).toBe(401);
    });

    it('serves the file-not-found placeholder for a non-existent attachment record', async () => {
      const res = await request(app).get('/api/v2/attachments/000000000000000000000000').set(authHeaders(accessToken)).buffer(true).parse(bufferParser);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      const received = res.body as Buffer;
      expect(Buffer.isBuffer(received)).toBe(true);
      expect(received.equals(fileNotFoundImage)).toBe(true);
    });

    it('serves the placeholder when the backing file is missing (local ENOENT)', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}enoent`, '# e');
      const upload = await request(app)
        .post(`/api/v2/pages/${page._id}/attachments`)
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

      const res = await request(app).get(`/api/v2/attachments/${id}`).set(authHeaders(accessToken)).buffer(true).parse(bufferParser);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      const received = res.body as Buffer;
      expect(received.equals(fileNotFoundImage)).toBe(true);
    });

    it('serves the placeholder when the storage driver throws a NoSuchKey error (S3)', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}nosuchkey`, '# s3');
      const upload = await request(app)
        .post(`/api/v2/pages/${page._id}/attachments`)
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
        const res = await request(app).get(`/api/v2/attachments/${id}`).set(authHeaders(accessToken)).buffer(true).parse(bufferParser);

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
        .post(`/api/v2/pages/${page._id}/attachments`)
        .set(authHeaders(accessToken))
        .attach('file', pngBuffer, { filename: 'pixel.png', contentType: 'image/png' });
      expect(upload.status).toBe(200);
      const id = upload.body.attachment._id;

      const res = await request(app).get(`/api/v2/attachments/${id}`).set(authHeaders(otherAccessToken));
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('ATTACHMENT_NOT_FOUND');
    });

    it('streams the uploaded bytes back', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}stream`, '# st');
      const upload = await request(app)
        .post(`/api/v2/pages/${page._id}/attachments`)
        .set(authHeaders(accessToken))
        .attach('file', pngBuffer, { filename: 'pixel.png', contentType: 'image/png' });
      expect(upload.status).toBe(200);

      const id = upload.body.attachment._id;
      const res = await request(app)
        .get(`/api/v2/attachments/${id}`)
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
  });

  describe('GET /api/v2/attachments/by-key/:key (raw stream)', () => {
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
      const res = await request(app).get('/api/v2/attachments/by-key/user/anything.png');
      expect(res.status).toBe(401);
    });

    it('returns 403 for keys outside the user/ prefix (e.g. attachment/...)', async () => {
      const res = await request(app).get('/api/v2/attachments/by-key/attachment/abc/foo.png').set(authHeaders(accessToken));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_FOR_DELETE');
    });

    it('streams a profile picture for the user/ prefix', async () => {
      const userKey = `user/${userId}-test-${Date.now()}.png`;
      await seedKey(userKey, pngBuffer);

      const res = await request(app)
        .get(`/api/v2/attachments/by-key/${encodeURIComponent(userKey)}`)
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
        .get(`/api/v2/attachments/by-key/${encodeURIComponent('user/missing-' + Date.now() + '.png')}`)
        .set(authHeaders(accessToken));
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('ATTACHMENT_NOT_FOUND');
    });
  });

  describe('GET /api/v2/attachments/:id/meta (single attachment metadata)', () => {
    /** Upload a PNG to a page and return its attachment id. */
    const uploadTo = async (pageId: string) => {
      const res = await request(app)
        .post(`/api/v2/pages/${pageId}/attachments`)
        .set(authHeaders(accessToken))
        .attach('file', pngBuffer, { filename: 'pixel.png', contentType: 'image/png' });
      expect(res.status).toBe(200);
      return res.body.attachment._id as string;
    };

    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/v2/attachments/000000000000000000000000/meta');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 400 for a malformed id', async () => {
      const res = await request(app).get('/api/v2/attachments/not-an-objectid/meta').set(authHeaders(accessToken));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_ATTACHMENT_ID');
    });

    it('returns 404 for a non-existent attachment', async () => {
      const res = await request(app).get('/api/v2/attachments/000000000000000000000000/meta').set(authHeaders(accessToken));
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('ATTACHMENT_NOT_FOUND');
    });

    it('returns 404 (not 403) when the caller lacks grant on the owning page', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}meta-private`, '# secret', 4 /* GRANT_OWNER */);
      const id = await uploadTo(page._id);

      const res = await request(app).get(`/api/v2/attachments/${id}/meta`).set(authHeaders(otherAccessToken));
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('ATTACHMENT_NOT_FOUND');
    });

    it('returns the attachment metadata for a viewer with grant', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}meta-ok`, '# m');
      const id = await uploadTo(page._id);

      const res = await request(app).get(`/api/v2/attachments/${id}/meta`).set(authHeaders(accessToken));
      expect(res.status).toBe(200);
      expect(res.body._id).toBe(id);
      expect(res.body.page).toBe(page._id);
      expect(res.body.fileFormat).toBe('image/png');
      expect(res.body.originalName).toBe('pixel.png');
      expect(res.body.creator._id).toBe(userId);
      expect(res.body.url).toBe(`/api/v2/attachments/${id}`);
      // `inUse` is a page-scoped flag and is intentionally omitted from the
      // meta projection (a bare-id lookup has no page context).
      expect(res.body.inUse).toBeUndefined();
    });
  });

  describe('DELETE /api/v2/attachments/:id (remove)', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).delete('/api/v2/attachments/000000000000000000000000');
      expect(res.status).toBe(401);
    });

    it('returns 400 for malformed ids', async () => {
      const res = await request(app).delete('/api/v2/attachments/not-an-objectid').set(authHeaders(accessToken));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_ATTACHMENT_ID');
    });

    it('returns 404 for non-existent attachments', async () => {
      const res = await request(app).delete('/api/v2/attachments/000000000000000000000000').set(authHeaders(accessToken));
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('ATTACHMENT_NOT_FOUND');
    });

    it('lets the creator delete the attachment (success)', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}delete-creator`, '# d');
      const upload = await request(app)
        .post(`/api/v2/pages/${page._id}/attachments`)
        .set(authHeaders(accessToken))
        .attach('file', pngBuffer, { filename: 'pixel.png', contentType: 'image/png' });
      expect(upload.status).toBe(200);

      const id = upload.body.attachment._id;
      const res = await request(app).delete(`/api/v2/attachments/${id}`).set(authHeaders(accessToken));
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const Attachment = crowi.model('Attachment');
      expect(await Attachment.findById(id)).toBeNull();
    });

    it('lets an admin delete an attachment owned by another user', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}delete-admin`, '# da');
      const upload = await request(app)
        .post(`/api/v2/pages/${page._id}/attachments`)
        .set(authHeaders(accessToken))
        .attach('file', pngBuffer, { filename: 'pixel.png', contentType: 'image/png' });
      expect(upload.status).toBe(200);

      const id = upload.body.attachment._id;
      const res = await request(app).delete(`/api/v2/attachments/${id}`).set(authHeaders(adminAccessToken));
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('lets any authenticated user delete an attachment they did not create (wiki policy)', async () => {
      // Wiki policy: deletion is open to any authenticated user who can view
      // the owning page — not restricted to creator / admin / grantedUsers.
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}delete-anyone`, '# dx');
      const upload = await request(app)
        .post(`/api/v2/pages/${page._id}/attachments`)
        .set(authHeaders(accessToken))
        .attach('file', pngBuffer, { filename: 'pixel.png', contentType: 'image/png' });
      expect(upload.status).toBe(200);

      const id = upload.body.attachment._id;
      const res = await request(app).delete(`/api/v2/attachments/${id}`).set(authHeaders(otherAccessToken));
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const Attachment = crowi.model('Attachment');
      expect(await Attachment.findById(id)).toBeNull();
    });

    it('feature-image-derivative-optimization: returns 500 REMOVE_FAILED when original deletion fails — row-delete-first contract unchanged, and derivative cleanup is still attempted', async () => {
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}delete-original-fails`, '# do');
      const wideJpeg = await createWideJpeg({ r: 1, g: 2, b: 3 });
      const upload = await request(app)
        .post(`/api/v2/pages/${page._id}/attachments`)
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
        const res = await request(app).delete(`/api/v2/attachments/${id}`).set(authHeaders(accessToken));
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

  // RFC-0006 Phase 6 Sub-batch D: `/files/:id` legacy compat redirect was
  // deleted with the Express host. Frontend has been redirecting clients at
  // `/api/v2/attachments/:id` directly since Phase 4 Batch 6; no more cover.
});
