import { createExpressEndpoints, initServer } from '@ts-rest/express';
import {
  apiContract,
  type Attachment as AttachmentSchema,
  type UploadAttachmentErrorCode,
  IMAGE_UPLOAD_MIME,
  DND_EXTRA_UPLOAD_MIME,
} from '@crowi/api-contract';
import Crowi from 'src/crowi';
import { Express, Request, Response, Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Types } from 'mongoose';
import Debug from 'debug';
import FileUploader from 'src/util/fileUploader';
import { createRateLimiter } from 'src/util/rate-limit';
import { UserDocument } from 'src/models/user';
import { AttachmentDocument } from 'src/models/attachment';
import { PageDocument } from 'src/models/page';
import {
  internalServerErrorResponse,
  isPopulatedUser,
  isValidObjectId,
  loadGrantedPage,
  toISOStringOrNull,
  toStringId,
  toUserPublic,
  type PopulatedUserPublic,
} from 'src/util/ts-rest-helpers';

const debug = Debug('crowi:routes:ts-rest:attachment');

/**
 * RFC-0004 Phase 6/7 — intent-aware limits for `POST /api/v2/attachments/upload`.
 *
 * The endpoint serves two editor intents with different ceilings:
 *   - `paste` (RFC §"Image paste limits"): 10 MB, images only — a
 *     clipboard image blob is always an image.
 *   - `dnd` (RFC §"D&D limits"): 50 MB, images + documents (`.pdf`,
 *     `.txt`, `.md`, `.csv`) + archives (`.zip`).
 *
 * multer is configured with the larger (50 MB) cap so the multipart
 * parse never aborts a legitimate D&D upload; the per-intent size cap
 * is then enforced in-handler once `intent` has been parsed. The
 * per-intent MIME allow-list is likewise applied after the parse.
 */
const PASTE_MAX_BYTES = 10 * 1024 * 1024;
const DND_MAX_BYTES = 50 * 1024 * 1024;
/** multer-level hard cap — the larger of the two intents (D&D). */
const UPLOAD_MULTER_MAX_BYTES = DND_MAX_BYTES;

// MIME allow-lists shared with the web editor via `@crowi/api-contract`
// so client-side rejection and this authoritative check cannot drift.
const PASTE_ALLOWED_MIME = new Set<string>(IMAGE_UPLOAD_MIME);
const DND_ALLOWED_MIME = new Set<string>([...IMAGE_UPLOAD_MIME, ...DND_EXTRA_UPLOAD_MIME]);

/** Resolve the size cap + MIME allow-list for one upload intent. */
const limitsForIntent = (intent: 'paste' | 'dnd'): { maxBytes: number; allowedMime: Set<string> } =>
  intent === 'dnd' ? { maxBytes: DND_MAX_BYTES, allowedMime: DND_ALLOWED_MIME } : { maxBytes: PASTE_MAX_BYTES, allowedMime: PASTE_ALLOWED_MIME };

/** Per-user budget for the editor upload endpoint — RFC §"Attachment upload endpoint". */
const UPLOAD_RATE_LIMIT = 20;
const UPLOAD_RATE_WINDOW_MS = 60_000;

/**
 * Mime types we allow over the public `by-key` route. The route is intended
 * for profile pictures only (key prefix `user/`); image/* covers every
 * format `User.createUserPictureFilePath` can produce.
 */
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

const errorBody = (
  code:
    | 'INVALID_PAGE_ID'
    | 'PAGE_NOT_FOUND'
    | 'FILE_MISSING'
    | 'FILE_TOO_LARGE'
    | 'DISALLOWED_MIME'
    | 'INVALID_ATTACHMENT_ID'
    | 'ATTACHMENT_NOT_FOUND'
    | 'FORBIDDEN_FOR_DELETE'
    | 'UPLOAD_FAILED'
    | 'REMOVE_FAILED',
  message: string,
) => ({ error: { code, message } });

/**
 * Lowercase RFC-0004 error envelope for `POST /attachments/upload`. Kept
 * separate from `errorBody` because the upload endpoint's error codes
 * are lowercase + RFC-pinned (the editor maps each to a specific toast),
 * distinct from the uppercase codes of the list / add / delete routes.
 */
const uploadErrorBody = (error: UploadAttachmentErrorCode, message: string, details?: Record<string, unknown>) => ({
  error,
  message,
  ...(details ? { details } : {}),
});

const invalidPageIdResponse = {
  status: 400 as const,
  body: errorBody('INVALID_PAGE_ID', 'Invalid pageId'),
} as const;

