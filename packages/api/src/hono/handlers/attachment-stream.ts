/**
 * RFC-0006 Phase 6 Sub-batch D — Hono port of the raw streaming
 * attachment routes that previously lived on the Express bridge
 * (`packages/api/src/routes/ts-rest/attachment-stream.ts`, now
 * deleted).
 *
 *   GET /attachments/by-key/:key(*)  — public-keyed delivery
 *                                       (profile pictures only)
 *   GET /attachments/:id             — by-id delivery with
 *                                       page grant check +
 *                                       placeholder fallback
 *
 * These endpoints stream `Readable` bytes from the storage driver
 * (local fs / S3) and never buffer the whole file. Hono lets us
 * surface a Node `Readable` as a Web `ReadableStream` via
 * `Readable.toWeb`, which the `@hono/node-server` adaptor then pipes
 * back onto the socket — equivalent posture to the old Express
 * `stream.pipe(res)` codepath, no buffering introduced.
 *
 * Auth: both endpoints install `createJwtAuth(crowi)` directly on the
 * literal paths. They are OUTSIDE the revision-owned `/pages/*`
 * broad apply (which covers list / add / usage), and the
 * `/attachments/*` broad apply in the JSON attachment handler runs
 * AFTER this handler registers — registering jwtAuth on the literal
 * paths here keeps the request-time middleware stack identical.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

import type { OpenAPIHono } from '@hono/zod-openapi';
import Debug from 'debug';

import type Crowi from 'src/crowi';
import type { AttachmentDocument } from 'src/models/attachment';
import FileUploader from 'src/util/file-uploader';
import { isValidObjectId, loadGrantedPage } from 'src/util/ts-rest-helpers';

import type { CrowiHonoBindings } from '../app';
import { createJwtAuth } from '../middleware/auth';

const debug = Debug('crowi:hono:handlers:attachment-stream');

/** Profile-picture key prefix — the only one allowed by `by-key`. */
const BY_KEY_ALLOWED_PREFIX = 'user/';

const KEY_EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
};

const guessMimeFromKey = (key: string): string => {
  const m = key.match(/\.([^.]+)$/);
  if (!m) return 'application/octet-stream';
  return KEY_EXT_TO_MIME[m[1].toLowerCase()] || 'application/octet-stream';
};

type StreamErrorCode = 'FILE_MISSING' | 'FORBIDDEN_FOR_DELETE' | 'ATTACHMENT_NOT_FOUND' | 'INVALID_ATTACHMENT_ID' | 'UPLOAD_FAILED';

const errorBody = (code: StreamErrorCode, message: string) => ({
  error: { code, message },
});

/**
 * Whether a storage-driver `get()` rejection means the object is simply
 * missing (as opposed to a real failure). Local driver throws
 * `code: 'ENOENT'`; the S3 driver surfaces missing as AWS SDK v3
 * `NoSuchKey` (`$metadata.httpStatusCode === 404`, no `code`).
 */
const isMissingFileError = (err: unknown): boolean => {
  const e = err as { code?: string; name?: string; $metadata?: { httpStatusCode?: number } };
  return e.code === 'ENOENT' || e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404;
};

/**
 * Convert a Node `Readable` into a Web `ReadableStream` so Hono's
 * `c.body(...)` can surface it as the response body. `Readable.toWeb`
 * propagates the underlying stream's `'error'` event by erroring the
 * Web stream, which the adaptor surfaces as a chunked-encoding
 * truncation on the wire — identical observable behaviour to the
 * legacy Express `stream.pipe(res)` codepath aborting mid-response.
 */
const toWebStream = (stream: Readable): ReadableStream => {
  return Readable.toWeb(stream) as ReadableStream;
};

