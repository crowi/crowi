import { Types } from 'mongoose';
import { app, crowi } from 'src/test/setup';
import { bearerAuthHeaders as authHeaders, createPageViaApi, createTestUser, createWideJpeg, unsizedStream } from 'src/test/test-helpers';
import * as imageDisplayDerivative from 'src/util/image-display-derivative';
import { UPLOAD_MAX_BYTES_DEFAULT } from 'src/util/upload-limit';
import request from 'supertest';

/**
 * RFC-0004 Phase 6 — `POST /api/attachments/upload`.
 *
 * Covers the editor paste / drag-and-drop upload endpoint: the success
 * (200) shape, the size / MIME / permission 4xx errors with the RFC's
 * lowercase `{ error, message, details? }` envelope, and the 20 req/min
 * per-user rate limit (429 + `Retry-After`).
 *
 * `intent` (`paste` / `dnd`) is still sent by some tests below as a
 * value-neutral field (an older client may still send it; the server
 * ignores it), but no longer selects a different size cap or MIME policy
 * — see the "unified size limit" `describe` block.
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
    expect(res.body.url).toMatch(/^\/api\/attachments\//);

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

  describe('unified MIME policy', () => {
    it('accepts a PDF document', async () => {
      const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}dnd-pdf`, '# upload target');
      const res = await request(app)
        .post('/api/attachments/upload')
        .set(authHeaders(ownerToken))
        .field('pageId', page._id)
        .attach('file', Buffer.from('%PDF-1.4 minimal'), { filename: 'spec.pdf', contentType: 'application/pdf' });
      expect(res.status).toBe(200);
      expect(res.body.mimeType).toBe('application/pdf');
    });

    it('accepts a zip archive', async () => {
      const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}dnd-zip`, '# upload target');
      const res = await request(app)
        .post('/api/attachments/upload')
        .set(authHeaders(ownerToken))
        .field('pageId', page._id)
        .attach('file', Buffer.from('PK archive'), { filename: 'bundle.zip', contentType: 'application/zip' });
      expect(res.status).toBe(200);
    });

    it('accepts a PDF for the paste intent too — paste and dnd share the same MIME allow-list', async () => {
      const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}paste-pdf`, '# upload target');
      const res = await request(app)
        .post('/api/attachments/upload')
        .set(authHeaders(ownerToken))
        .field('pageId', page._id)
        .field('intent', 'paste')
        .attach('file', Buffer.from('%PDF-1.4 minimal'), { filename: 'spec.pdf', contentType: 'application/pdf' });
      expect(res.status).toBe(200);
      expect(res.body.mimeType).toBe('application/pdf');
    });

    it('accepts a non-image document for the paste intent in general (e.g. a .docx)', async () => {
      const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}paste-docx`, '# upload target');
      const res = await request(app)
        .post('/api/attachments/upload')
        .set(authHeaders(ownerToken))
        .field('pageId', page._id)
        .field('intent', 'paste')
        .attach('file', Buffer.from('PK stub docx bytes'), {
          filename: 'report.docx',
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        });
      expect(res.status).toBe(200);
      expect(res.body.mimeType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    });
  });

  describe('unified size limit — one 50 MB cap, independent of intent', () => {
    it('AC-6: an intent=paste upload above the OLD 10 MB paste cap succeeds, as long as it is under the unified 50 MB limit', async () => {
      const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}paste-mid`, '# upload target');
      const overOldPasteCap = Buffer.alloc(10 * 1024 * 1024 + 1, 0);
      const res = await request(app)
        .post('/api/attachments/upload')
        .set(authHeaders(ownerToken))
        .field('pageId', page._id)
        .field('intent', 'paste')
        .attach('file', overOldPasteCap, { filename: 'mid.png', contentType: 'image/png' });
      expect(res.status).toBe(200);
    });

    it.each([
      'paste',
      'dnd',
      undefined,
    ] as const)('AC-1/AC-6: rejects a file above the unified 50 MB limit with the same 413/too_large regardless of intent (intent=%s)', async (intent) => {
      const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}toolarge-${intent ?? 'none'}`, '# upload target');
      const oversize = Buffer.alloc(UPLOAD_MAX_BYTES_DEFAULT + 1, 0);
      let req = request(app).post('/api/attachments/upload').set(authHeaders(ownerToken)).field('pageId', page._id);
      if (intent) req = req.field('intent', intent);
      const res = await req.attach('file', oversize, { filename: 'huge.bin', contentType: 'application/octet-stream' });
      expect(res.status).toBe(413);
      expect(res.body.error).toBe('too_large');
      expect(res.body.details?.maxBytes).toBe(UPLOAD_MAX_BYTES_DEFAULT);
    });

    it('AC-6: a bogus/unknown intent value no longer 400s — it is simply ignored', async () => {
      const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}bogus-intent`, '# upload target');
      const res = await request(app)
        .post('/api/attachments/upload')
        .set(authHeaders(ownerToken))
        .field('pageId', page._id)
        .field('intent', 'bogus')
        .attach('file', pngBuffer, { filename: 'pasted.png', contentType: 'image/png' });
      expect(res.status).toBe(200);
    });

    it('AC-1/AC-7: a request with NO Content-Length header (chunked transfer) is rejected by the precheck itself, not merely by the post-parse check', async () => {
      const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}chunked-toolarge`, '# upload target');
      // The precheck rejects on the ABSENCE of `Content-Length` alone — it
      // never reads the body — so a small stream proves the same thing a
      // huge one would, without racing the server's early 413 against a
      // still-streaming multi-megabyte client write (which flakes with
      // EPIPE/ECONNRESET on some platforms).
      const res = await request(app)
        .post('/api/attachments/upload')
        .set(authHeaders(ownerToken))
        .field('pageId', page._id)
        .attach('file', unsizedStream(1024), { filename: 'small.bin', contentType: 'application/octet-stream' });
      expect(res.status).toBe(413);
      expect(res.body.error).toBe('too_large');
    });

    it('AC-7: a file just over the limit but within the multipart-framing allowance passes the precheck, then the post-parse check still rejects it', async () => {
      const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}post-parse-toolarge`, '# upload target');
      const res = await request(app)
        .post('/api/attachments/upload')
        .set(authHeaders(ownerToken))
        .field('pageId', page._id)
        .attach('file', Buffer.alloc(UPLOAD_MAX_BYTES_DEFAULT + 1024, 0), { filename: 'just-over.bin', contentType: 'application/octet-stream' });
      expect(res.status).toBe(413);
      expect(res.body.error).toBe('too_large');
    });
  });

  describe('feature-attachment-mime-fallback — server-side extension fallback for an undeclared MIME', () => {
    // Dedicated user + token, same reasoning as the "cross-route upload
    // policy parity" block below: these hits must not compete with the
    // 20/min budget the tests above and below already spend against
    // `ownerToken`.
    let fallbackToken: string;

    beforeAll(async () => {
      const fallbackUser = await createTestUser({ name: 'Upload Fallback', username: 'uplFallback', email: 'upl-fallback@example.com' });
      fallbackToken = fallbackUser.accessToken;
    });

    // AC-2: an `application/octet-stream` (undeclared) pixel.png is
    // backfilled to `image/png` for both the paste and dnd intents.
    it.each(['paste', 'dnd'] as const)('backfills an octet-stream pixel.png to image/png for intent=%s', async (intent) => {
      const page = await createPageViaApi(fallbackToken, `${PATH_PREFIX}mime-fallback-png-${intent}`, '# upload target');
      const res = await request(app)
        .post('/api/attachments/upload')
        .set(authHeaders(fallbackToken))
        .field('pageId', page._id)
        .field('intent', intent)
        .attach('file', pngBuffer, { filename: 'pixel.png', contentType: 'application/octet-stream' });

      expect(res.status).toBe(200);
      expect(res.body.mimeType).toBe('image/png');

      const Attachment = crowi.model('Attachment');
      const id = res.body.url.split('/').pop();
      const stored = await Attachment.findById(id);
      expect(stored?.fileFormat).toBe('image/png');
    });

    // AC-3: an explicit non-octet-stream declaration is never overridden by
    // the filename, even when it contradicts the extension.
    it.each(['paste', 'dnd'] as const)('keeps an explicitly declared image/jpeg for intent=%s even though the filename says .png', async (intent) => {
      const page = await createPageViaApi(fallbackToken, `${PATH_PREFIX}mime-fallback-explicit-${intent}`, '# upload target');
      const res = await request(app)
        .post('/api/attachments/upload')
        .set(authHeaders(fallbackToken))
        .field('pageId', page._id)
        .field('intent', intent)
        .attach('file', pngBuffer, { filename: 'pixel.png', contentType: 'image/jpeg' });

      expect(res.status).toBe(200);
      expect(res.body.mimeType).toBe('image/jpeg');

      const Attachment = crowi.model('Attachment');
      const id = res.body.url.split('/').pop();
      const stored = await Attachment.findById(id);
      expect(stored?.fileFormat).toBe('image/jpeg');
    });

    // AC-4: an unknown extension, and a filename with no extension at all,
    // both stay application/octet-stream.
    it.each(['paste', 'dnd'] as const)('leaves an unknown extension as application/octet-stream for intent=%s', async (intent) => {
      const page = await createPageViaApi(fallbackToken, `${PATH_PREFIX}mime-fallback-unknown-${intent}`, '# upload target');
      const res = await request(app)
        .post('/api/attachments/upload')
        .set(authHeaders(fallbackToken))
        .field('pageId', page._id)
        .field('intent', intent)
        .attach('file', Buffer.from('stub bytes'), { filename: 'archive.xyz', contentType: 'application/octet-stream' });

      expect(res.status).toBe(200);
      expect(res.body.mimeType).toBe('application/octet-stream');

      const Attachment = crowi.model('Attachment');
      const id = res.body.url.split('/').pop();
      const stored = await Attachment.findById(id);
      expect(stored?.fileFormat).toBe('application/octet-stream');
    });

    it.each(['paste', 'dnd'] as const)('leaves an extensionless filename as application/octet-stream for intent=%s', async (intent) => {
      const page = await createPageViaApi(fallbackToken, `${PATH_PREFIX}mime-fallback-noext-${intent}`, '# upload target');
      const res = await request(app)
        .post('/api/attachments/upload')
        .set(authHeaders(fallbackToken))
        .field('pageId', page._id)
        .field('intent', intent)
        .attach('file', Buffer.from('stub bytes'), { filename: 'README', contentType: 'application/octet-stream' });

      expect(res.status).toBe(200);
      expect(res.body.mimeType).toBe('application/octet-stream');

      const Attachment = crowi.model('Attachment');
      const id = res.body.url.split('/').pop();
      const stored = await Attachment.findById(id);
      expect(stored?.fileFormat).toBe('application/octet-stream');
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

  it('returns 415 for a MIME type outside the unified upload allow-list', async () => {
    // `text/plain` used to be paste-only-rejected here (paste accepted images
    // only) — the unified allow-list (feature-attachment-upload-policy) now
    // accepts it for every intent, so this needs a type genuinely outside the
    // allow-list to still exercise the 415 path.
    const page = await createPageViaApi(ownerToken, `${PATH_PREFIX}badtype`, '# upload target');
    const res = await request(app)
      .post('/api/attachments/upload')
      .set(authHeaders(ownerToken))
      .field('pageId', page._id)
      .field('intent', 'paste')
      .attach('file', Buffer.from('MZ stub executable bytes'), { filename: 'virus.exe', contentType: 'application/x-msdownload' });
    expect(res.status).toBe(415);
    // `DISALLOWED_MIME`, not this endpoint's usual lowercase `disallowed_type`
    // — cross-route parity requires the SAME code (and message, asserted
    // below) as `addAttachment`'s 415 for the same reason
    // (feature-attachment-upload-policy).
    expect(res.body.error).toBe('DISALLOWED_MIME');
    expect(res.body.details?.mimeType).toBe('application/x-msdownload');
    expect(res.body.message).toBe('Files of type application/x-msdownload cannot be uploaded.');
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

  // Mirrors the route's own `UPLOAD_RATE_LIMIT` (`attachment.ts`), which is
  // not exported. The window length no longer needs mirroring: freezing the
  // clock keeps every hit in one bucket whatever the window is.
  const UPLOAD_RATE_LIMIT = 20;

  /**
   * Wait until Mongoose reports the connection live again after a frozen
   * `Date.now()` has been restored.
   *
   * Heartbeats that fire while the clock is frozen record the FROZEN value in
   * `_lastHeartbeatAt`. Restoring the clock therefore makes that timestamp look
   * as old as the test was long, and `readyState` — a getter that reports
   * `disconnected` past two heartbeat intervals — flips to 0 on a connection
   * that never actually dropped (measured: 25s of frozen clock produced
   * `readyState` 0 with `_readyState` still 1). Everything after this test then
   * runs against an apparently-dead connection: `afterEach` buffers its
   * deletes, and fixture helpers refuse outright.
   *
   * Wait for a heartbeat recorded on the REAL clock — `_lastHeartbeatAt >
   * pinnedAt` — not merely for a moment when `readyState` reads 1. Those are
   * not the same: if the frozen interval was shorter than the stale threshold,
   * the connection still reads live at the instant the clock is restored, and
   * only goes stale a few seconds later, once real time drags the frozen
   * timestamp past the threshold and before the next heartbeat lands. Waiting
   * on `readyState` alone returns during exactly that grace period and leaves
   * the flake in place, just narrower. Once one real heartbeat is in, the age
   * is measured from real time and can never exceed one interval again.
   *
   * Mongoose copies a successful primary heartbeat onto its `otherDb`
   * connections, so this covers those too.
   */
  // 15s: one heartbeat interval is 10s, so this only has to outlast a single
  // one, and it has to stay well inside the 60s per-test budget
  // (`src/test/setup.ts`) that the burst above has already spent ~25s of.
  const waitForLiveMongoConnection = async (pinnedAt: number, timeoutMs = 15_000): Promise<void> => {
    const conn = crowi.getMongo().connection;
    const deadline = Date.now() + timeoutMs;
    while (!(conn._lastHeartbeatAt != null && conn._lastHeartbeatAt > pinnedAt && conn.readyState === 1)) {
      if (Date.now() > deadline) {
        throw new Error(
          `Mongo connection did not record a real-clock heartbeat within ${timeoutMs}ms of restoring the clock (readyState=${conn.readyState}, _readyState=${conn._readyState}, _lastHeartbeatAt=${conn._lastHeartbeatAt}, pinnedAt=${pinnedAt})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  describe('rate limiting', () => {
    it('returns 429 with Retry-After once the 20/min budget is exceeded', async () => {
      const { accessToken } = await createTestUser({
        name: 'Upload Rate',
        username: 'uplRateUser',
        email: 'upl-rate@example.com',
      });
      const page = await createPageViaApi(accessToken, `${PATH_PREFIX}rate`, '# upload target');

      const upload = (i: number) =>
        request(app)
          .post('/api/attachments/upload')
          .set(authHeaders(accessToken))
          .field('pageId', page._id)
          .field('intent', 'paste')
          .attach('file', pngBuffer, { filename: `pasted-${i}.png`, contentType: 'image/png' });

      // The limiter buckets by `floor(now / windowMs)`, so a burst that
      // crosses a minute boundary is split across two buckets and neither
      // one exceeds the budget — 21 sequential uploads then all return 200
      // and the assertion below reports a limiter that "did not fire".
      // Uploads are slow enough (multipart parse, storage write, derivative
      // generation) for the burst to span a boundary on a loaded runner,
      // which is how this failed on CI. Freezing the clock makes the bucket
      // exact by construction — every hit divides the same value, so they
      // cannot land either side of a boundary.
      //
      // Freeze it at the CURRENT instant, never at a computed point inside
      // the window. Mongoose's `readyState` is a getter that reports
      // `disconnected` when `Date.now() - _lastHeartbeatAt` reaches two
      // heartbeat intervals (20s at the 10s default), so a pinned value in
      // the future makes a perfectly healthy connection look dead — and the
      // fixture helpers refuse to run against readyState 0. Pinning to the
      // window midpoint moved the clock up to 30s ahead depending on where
      // in the minute the test happened to start, which is what made this
      // suite fail nondeterministically on CI.
      //
      // Only `Date.now` is mocked, not the timers, so the HTTP/fs/Mongo work
      // below still runs normally; the upload path's one `Date.now` use is a
      // temp-filename prefix that carries its own random suffix.
      // Read before installing the spy — once `Date.now` is the mock, calling
      // it to seed the mock returns the mock's own default (undefined).
      const pinnedNow = Date.now();
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(pinnedNow);
      let recoveryError: unknown;
      try {
        for (let i = 0; i < UPLOAD_RATE_LIMIT; i += 1) {
          const res = await upload(i);
          expect(res.status).toBe(200);
        }

        const limited = await upload(UPLOAD_RATE_LIMIT);
        expect(limited.status).toBe(429);
        expect(limited.body.error).toBe('rate_limited');
        expect(typeof limited.body.details.retryAfterSeconds).toBe('number');
        expect(limited.headers['retry-after']).toBeDefined();

        // The budget is keyed by user id, not by endpoint — a second user
        // in the SAME (pinned) window still gets their own 20. Without this
        // the assertions above would pass just as happily against a global
        // bucket, i.e. one user's burst throttling everyone.
        const neighbour = await createTestUser({ name: 'Upload Rate Neighbour', username: 'uplRateNeighbour', email: 'upl-rate-neighbour@example.com' });
        const neighbourPage = await createPageViaApi(neighbour.accessToken, `${PATH_PREFIX}rate-neighbour`, '# upload target');
        const unthrottled = await request(app)
          .post('/api/attachments/upload')
          .set(authHeaders(neighbour.accessToken))
          .field('pageId', neighbourPage._id)
          .field('intent', 'paste')
          .attach('file', pngBuffer, { filename: 'neighbour.png', contentType: 'image/png' });
        expect(unthrottled.status).toBe(200);
      } finally {
        nowSpy.mockRestore();
        // Capture rather than throw: a throw from `finally` replaces whatever
        // the body threw, and a failing body is exactly when Mongo is most
        // likely to be the broken thing — that would swap the real regression
        // for a cleanup timeout.
        recoveryError = await waitForLiveMongoConnection(pinnedNow).then(
          () => undefined,
          (error: unknown) => error,
        );
      }
      // Only reachable when the body succeeded; a body failure has already
      // propagated past this point, taking priority as it should.
      if (recoveryError !== undefined) throw recoveryError;
    });
  });

  describe('cross-route upload policy parity (feature-attachment-upload-policy)', () => {
    // Regression coverage for the reported symptom itself: the SAME file
    // type must upload successfully — or be rejected identically — no
    // matter which of the three affordances (attach button / editor paste /
    // editor drag-and-drop) triggered it. Runs on its own dedicated user so
    // these `/api/attachments/upload` hits don't compete with the 20/min
    // budget the tests above already spend against `ownerToken`.
    let parityToken: string;

    beforeAll(async () => {
      const parityUser = await createTestUser({ name: 'Upload Parity', username: 'uplParity', email: 'upl-parity@example.com' });
      parityToken = parityUser.accessToken;
    });

    const uploadVia = (route: 'add' | 'paste' | 'dnd', pageId: string, body: Buffer, filename: string, contentType: string) => {
      if (route === 'add') {
        return request(app).post(`/api/pages/${pageId}/attachments`).set(authHeaders(parityToken)).attach('file', body, { filename, contentType });
      }
      return request(app)
        .post('/api/attachments/upload')
        .set(authHeaders(parityToken))
        .field('pageId', pageId)
        .field('intent', route)
        .attach('file', body, { filename, contentType });
    };

    it.each([
      ['text-html', 'text/html', 'payload.html', Buffer.from('<p>hello</p>')],
      ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'report.docx', Buffer.from('PK stub docx bytes')],
    ] as const)('%s (%s) uploads successfully via the attach button, paste, and drag-and-drop alike — the reported symptom (button ok, dnd rejected) no longer reproduces', async (slug, contentType, filename, body) => {
      const page = await createPageViaApi(parityToken, `${PATH_PREFIX}parity-${slug}`, '# parity');
      for (const route of ['add', 'paste', 'dnd'] as const) {
        const res = await uploadVia(route, page._id, body, filename, contentType);
        expect(res.status).toBe(200);
      }
    });

    it('rejects a disallowed type identically via the attach button, paste, and drag-and-drop, with the same error wording', async () => {
      const page = await createPageViaApi(parityToken, `${PATH_PREFIX}parity-reject`, '# parity-reject');
      const body = Buffer.from('MZ stub executable bytes');
      const filename = 'virus.exe';
      const contentType = 'application/x-msdownload';

      const addRes = await uploadVia('add', page._id, body, filename, contentType);
      const pasteRes = await uploadVia('paste', page._id, body, filename, contentType);
      const dndRes = await uploadVia('dnd', page._id, body, filename, contentType);

      expect(addRes.status).toBe(415);
      expect(pasteRes.status).toBe(415);
      expect(dndRes.status).toBe(415);

      const MESSAGE = 'Files of type application/x-msdownload cannot be uploaded.';
      expect(addRes.body.error.message).toBe(MESSAGE);
      expect(pasteRes.body.message).toBe(MESSAGE);
      expect(dndRes.body.message).toBe(MESSAGE);
    });
  });
});