const pageNotFoundResponse = {
  status: 404 as const,
  body: errorBody('PAGE_NOT_FOUND', 'Page not found'),
} as const;

/**
 * Convert an AttachmentDocument (with optional populated `creator`) into the
 * wire response. The model's `fileUrl` virtual returns
 * `/api/v2/attachments/:id` after this migration, so we surface that as
 * `url`.
 */
const attachmentToResponse = (attachment: AttachmentDocument): AttachmentSchema => {
  // Re-read off a JSON-serialized clone so populated subdocs (creator) come
  // through plainly. attachmentSchema has `toJSON: { virtuals: true }` so the
  // `fileUrl` virtual is included automatically.
  const obj = attachment.toJSON() as unknown as {
    _id: unknown;
    page: unknown;
    creator: PopulatedUserPublic | Types.ObjectId | string | null | undefined;
    filePath: string;
    fileName: string;
    originalName?: string;
    fileFormat: string;
    fileSize: number;
    createdAt?: Date | string;
    fileUrl: string;
  };

  const creator = obj.creator;
  const creatorPublic = isPopulatedUser(creator)
    ? toUserPublic(creator)
    : // Fallback when creator is unpopulated (shouldn't happen on our paths
      // because list / add both populate, but the schema requires the public
      // shape so we synthesize the minimum surface).
      toUserPublic({ _id: creator ? toStringId(creator as Types.ObjectId | string) : '' });

  return {
    _id: toStringId(obj._id as Types.ObjectId | string),
    page: toStringId(obj.page as Types.ObjectId | string),
    creator: creatorPublic,
    filePath: obj.filePath,
    fileName: obj.fileName,
    originalName: obj.originalName ?? '',
    fileFormat: obj.fileFormat,
    fileSize: obj.fileSize,
    createdAt: toISOStringOrNull(obj.createdAt as Date | undefined) ?? new Date(0).toISOString(),
    url: obj.fileUrl,
  };
};

