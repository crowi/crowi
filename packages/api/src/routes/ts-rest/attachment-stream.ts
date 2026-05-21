/**
 * RFC-0006 Phase 4 Batch 6 — raw streaming attachment routes kept on
 * Express until Phase 6 cleanup.
 *
 * The JSON-shaped attachment endpoints (list / add / usage / meta /
 * upload / remove) moved to Hono in this batch (see
 * `packages/api/src/hono/handlers/attachment.ts`). The two raw routes
 * below stay on Express because they pipe `Readable` bytes and Hono's
 * typed-response API would force a Buffer roundtrip that defeats the
 * streaming. Phase 6 converts them to native Hono `Response`-stream
 * handlers and the file goes away.
 *
 *   GET /api/v2/attachments/by-key/:key(*)  — public-keyed delivery
 *                                              (profile pictures only)
 *   GET /api/v2/attachments/:id             — by-id delivery with
 *                                              page grant check +
 *                                              placeholder fallback
 *
 * Auth is provided by the parent `authenticatedRouter` (`jwtAuth`);
 * `req.user` is a `UserDocument` on entry.
 */
import { Express, Request, Response, Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import Debug from 'debug';

import Crowi from 'src/crowi';
import { AttachmentDocument } from 'src/models/attachment';
import { UserDocument } from 'src/models/user';
import FileUploader from 'src/util/fileUploader';
import { isValidObjectId, loadGrantedPage } from 'src/util/ts-rest-helpers';

const debug = Debug('crowi:routes:ts-rest:attachment-stream');

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

const errorBody = (code: 'FILE_MISSING' | 'FORBIDDEN_FOR_DELETE' | 'ATTACHMENT_NOT_FOUND' | 'INVALID_ATTACHMENT_ID' | 'UPLOAD_FAILED', message: string) => ({
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

export default (crowi: Crowi, _app: Express) => {
  const router = Router();
  const Attachment = crowi.model('Attachment');
  const Page = crowi.model('Page');
  const fileUploader = FileUploader(crowi);

  /** Absolute path to the placeholder image served when an attachment is gone. */
  const FILE_NOT_FOUND_IMAGE = path.join(crowi.publicDir, 'images', 'file-not-found.png');

  /**
   * Stream the `file-not-found.png` placeholder as `200 image/png`.
   * Phase 3 (RFC-0004) — used by `GET /api/v2/attachments/:id` when the
   * attachment record is missing OR its backing object is gone from
   * storage. We deliberately return `200` (not `404`) so an embedded
   * `<img>` renders the placeholder inline.
   */
  const servePlaceholder = (res: Response) => {
    const stream = fs.createReadStream(FILE_NOT_FOUND_IMAGE);
    stream.on('error', (err) => {
      debug('placeholder stream error', err);
      if (!res.headersSent) {
        res.status(500).end();
      } else {
        res.end();
      }
    });
    res.status(200).setHeader('Content-Type', 'image/png');
    stream.pipe(res);
  };

  // -----------------------------------------------------------------
  // GET /api/v2/attachments/by-key/:key(*)
  // -----------------------------------------------------------------
  router.get('/attachments/by-key/*', async (req: Request, res: Response) => {
    const rawKey = req.params[0];
    if (typeof rawKey !== 'string' || rawKey.length === 0) {
      res.status(400).json(errorBody('FILE_MISSING', 'Missing storage key'));
      return;
    }

    let key: string;
    try {
      key = decodeURIComponent(rawKey);
    } catch {
      res.status(400).json(errorBody('FILE_MISSING', 'Invalid storage key'));
      return;
    }

    if (!key.startsWith(BY_KEY_ALLOWED_PREFIX)) {
      res.status(403).json(errorBody('FORBIDDEN_FOR_DELETE', 'Storage key not permitted by this endpoint'));
      return;
    }

    let stream: Readable;
    try {
      stream = await fileUploader.findDeliveryFile(null, key);
    } catch (err) {
      const e = err as { code?: string };
      if (e.code === 'ENOENT') {
        res.status(404).json(errorBody('ATTACHMENT_NOT_FOUND', 'File not found'));
        return;
      }
      debug('by-key delivery error', err);
      res.status(500).json(errorBody('UPLOAD_FAILED', 'Failed to deliver file'));
      return;
    }

    res.setHeader('Content-Type', guessMimeFromKey(key));
    stream.on('error', (err) => {
      debug('by-key stream error', err);
      if (!res.headersSent) {
        res.status(500).end();
      } else {
        res.end();
      }
    });
    stream.pipe(res);
  });

  // -----------------------------------------------------------------
  // GET /api/v2/attachments/:id
  // -----------------------------------------------------------------
  router.get('/attachments/:id([0-9a-f]{24})', async (req: Request, res: Response) => {
    const user = req.user as UserDocument | undefined;
    if (!user) {
      res.status(401).json({ error: { code: 'AUTHENTICATION_REQUIRED', message: 'Authentication is required' } });
      return;
    }

    const id = req.params.id;
    if (!isValidObjectId(id)) {
      res.status(400).json(errorBody('INVALID_ATTACHMENT_ID', 'Invalid attachment id'));
      return;
    }

    let attachment: AttachmentDocument | null;
    try {
      attachment = (await Attachment.findById(id)) as AttachmentDocument | null;
    } catch (err) {
      debug('attachment lookup error', err);
      res.status(500).json(errorBody('UPLOAD_FAILED', 'Failed to load attachment'));
      return;
    }

    if (!attachment) {
      // A missing record means the file was deleted or never existed;
      // serve the placeholder so embedded references render gracefully.
      servePlaceholder(res);
      return;
    }

    const grant = await loadGrantedPage(Page, attachment.page.toString(), user);
    if ('error' in grant) {
      // Collapse INVALID_PAGE_ID + PAGE_NOT_FOUND alike to 404 — the
      // page id comes from the persisted attachment, so an
      // INVALID_PAGE_ID would only mean the document is corrupt.
      res.status(404).json(errorBody('ATTACHMENT_NOT_FOUND', 'Attachment not found'));
      return;
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
        servePlaceholder(res);
        return;
      }
      debug('attachment delivery error', err);
      res.status(500).json(errorBody('UPLOAD_FAILED', 'Failed to deliver file'));
      return;
    }

    res.setHeader('Content-Type', attachment.fileFormat);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(attachment.originalName || attachment.fileName)}`);
    stream.on('error', (err) => {
      debug('attachment stream error', err);
      if (!res.headersSent) {
        res.status(500).end();
      } else {
        res.end();
      }
    });
    stream.pipe(res);
  });

  return router;
};