export const registerAttachmentStreamRoutes = (app: OpenAPIHono<CrowiHonoBindings>, crowi: Crowi) => {
  const Attachment = crowi.model('Attachment');
  const Page = crowi.model('Page');
  const fileUploader = FileUploader(crowi);

  /** Absolute path to the placeholder image served when an attachment is gone. */
  const FILE_NOT_FOUND_IMAGE = path.join(crowi.publicDir, 'images', 'file-not-found.png');

  /**
   * Stream the `file-not-found.png` placeholder as `200 image/png`.
   * Phase 3 (RFC-0004) — used by `GET /attachments/:id` when the
   * attachment record is missing OR its backing object is gone from
   * storage. We deliberately return `200` (not `404`) so an embedded
   * `<img>` renders the placeholder inline.
   */
  const buildPlaceholderResponse = (): Response => {
    const stream = fs.createReadStream(FILE_NOT_FOUND_IMAGE);
    return new Response(toWebStream(stream), {
      status: 200,
      headers: { 'Content-Type': 'image/png' },
    });
  };

  // Install jwtAuth on both literal paths. `/attachments/*` is OUTSIDE
  // the revision-owned `/pages/*` broad apply, and the JSON attachment
  // handler's broad `/attachments/*` apply runs after this handler
  // registers — we keep the literal install so each route has exactly
  // one jwtAuth invocation regardless of ordering.
  app.use('/attachments/by-key/*', createJwtAuth(crowi));
  app.use('/attachments/:id', createJwtAuth(crowi));

  // --------------------------------------------------------------
  // GET /attachments/by-key/:key(*)
  // --------------------------------------------------------------
  // Hono path params don't natively cover greedy "rest of the URL",
  // so we use `:key{.+}` to capture everything after the prefix.
  app.get('/attachments/by-key/:key{.+}', async (c) => {
    const rawKey = c.req.param('key');
    if (typeof rawKey !== 'string' || rawKey.length === 0) {
      return c.json(errorBody('FILE_MISSING', 'Missing storage key'), 400);
    }

    let key: string;
    try {
      key = decodeURIComponent(rawKey);
    } catch {
      return c.json(errorBody('FILE_MISSING', 'Invalid storage key'), 400);
    }

    if (!key.startsWith(BY_KEY_ALLOWED_PREFIX)) {
      return c.json(errorBody('FORBIDDEN_FOR_DELETE', 'Storage key not permitted by this endpoint'), 403);
    }

    let stream: Readable;
    try {
      stream = await fileUploader.findDeliveryFile(null, key);
    } catch (err) {
      const e = err as { code?: string };
      if (e.code === 'ENOENT') {
        return c.json(errorBody('ATTACHMENT_NOT_FOUND', 'File not found'), 404);
      }
      debug('by-key delivery error', err);
      return c.json(errorBody('UPLOAD_FAILED', 'Failed to deliver file'), 500);
    }

    return new Response(toWebStream(stream), {
      status: 200,
      headers: { 'Content-Type': guessMimeFromKey(key) },
    });
  });

  // --------------------------------------------------------------
  // GET /attachments/:id
  // --------------------------------------------------------------
  // We register a narrower handler on the 24-hex pattern so the
  // `:id` route doesn't intercept `/attachments/upload` /
  // `/attachments/:id/meta` etc. — Hono dispatches by literal-segment
  // priority within the same prefix, and `upload` / `:id/meta` are
  // defined on the same Hono instance via the JSON attachment
  // handler, but matching on `/^[0-9a-f]{24}$/` here makes the
  // boundary explicit.
  app.get('/attachments/:id{[0-9a-fA-F]{24}}', async (c) => {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: { code: 'AUTHENTICATION_REQUIRED', message: 'Authentication is required' } }, 401);
    }

    const id = c.req.param('id');
    if (!isValidObjectId(id)) {
      return c.json(errorBody('INVALID_ATTACHMENT_ID', 'Invalid attachment id'), 400);
    }

    let attachment: AttachmentDocument | null;
    try {
      attachment = (await Attachment.findById(id)) as AttachmentDocument | null;
    } catch (err) {
      debug('attachment lookup error', err);
      return c.json(errorBody('UPLOAD_FAILED', 'Failed to load attachment'), 500);
    }

    if (!attachment) {
      // A missing record means the file was deleted or never existed;
      // serve the placeholder so embedded references render gracefully.
      return buildPlaceholderResponse();
    }

    const grant = await loadGrantedPage(Page, attachment.page.toString(), user);
    if ('error' in grant) {
      // Collapse INVALID_PAGE_ID + PAGE_NOT_FOUND alike to 404 — the
      // page id comes from the persisted attachment, so an
      // INVALID_PAGE_ID would only mean the document is corrupt.
      return c.json(errorBody('ATTACHMENT_NOT_FOUND', 'Attachment not found'), 404);
    }

    let stream: Readable;
    try {
      stream = await Attachment.findDeliveryFile(attachment);
    } catch (err) {
      // The record exists but the backing object is gone from storage
      // (local `ENOENT` / S3 `NoSuchKey`). Serve the placeholder so
      // embedded references render gracefully. Any other driver error
      // is a genuine failure → 500.
      if (isMissingFileError(err)) {
        return buildPlaceholderResponse();
      }
      debug('attachment delivery error', err);
      return c.json(errorBody('UPLOAD_FAILED', 'Failed to deliver file'), 500);
    }

    return new Response(toWebStream(stream), {
      status: 200,
      headers: {
        'Content-Type': attachment.fileFormat,
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(attachment.originalName || attachment.fileName)}`,
      },
    });
  });

  // --------------------------------------------------------------
  // GET /files/:id  →  302 /api/v2/attachments/:id
  // --------------------------------------------------------------
  // feature-migration-files-url-rewrite §3 — runtime safety net for v1
  // `/files/<id>` references the `files-url-to-attachments` body migration
  // hasn't (or can't) rewrite: migration misses, un-migrated bodies, and
  // bare relative `/files/<id>` requests that the web app forwards here via
  // `next.config.ts`'s `/files/:id` rewrite. The legacy `/files/:id` compat
  // redirect was removed with the Express host (RFC-0006 Phase 6 Sub-batch
  // D); this restores it on Hono. NOTE the path is OUTSIDE the `/api/v2`
  // prefix (the prefix stripper in `path-rewrite.ts` only touches
  // `/api/v2/*`), so the registered literal `/files/:id` is reachable at the
  // server root, matching the next.config rewrite target.
  //
  // No auth is installed on this literal (it is OUTSIDE every broad
  // jwtAuth apply — `/pages/*`, `/attachments/*` — so none catches it).
  // The redirect just emits a 302 to `/api/v2/attachments/:id`, whose
  // own handler enforces JWT + the page grant; authorization is deferred to
  // the redirect target. The 24-hex constraint keeps this disjoint from any
  // other `/files/...` shape (there is none) and rejects malformed ids.
  app.get('/files/:id{[0-9a-fA-F]{24}}', (c) => {
    return c.redirect(`/api/v2/attachments/${c.req.param('id')}`, 302);
  });

  return app;
};
