import { Types } from 'mongoose';
import { app, crowi } from 'src/test/setup';
import { bearerAuthHeaders as authHeaders, createPageViaApi, createTestUser, createWideJpeg } from 'src/test/test-helpers';
import * as imageDisplayDerivative from 'src/util/image-display-derivative';
import request from 'supertest';

/**
 * RFC-0004 Phase 6 — `POST /api/attachments/upload`.
 *
 * Covers the editor paste / drag-and-drop upload endpoint: the success
 * (200) shape, the size / MIME / permission 4xx errors with the RFC's
 * lowercase `{ error, message, details? }` envelope, and the 20 req/min
 * per-user rate limit (429 + `Retry-After`).
 */

describe('Routes POST /api/attachments/upload (Hono editor upload)', () => {
  const PATH_PREFIX = '/hono-attachment-upload-test/';
  let ownerToken: string;
  let otherToken: string;

  // 1x1 transparent PNG — a valid image small enough to ship inline.
  const pngBuffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=', 'base64');

  beforeAll(async () => {
    const owner = await createTestUser({ name: 'Upload Owner', username: 'uplOwner', email: 'upl-owner@example.com' });
    ownerToken = owner.accessToken;
    const other = await createTestUser({ name: 'Upload Other', username: 'uplOther', email: 'upl-other@example.com' });
    otherToken = other.accessToken;
  });

  afterEach(async () => {
    const Page = crowi.model('Page');
    const Attachment = crowi.model('Attachment');
    const filter = { path: { $regex: `^${PATH_PREFIX}` } };
    const pages = await Page.find(filter).select('_id').lean();
    const pageIds = pages.map((p: { _id: Types.ObjectId }) => p._id);
    await Promise.all([Page.deleteMany(filter), Attachment.deleteMany({ page: { $in: pageIds } })]);
  });

  it('returns 401 without auth', async () => {
    const res = await request(app)
      .post('/api/attachments/upload')
      .field('pageId', '000000000000000000000000')
      .field('intent', 'paste')
      .attach('file', pngBuffer, { filename: 'pasted-1.png', contentType: 'image/png' });
    expect(res.status).toBe(401);
  });

  it('uploads a pasted image and returns { url, filename, mimeType, sizeBytes }', async () => {
    const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}ok`, '# upload target');
    const res = await request(app)
      .post('/api/attachments/upload')
      .set(authHeaders(ownerToken))
      .field('pageId', page._id)
      .field('intent', 'paste')
      .attach('file', pngBuffer, { filename: 'pasted-1717891234.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body.filename).toBe('pasted-1717891234.png');
    expect(res.body.mimeType).toBe('image/png');
    expect(res.body.sizeBytes).toBe(pngBuffer.length);
    expect(typeof res.body.url).toBe('string');
    expect(res.body.url).toMatch(/^\/api\/v2\/attachments\//);

    // The Attachment row was persisted.
    const Attachment = crowi.model('Attachment');
    const id = res.body.url.split('/').pop();
    expect(await Attachment.findById(id)).not.toBeNull();
  });

  it('accepts the dnd intent as well', async () => {
    const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}dnd`, '# upload target');
    const res = await request(app)
      .post('/api/attachments/upload')
      .set(authHeaders(ownerToken))
      .field('pageId', page._id)
      .field('intent', 'dnd')
      .attach('file', pngBuffer, { filename: 'dropped.png', contentType: 'image/png' });
    expect(res.status).toBe(200);
  });

  describe('feature-image-derivative-optimization Phase 1 — display derivative generation', () => {
    it('calls the shared generator exactly once and persists a resized derivative for a large pasted image', async () => {
      const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}derivative-resized`, '# upload target');
      const wideJpeg = await createWideJpeg();

      const spy = jest.spyOn(imageDisplayDerivative, 'generateDisplayDerivativeForUpload');
      const res = await request(app)
        .post('/api/attachments/upload')
        .set(authHeaders(ownerToken))
        .field('pageId', page._id)
        .field('intent', 'dnd')
        .attach('file', wideJpeg, { filename: 'wide.jpg', contentType: 'image/jpeg' });

      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);

      const Attachment = crowi.model('Attachment');
      const id = res.body.url.split('/').pop();
      const stored = await Attachment.findById(id);
      expect(stored?.derivatives?.display?.mode).toBe('resized');
      expect(stored?.derivatives?.display?.format).toBe('image/jpeg');
    });

    it('still returns 200 (original-only) when derivative generation fails — the upload response is never blocked by a generation failure', async () => {
      const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}derivative-failed`, '# upload target');
      // Claimed `image/png` but not a decodable image — the generator
      // re-validates via sharp rather than trusting the claimed MIME.
      const garbage = Buffer.from('this is not a real png, just garbage bytes for the upload test');

      const res = await request(app)
        .post('/api/attachments/upload')
        .set(authHeaders(ownerToken))
        .field('pageId', page._id)
        .field('intent', 'paste')
        .attach('file', garbage, { filename: 'not-a-png.png', contentType: 'image/png' });

      expect(res.status).toBe(200);
      expect(typeof res.body.url).toBe('string');

      const Attachment = crowi.model('Attachment');
      const id = res.body.url.split('/').pop();
      const stored = await Attachment.findById(id);
      expect(stored?.derivatives?.display?.mode).toBe('failed');
      expect(stored?.derivatives?.display?.reason).toBe('decode-error');
    });
  });

  describe('intent-aware MIME / size limits (RFC-0004 Phase 7)', () => {
    it('accepts a PDF document for the dnd intent', async () => {
      const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}dnd-pdf`, '# upload target');
      const res = await request(app)
        .post('/api/attachments/upload')
        .set(authHeaders(ownerToken))
        .field('pageId', page._id)
        .field('intent', 'dnd')
        .attach('file', Buffer.from('%PDF-1.4 minimal'), { filename: 'spec.pdf', contentType: 'application/pdf' });
      expect(res.status).toBe(200);
      expect(res.body.mimeType).toBe('application/pdf');
    });

    it('accepts a zip archive for the dnd intent', async () => {
      const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}dnd-zip`, '# upload target');
      const res = await request(app)
        .post('/api/attachments/upload')
        .set(authHeaders(ownerToken))
        .field('pageId', page._id)
        .field('intent', 'dnd')
        .attach('file', Buffer.from('PK archive'), { filename: 'bundle.zip', contentType: 'application/zip' });
      expect(res.status).toBe(200);
    });

    it('rejects a PDF for the paste intent — paste is images only', async () => {
      const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}paste-pdf`, '# upload target');
      const res = await request(app)
        .post('/api/attachments/upload')
        .set(authHeaders(ownerToken))
        .field('pageId', page._id)
        .field('intent', 'paste')
        .attach('file', Buffer.from('%PDF-1.4 minimal'), { filename: 'spec.pdf', contentType: 'application/pdf' });
      expect(res.status).toBe(415);
      expect(res.body.error).toBe('disallowed_type');
      expect(res.body.details?.mimeType).toBe('application/pdf');
    });

    it('rejects a paste image above the 10 MB paste cap (under the 50 MB dnd cap)', async () => {
      const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}paste-big`, '# upload target');
      // 10 MB + 1 byte: passes the 50 MB multer cap, fails the in-handler
      // paste cap.
      const overPaste = Buffer.alloc(10 * 1024 * 1024 + 1, 0);
      const res = await request(app)
        .post('/api/attachments/upload')
        .set(authHeaders(ownerToken))
        .field('pageId', page._id)
        .field('intent', 'paste')
        .attach('file', overPaste, { filename: 'huge.png', contentType: 'image/png' });
      expect(res.status).toBe(413);
      expect(res.body.error).toBe('too_large');
      expect(res.body.details?.maxBytes).toBe(10 * 1024 * 1024);
    });

    it('accepts the same 10 MB+ image for the dnd intent (within the 50 MB cap)', async () => {
      const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}dnd-mid`, '# upload target');
      const overPaste = Buffer.alloc(10 * 1024 * 1024 + 1, 0);
      const res = await request(app)
        .post('/api/attachments/upload')
        .set(authHeaders(ownerToken))
        .field('pageId', page._id)
        .field('intent', 'dnd')
        .attach('file', overPaste, { filename: 'mid.png', contentType: 'image/png' });
      expect(res.status).toBe(200);
    });

    it('rejects a dnd file above the 50 MB cap', async () => {
      const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}dnd-toolarge`, '# upload target');
      // 50 MB + 1 byte — multer rejects during the multipart parse.
      const oversize = Buffer.alloc(50 * 1024 * 1024 + 1, 0);
      const res = await request(app)
        .post('/api/attachments/upload')
        .set(authHeaders(ownerToken))
        .field('pageId', page._id)
        .field('intent', 'dnd')
        .attach('file', oversize, { filename: 'huge.zip', contentType: 'application/zip' });
      expect(res.status).toBe(413);
      expect(res.body.error).toBe('too_large');
    });
  });

  it('returns 400 when the pageId is missing or malformed', async () => {
    const res = await request(app)
      .post('/api/attachments/upload')
      .set(authHeaders(ownerToken))
      .field('pageId', 'not-an-objectid')
      .field('intent', 'paste')
      .attach('file', pngBuffer, { filename: 'pasted.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('no_permission');
  });

  it('returns 400 when intent is not paste/dnd', async () => {
    const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}badintent`, '# upload target');
    const res = await request(app)
      .post('/api/attachments/upload')
      .set(authHeaders(ownerToken))
      .field('pageId', page._id)
      .field('intent', 'bogus')
      .attach('file', pngBuffer, { filename: 'pasted.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('disallowed_type');
  });

  it('returns 415 for a disallowed MIME type', async () => {
    const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}badtype`, '# upload target');
    const res = await request(app)
      .post('/api/attachments/upload')
      .set(authHeaders(ownerToken))
      .field('pageId', page._id)
      .field('intent', 'paste')
      .attach('file', Buffer.from('plain text body'), { filename: 'notes.txt', contentType: 'text/plain' });
    expect(res.status).toBe(415);
    expect(res.body.error).toBe('disallowed_type');
    expect(res.body.details?.mimeType).toBe('text/plain');
  });

  it('returns 413 when the file exceeds the 10 MB cap', async () => {
    const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}toolarge`, '# upload target');
    // 10 MB + 1 byte of zeros; multer rejects during the multipart parse.
    const oversize = Buffer.alloc(10 * 1024 * 1024 + 1, 0);
    const res = await request(app)
      .post('/api/attachments/upload')
      .set(authHeaders(ownerToken))
      .field('pageId', page._id)
      .field('intent', 'paste')
      .attach('file', oversize, { filename: 'huge.png', contentType: 'image/png' });
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('too_large');
    expect(res.body.details?.maxBytes).toBe(10 * 1024 * 1024);
  });

  it('returns 403 when the caller cannot view the target page', async () => {
    // Owner-granted page: the owner can attach, `other` cannot even see it.
    const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}private`, '# upload target', 4 /* GRANT_OWNER */);
    const res = await request(app)
      .post('/api/attachments/upload')
      .set(authHeaders(otherToken))
      .field('pageId', page._id)
      .field('intent', 'paste')
      .attach('file', pngBuffer, { filename: 'pasted.png', contentType: 'image/png' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('no_permission');
  });

  describe('rate limiting', () => {
    it('returns 429 with Retry-After once the 20/min budget is exceeded', async () => {
      const { accessToken } = await createTestUser({
        name: 'Upload Rate',
        username: 'uplRateUser',
        email: 'upl-rate@example.com',
      });
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}rate`, '# upload target');

      let sawRateLimit = false;
      // 21 hits exceeds the 20-req window.
      for (let i = 0; i < 21; i += 1) {
        const res = await request(app)
          .post('/api/attachments/upload')
          .set(authHeaders(accessToken))
          .field('pageId', page._id)
          .field('intent', 'paste')
          .attach('file', pngBuffer, { filename: `pasted-${i}.png`, contentType: 'image/png' });
        if (res.status === 429) {
          sawRateLimit = true;
          expect(res.body.error).toBe('rate_limited');
          expect(typeof res.body.details.retryAfterSeconds).toBe('number');
          expect(res.headers['retry-after']).toBeDefined();
          break;
        }
        expect(res.status).toBe(200);
      }
      expect(sawRateLimit).toBe(true);
    });
  });
});