export default (crowi: Crowi, _app: Express) => {
  const s = initServer();
  const router = Router();
  const Attachment = crowi.model('Attachment');
  const Page = crowi.model('Page');
  const fileUploader = FileUploader(crowi);

  const upload = multer({ dest: crowi.tmpDir });

  /** Absolute path to the placeholder image served when an attachment is gone. */
  const FILE_NOT_FOUND_IMAGE = path.join(crowi.publicDir, 'images', 'file-not-found.png');

  /**
   * Stream the `file-not-found.png` placeholder as a `200 image/png` response.
   *
   * Phase 3 — used by `GET /api/v2/attachments/:id` when the attachment record
   * is missing OR its backing object is gone from storage. We deliberately
   * return `200` (not `404`) so an embedded `<img>` in a wiki page renders the
   * placeholder inline instead of a broken-image glyph. No `Content-Disposition`
   * is set so the image displays inline.
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

  /**
   * Whether a storage-driver `get()` rejection means the object is simply
   * missing (as opposed to a real failure). The local driver throws
   * `code: 'ENOENT'`; the S3 driver surfaces a missing object as the AWS SDK
   * v3 `NoSuchKey` error (`$metadata.httpStatusCode === 404`, no `code`).
   */
  const isMissingFileError = (err: unknown): boolean => {
    const e = err as { code?: string; name?: string; $metadata?: { httpStatusCode?: number } };
    return e.code === 'ENOENT' || e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404;
  };

  // RFC-0004 Phase 6/7 — the editor-upload endpoint caps multer at the
  // larger D&D ceiling (50 MB) so a legitimate drag-and-drop upload is
  // never aborted mid-parse. The per-intent cap (paste 10 MB / dnd
  // 50 MB) is then enforced in-handler once `intent` has been parsed.
  const editorUpload = multer({ dest: crowi.tmpDir, limits: { fileSize: UPLOAD_MULTER_MAX_BYTES } });

  // One shared upload limiter per process. `crowi.redis` is `null` in
  // single-instance dev, which selects the in-memory fallback.
  const uploadLimiter = createRateLimiter({
    name: 'attachment-upload',
    limit: UPLOAD_RATE_LIMIT,
    windowMs: UPLOAD_RATE_WINDOW_MS,
    redisClient: crowi.redis ?? null,
  });

  // ---------------------------------------------------------------------------
  // Raw Express endpoints (registered BEFORE createExpressEndpoints so they
  // are matched before ts-rest's path matcher attempts to dispatch).
  //
  // These deliver bytes via Readable.pipe(), which ts-rest's "return body"
  // handler model cannot express without buffering the entire file. Authn
  // is already provided by the parent authenticatedRouter (jwtAuth).
  // ---------------------------------------------------------------------------

  /**
   * GET /api/v2/attachments/by-key/:key(*)
   *
   * Streams a stored object identified by storage key. To prevent the route
   * from acting as an arbitrary read primitive, we whitelist the `user/`
   * prefix only — these are profile pictures whose URL is computed by
   * `fileUploader.generateUrl` and stored in `user.image`. Attachment-row
   * backed files are served by `/api/v2/attachments/:id` via grant checks.
   */
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

  /**
   * GET /api/v2/attachments/:id
   *
   * Streams an attachment by Mongo ObjectId. Authorization: the caller must
   * be able to view the page that owns the attachment (loadGrantedPage).
   * 404 (not 403) when grant fails to avoid leaking the existence of a
   * page the caller cannot view.
   */
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
      // Phase 3 — a missing attachment record means the file was deleted or
      // never existed; serve the placeholder image instead of a 404 so
      // embedded references render gracefully.
      servePlaceholder(res);
      return;
    }

    const grant = await loadGrantedPage(Page, attachment.page.toString(), user);
    if ('error' in grant) {
      // Collapse INVALID_PAGE_ID + PAGE_NOT_FOUND alike to 404 here — the
      // page id comes from the persisted attachment, so an INVALID_PAGE_ID
      // would only mean the document is corrupt.
      res.status(404).json(errorBody('ATTACHMENT_NOT_FOUND', 'Attachment not found'));
      return;
    }

    let stream: Readable;
    try {
      stream = await Attachment.findDeliveryFile(attachment);
    } catch (err) {
      // Phase 3 — the record exists but the backing object is gone from
      // storage (local `ENOENT` / S3 `NoSuchKey`). Serve the placeholder
      // image so embedded references render gracefully. Any other driver
      // error is a genuine failure → 500.
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

  // ---------------------------------------------------------------------------
  // ts-rest contract handlers
  // ---------------------------------------------------------------------------

  const attachmentRouter = s.router(apiContract.attachment, {
    /**
     * GET /api/v2/pages/:pageId/attachments
     */
    listAttachments: async ({ params, req }) => {
      const user = req.user as UserDocument;
      const { pageId } = params;

      const grant = await loadGrantedPage(Page, pageId, user);
      if ('error' in grant) {
        // Collapse 400 / 404 into the contract-typed shape.
        if (grant.error.status === 400) {
          return invalidPageIdResponse;
        }
        return pageNotFoundResponse;
      }

      try {
        const attachments = (await Attachment.getListByPageId(new Types.ObjectId(pageId))) as AttachmentDocument[];
        return {
          status: 200 as const,
          body: { attachments: attachments.map(attachmentToResponse) },
        };
      } catch (err) {
        debug('listAttachments error', err);
        return internalServerErrorResponse;
      }
    },

    /**
     * POST /api/v2/pages/:pageId/attachments  (multipart/form-data)
     *
     * The legacy controller supported `page_id=0` + path to implicitly create
     * the page. We dropped that — the client must call `createPage` first.
     * This is documented as a semantic change in the task plan.
     */
    addAttachment: async ({ params, req, res }) => {
      const user = req.user as UserDocument;
      const { pageId } = params;

      const grant = await loadGrantedPage(Page, pageId, user);
      if ('error' in grant) {
        if (grant.error.status === 400) {
          return invalidPageIdResponse;
        }
        return pageNotFoundResponse;
      }
      const pageData: PageDocument = grant.page;

      // Multer is run inside the handler — same pattern as `me.uploadPicture`.
      // We resolve the ts-rest response from a Promise so the handler can
      // wait for multer's async parse to complete.
      return new Promise((resolve) => {
        upload.single('file')(req as Request, res as Response, async (multerErr: Error | unknown) => {
          if (multerErr) {
            debug('multer error', multerErr);
            return resolve({
              status: 400 as const,
              body: errorBody('FILE_MISSING', 'File upload error'),
            });
          }

          const tmpFile = (req as Request).file || null;
          if (!tmpFile) {
            return resolve({
              status: 400 as const,
              body: errorBody('FILE_MISSING', 'No file provided'),
            });
          }

          const tmpPath = tmpFile.path;
          const cleanupTmp = () => {
            fs.unlink(tmpPath, (unlinkErr) => {
              if (unlinkErr) debug('failed to unlink tmp file', unlinkErr);
            });
          };

          const originalName = tmpFile.originalname;
          const fileName = tmpFile.filename + tmpFile.originalname;
          const fileType = tmpFile.mimetype;
          const fileSize = tmpFile.size;
          const creator = user._id;

          try {
            const filePath = Attachment.createAttachmentFilePath(pageData._id, fileName, fileType);
            const tmpFileStream = fs.createReadStream(tmpPath, { flags: 'r', autoClose: true });

            await fileUploader.uploadFile(filePath, fileType, tmpFileStream, {});

            const created = (await Attachment.create({
              page: pageData._id,
              creator,
              filePath,
              originalName,
              fileName,
              fileFormat: fileType,
              fileSize,
            })) as AttachmentDocument;

            // Populate `creator` so the response shape matches list output.
            await created.populate('creator');

            cleanupTmp();

            const body = attachmentToResponse(created);
            return resolve({
              status: 200 as const,
              body: { attachment: body, url: body.url },
            });
          } catch (err) {
            debug('attachment upload error', err);
            cleanupTmp();
            return resolve({
              status: 500 as const,
              body: errorBody('UPLOAD_FAILED', 'Failed to save attachment'),
            });
          }
        });
      });
    },

    /**
     * POST /api/v2/attachments/upload  (multipart/form-data)
     *
     * RFC-0004 Phase 6 — direct upload for the editor's paste / D&D
     * handlers. Differs from `addAttachment` in three ways:
     *   1. Rate-limited to 20 uploads/min/user (429 + `Retry-After`).
     *   2. Enforces the editor size (10 MB) + MIME allow-list, returning
     *      the RFC's lowercase `{ error, message, details? }` envelope.
     *   3. Returns the lean `{ url, filename, mimeType, sizeBytes }`
     *      shape the editor splices straight into the Markdown source.
     *
     * `pageId` / `intent` are multipart text fields parsed by multer
     * (not validated by ts-rest — see the contract comment), so they
     * are validated in-handler after the parse completes. Upload
     * progress is observed entirely client-side via
     * `XMLHttpRequest.upload.onprogress`; the server receives the
     * multipart body with no special streaming protocol.
     */
    uploadAttachment: async ({ req, res }) => {
      const user = req.user as UserDocument;

      // 1. Rate limit before touching the (potentially large) body.
      const rate = await uploadLimiter.hit(user._id.toString());
      if (!rate.allowed) {
        res.setHeader('Retry-After', String(rate.retryAfterSeconds));
        return {
          status: 429 as const,
          body: uploadErrorBody('rate_limited', `Upload limit reached. Try again in ${rate.retryAfterSeconds} seconds.`, {
            retryAfterSeconds: rate.retryAfterSeconds,
          }),
        };
      }

      // Multer runs inside the handler (same pattern as `addAttachment`)
      // so the ts-rest response can await the async multipart parse.
      return new Promise((resolve) => {
        editorUpload.single('file')(req as Request, res as Response, async (multerErr: Error | unknown) => {
          const tmpFile = (req as Request).file || null;
          const cleanupTmp = () => {
            if (!tmpFile) return;
            fs.unlink(tmpFile.path, (unlinkErr) => {
              if (unlinkErr) debug('failed to unlink tmp file', unlinkErr);
            });
          };

          if (multerErr) {
            cleanupTmp();
            // multer raises `LIMIT_FILE_SIZE` when the body exceeds the
            // configured (50 MB / D&D) cap — surface it as the RFC's
            // `too_large` (413). The per-intent paste cap (10 MB) is a
            // smaller in-handler check below.
            const code = (multerErr as { code?: string }).code;
            if (code === 'LIMIT_FILE_SIZE') {
              return resolve({
                status: 413 as const,
                body: uploadErrorBody('too_large', 'The file is too large to upload.', { maxBytes: UPLOAD_MULTER_MAX_BYTES }),
              });
            }
            debug('editor upload multer error', multerErr);
            return resolve({
              status: 400 as const,
              body: uploadErrorBody('disallowed_type', 'File upload error.'),
            });
          }

          // --- Validate the multipart text fields (multer has parsed them) ---
          const body = (req as Request).body as { pageId?: unknown; intent?: unknown };
          const pageId = typeof body.pageId === 'string' ? body.pageId : '';
          const intent: 'paste' | 'dnd' | null = body.intent === 'paste' || body.intent === 'dnd' ? body.intent : null;

          if (!tmpFile) {
            cleanupTmp();
            return resolve({
              status: 400 as const,
              body: uploadErrorBody('disallowed_type', 'No file provided.'),
            });
          }
          if (!isValidObjectId(pageId)) {
            cleanupTmp();
            return resolve({
              status: 400 as const,
              body: uploadErrorBody('no_permission', 'A valid pageId is required.'),
            });
          }
          if (!intent) {
            cleanupTmp();
            return resolve({
              status: 400 as const,
              body: uploadErrorBody('disallowed_type', "The intent field must be 'paste' or 'dnd'."),
            });
          }

          // --- Intent-aware size + MIME enforcement ---
          // multer's 50 MB cap is the D&D ceiling; a `paste` upload
          // (clipboard image) is held to the smaller 10 MB cap here.
          const { maxBytes, allowedMime } = limitsForIntent(intent);

          if (tmpFile.size > maxBytes) {
            cleanupTmp();
            return resolve({
              status: 413 as const,
              body: uploadErrorBody('too_large', 'The file is too large to upload.', { maxBytes }),
            });
          }

          const fileType = tmpFile.mimetype;
          if (!allowedMime.has(fileType)) {
            cleanupTmp();
            return resolve({
              status: 415 as const,
              body: uploadErrorBody('disallowed_type', `Files of type ${fileType} cannot be uploaded.`, { mimeType: fileType }),
            });
          }

          // --- Permission: a caller who can view the page can attach to
          // it (same posture as `addAttachment`). Grant failure → 403. ---
          const grant = await loadGrantedPage(Page, pageId, user);
          if ('error' in grant) {
            cleanupTmp();
            return resolve({
              status: 403 as const,
              body: uploadErrorBody('no_permission', 'You do not have permission to attach files to this page.'),
            });
          }
          const pageData: PageDocument = grant.page;

          const originalName = tmpFile.originalname;
          const fileName = tmpFile.filename + tmpFile.originalname;
          const fileSize = tmpFile.size;

          try {
            const filePath = Attachment.createAttachmentFilePath(pageData._id, fileName, fileType);
            const tmpFileStream = fs.createReadStream(tmpFile.path, { flags: 'r', autoClose: true });

            await fileUploader.uploadFile(filePath, fileType, tmpFileStream, {});

            const created = (await Attachment.create({
              page: pageData._id,
              creator: user._id,
              filePath,
              originalName,
              fileName,
              fileFormat: fileType,
              fileSize,
            })) as AttachmentDocument;

            cleanupTmp();
            debug('editor upload ok', { intent, pageId, attachmentId: created._id.toString() });

            return resolve({
              status: 200 as const,
              body: {
                url: created.fileUrl,
                filename: originalName,
                mimeType: fileType,
                sizeBytes: fileSize,
              },
            });
          } catch (err) {
            debug('editor upload error', err);
            cleanupTmp();
            return resolve(internalServerErrorResponse);
          }
        });
      });
    },

    /**
     * DELETE /api/v2/attachments/:id
     *
     * Authorization (wiki policy): any authenticated user who can view the
     * owning page may delete an attachment — the same open-collaboration
     * posture as page editing. The caller still has to pass the page grant
     * check (so an attachment on a page they cannot see stays a 404), but
     * we no longer restrict deletion to the creator / admin / grantedUsers.
     * The legacy `/_api/attachments.remove` allowed even anonymous
     * deletion; we keep it authenticated-only (`authenticatedRouter`).
     */
    removeAttachment: async ({ params, req }) => {
      const user = req.user as UserDocument;
      const { id } = params;

      if (!isValidObjectId(id)) {
        return {
          status: 400 as const,
          body: errorBody('INVALID_ATTACHMENT_ID', 'Invalid attachment id'),
        };
      }

      let attachment: AttachmentDocument | null;
      try {
        attachment = (await Attachment.findById(id)) as AttachmentDocument | null;
      } catch (err) {
        debug('attachment lookup error', err);
        return {
          status: 500 as const,
          body: errorBody('REMOVE_FAILED', 'Failed to load attachment'),
        };
      }
      if (!attachment) {
        return {
          status: 404 as const,
          body: errorBody('ATTACHMENT_NOT_FOUND', 'Attachment not found'),
        };
      }

      // Resolve the page for the view-grant check. Any authenticated user
      // who can view the page may delete its attachments (wiki policy).
      const grant = await loadGrantedPage(Page, attachment.page.toString(), user);
      if ('error' in grant) {
        return {
          status: 404 as const,
          body: errorBody('ATTACHMENT_NOT_FOUND', 'Attachment not found'),
        };
      }

      try {
        await Attachment.removeAttachment(attachment);
        return { status: 200 as const, body: { success: true as const } };
      } catch (err) {
        debug('removeAttachment error', err);
        return {
          status: 500 as const,
          body: errorBody('REMOVE_FAILED', 'Failed to delete attachment'),
        };
      }
    },
  });

  createExpressEndpoints(apiContract.attachment, attachmentRouter, router);

  return router;
};
