/**
 * RFC-0006 Phase 4 Batch 6 — `attachment` resource Hono port.
 *
 * Replaces `packages/api/src/routes/ts-rest/attachment.ts`. Six
 * endpoints, plus the two raw-stream Express routes (`GET
 * /attachments/:id` / `GET /attachments/by-key/:key`) which stay on
 * the Express bridge until Phase 6 because they pipe `Readable` bytes
 * and Hono's typed-response API does not express
 * streaming-without-buffer cleanly:
 *
 *   GET    /pages/:pageId/attachments        — list (page-scoped)
 *   POST   /pages/:pageId/attachments        — add (multipart)
 *   GET    /pages/:pageId/attachments/usage  — usage breakdown
 *   GET    /attachments/:id/meta             — single attachment meta
 *   POST   /attachments/upload               — editor paste/D&D upload (multipart)
 *   DELETE /attachments/:id                  — remove
 *
 * Auth split:
 *  - `/pages/*` (list / add / usage) rides on the `revision` handler's
 *    broad `createJwtAuth(crowi)` apply.
 *  - `/attachments/*` (meta / upload / remove) is OUTSIDE that prefix
 *    so we install jwtAuth on `/attachments/*` ourselves.
 *
 * Multipart (RFC-0006 discovery doc §5):
 *  - `addAttachment` + `uploadAttachment` use Hono-native
 *    `c.req.parseBody()`. multer is gone from this resource.
 *  - `uploadAttachment` reads `c.req.header('content-length')` BEFORE
 *    `parseBody()` and 413's a body that exceeds the larger D&D ceiling
 *    (50 MB) — this preserves the multer `LIMIT_FILE_SIZE` early-reject
 *    posture without buffering the body. The per-intent paste cap
 *    (10 MB) is enforced AFTER parse against the actual file size.
 *
 * Rate limiting:
 *  - `uploadAttachment` only: 20 req/min/user, name
 *    `'attachment-upload'`. 429 envelope:
 *    `{ error: 'rate_limited', message, details: { retryAfterSeconds } }`
 *    (`UploadAttachmentErrorSchema`). Applied AFTER jwtAuth on
 *    `/attachments/upload`.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  type Attachment as AttachmentSchema,
  type AttachmentMeta,
  type UploadAttachmentErrorCode,
  type UserPublic,
  IMAGE_UPLOAD_MIME,
  DND_EXTRA_UPLOAD_MIME,
  addAttachmentRoute,
  getAttachmentMetaRoute,
  getAttachmentUsageRoute,
  listAttachmentsRoute,
  removeAttachmentRoute,
  uploadAttachmentRoute,
} from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import Debug from 'debug';
import { Types } from 'mongoose';

import type Crowi from 'src/crowi';
import type { AttachmentDocument } from 'src/models/attachment';
import type { PageDocument } from 'src/models/page';
import FileUploader from 'src/util/fileUploader';
import { createRateLimiter } from 'src/util/rate-limit';
import {
  type PopulatedUserPublic,
  isPopulatedUser,
  isValidObjectId,
  loadGrantedPage,
  toISOStringOrNull,
  toStringId,
  toUserPublic,
} from 'src/util/ts-rest-helpers';

import type { CrowiHonoBindings } from '../app';
import { createJwtAuth } from '../middleware/auth';
import { withRateLimit } from '../middleware/rate-limit';
import { applyScope } from '../middleware/require-scope';

import { INTERNAL_ERROR_BODY } from './_helpers/errors';

const debug = Debug('crowi:hono:handlers:attachment');

/**
 * RFC-0004 Phase 6/7 — intent-aware limits for the editor upload.
 *   - `paste`: 10 MB, images only (a clipboard blob is always an image).
 *   - `dnd`  : 50 MB, images + documents (`.pdf`, `.txt`, `.md`, `.csv`)
 *              + archives (`.zip`).
 *
 * The `Content-Length` precheck uses the larger ceiling (50 MB) so a
 * legitimate D&D upload is never 413'd before parse. The per-intent
 * cap (paste 10 MB) is then enforced post-parse against the actual
 * file size.
 */
const PASTE_MAX_BYTES = 10 * 1024 * 1024;
const DND_MAX_BYTES = 50 * 1024 * 1024;
const UPLOAD_PARSE_MAX_BYTES = DND_MAX_BYTES;

const PASTE_ALLOWED_MIME = new Set<string>(IMAGE_UPLOAD_MIME);
const DND_ALLOWED_MIME = new Set<string>([...IMAGE_UPLOAD_MIME, ...DND_EXTRA_UPLOAD_MIME]);

const limitsForIntent = (intent: 'paste' | 'dnd'): { maxBytes: number; allowedMime: Set<string> } =>
  intent === 'dnd' ? { maxBytes: DND_MAX_BYTES, allowedMime: DND_ALLOWED_MIME } : { maxBytes: PASTE_MAX_BYTES, allowedMime: PASTE_ALLOWED_MIME };

/** Per-user budget for the editor upload endpoint — RFC §"Attachment upload endpoint". */
const UPLOAD_RATE_LIMIT = 20;
const UPLOAD_RATE_WINDOW_MS = 60_000;

type AttachmentErrorCode =
  | 'INVALID_PAGE_ID'
  | 'PAGE_NOT_FOUND'
  | 'FILE_MISSING'
  | 'FILE_TOO_LARGE'
  | 'DISALLOWED_MIME'
  | 'INVALID_ATTACHMENT_ID'
  | 'ATTACHMENT_NOT_FOUND'
  | 'FORBIDDEN_FOR_DELETE'
  | 'UPLOAD_FAILED'
  | 'REMOVE_FAILED';

const errorBody = (code: AttachmentErrorCode, message: string) => ({ error: { code, message } });

/**
 * Lowercase RFC-0004 error envelope for `POST /attachments/upload`.
 * Kept separate from `errorBody` because the upload endpoint's codes
 * are lowercase + RFC-pinned (the editor maps each to a specific toast).
 */
const uploadErrorBody = (error: UploadAttachmentErrorCode, message: string, details?: Record<string, unknown>) => ({
  error,
  message,
  ...(details ? { details } : {}),
});

const INVALID_PAGE_ID_FOR_ATTACHMENT_BODY = errorBody('INVALID_PAGE_ID', 'Invalid pageId');
const PAGE_NOT_FOUND_FOR_ATTACHMENT_BODY = errorBody('PAGE_NOT_FOUND', 'Page not found');
const ATTACHMENT_NOT_FOUND_BODY = errorBody('ATTACHMENT_NOT_FOUND', 'Attachment not found');

/**
 * Outer ceiling for `POST /pages/:pageId/attachments`. The legacy multer
 * disk-storage didn't bound the size, but Hono's `parseBody()` buffers
 * the entire body in memory, so we need a hard cap to avoid OOM.
 */
const ADD_ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024;

/**
 * RFC-0004 Phase 7 — extract attachment ObjectId hex strings referenced
 * by a revision body. Matches the current `/api/v2/attachments/<id>`
 * (the `fileUrl` virtual / stream route) and the legacy `/files/<id>`
 * form still present in bodies saved before the migration.
 */
const ATTACHMENT_URI_RE = /(?:\/api\/v2\/attachments\/|\/files\/)([0-9a-f]{24})/gi;

const collectReferencedAttachmentIds = (body: string): Set<string> => {
  const ids = new Set<string>();
  for (const match of body.matchAll(ATTACHMENT_URI_RE)) {
    ids.add(match[1].toLowerCase());
  }
  return ids;
};

/**
 * Convert an AttachmentDocument (with optional populated `creator`) into
 * the wire response. `inUse` (Phase 7) is supplied by the caller.
 */
const attachmentToResponse = (attachment: AttachmentDocument, inUse: boolean): AttachmentSchema => {
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
    : // Fallback when creator is unpopulated (shouldn't happen on our
      // paths because list / add both populate, but the schema requires
      // the public shape so synthesize the minimum surface).
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
    inUse,
  };
};

const attachmentToMetaResponse = (attachment: AttachmentDocument): AttachmentMeta => {
  const { inUse: _inUse, ...meta } = attachmentToResponse(attachment, false);
  return meta;
};

/**
 * Drain a Web `File` to a temp file on disk. The existing `FileUploader`
 * pipeline (streams from disk) is left unchanged downstream so we mirror
 * multer's "tmp path + mimetype" shape exactly. Streams the body directly
 * to disk to avoid buffering the full file in memory twice
 * (`arrayBuffer()` + `Buffer.from(...)`).
 */
const persistUploadToTmp = async (file: File, tmpDir: string): Promise<{ tmpPath: string; mimetype: string; originalname: string; size: number }> => {
  mkdirSync(tmpDir, { recursive: true });
  const randomId = `${Date.now()}-${randomBytes(8).toString('hex')}`;
  const tmpPath = path.join(tmpDir, randomId);

  await pipeline(Readable.fromWeb(file.stream() as Parameters<typeof Readable.fromWeb>[0]), fs.createWriteStream(tmpPath));

  return {
    tmpPath,
    mimetype: file.type || 'application/octet-stream',
    originalname: file.name || randomId,
    size: file.size,
  };
};

const cleanupTmp = (tmpPath: string | null) => {
  if (!tmpPath) return;
  fs.unlink(tmpPath, (err) => {
    if (err) debug('failed to unlink tmp file', err);
  });
};

/** Resolve the first `File` instance under field `name` from parseBody. */
const pickFile = (parsed: Record<string, string | File | (string | File)[]>, name: string): File | undefined => {
  const value = parsed[name];
  if (value instanceof File) return value;
  if (Array.isArray(value)) {
    return value.find((entry): entry is File => entry instanceof File);
  }
  return undefined;
};

const pickString = (parsed: Record<string, string | File | (string | File)[]>, name: string): string | undefined => {
  const value = parsed[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.find((entry): entry is string => typeof entry === 'string');
  }
  return undefined;
};

export const registerAttachmentRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(app: E, crowi: Crowi) => {
  const Attachment = crowi.model('Attachment');
  const Page = crowi.model('Page');
  const fileUploader = FileUploader(crowi);

  // One shared upload limiter per process.
  const uploadLimiter = createRateLimiter({
    name: 'attachment-upload',
    limit: UPLOAD_RATE_LIMIT,
    windowMs: UPLOAD_RATE_WINDOW_MS,
    redisClient: crowi.redis ?? null,
  });

  const uploadRateLimitMiddleware = withRateLimit({
    limiter: uploadLimiter,
    wireShape: 'attachment-upload-envelope',
    message: (retry) => `Upload limit reached. Try again in ${retry} seconds.`,
  });

  // `/attachments/*` is OUTSIDE the revision-owned `/pages/*` apply.
  // Install jwtAuth broadly here; the rate limit is per-endpoint
  // (only `uploadAttachment` is throttled).
  app.use('/attachments/*', createJwtAuth(crowi));
  app.use('/attachments/upload', uploadRateLimitMiddleware);

  // RFC-0010 — attachment scopes.
  applyScope(app, getAttachmentUsageRoute, 'attachments:read');
  applyScope(app, listAttachmentsRoute, 'attachments:read');
  applyScope(app, getAttachmentMetaRoute, 'attachments:read');
  applyScope(app, addAttachmentRoute, 'attachments:write');
  applyScope(app, uploadAttachmentRoute, 'attachments:write');
  applyScope(app, removeAttachmentRoute, 'attachments:write');

  return (
    app
      // --------------------------------------------------------------
      // GET /pages/:pageId/attachments/usage   (registered first so the
      // literal `/usage` suffix wins over `/pages/:pageId/attachments`)
      // --------------------------------------------------------------
      .openapi(getAttachmentUsageRoute, async (c) => {
        const user = c.get('user');
        const { pageId } = c.req.valid('param');

        const grant = await loadGrantedPage(Page, pageId, user);
        if ('error' in grant) {
          if (grant.error.status === 400) return c.json(INVALID_PAGE_ID_FOR_ATTACHMENT_BODY, 400);
          return c.json(PAGE_NOT_FOUND_FOR_ATTACHMENT_BODY, 404);
        }
        const page = grant.page;

        try {
          const Revision = crowi.model('Revision');

          // All revisions, newest first. `renderedAst` is deliberately
          // excluded — heavy and the scan only needs raw body. DC-5
          // (`feature-revision-page-ref`): query by the immutable `page` id
          // (already resolved above via the grant check), not the mutable
          // `path` string — a rename's cosmetic path-sync failing would
          // otherwise lose track of this page's own past revisions, and a
          // path later reused by an unrelated page would otherwise pull in
          // that page's revision metadata here.
          const revisions = (await Revision.find({ page: page._id }).select('_id body createdAt author').sort({ createdAt: -1 }).populate('author')) as Array<{
            _id: Types.ObjectId;
            body?: string;
            createdAt?: Date;
            author?: PopulatedUserPublic | Types.ObjectId | string | null;
          }>;

          // `page.revision` may be a bare ObjectId or a populated
          // Revision document (findPageById populates it). Normalise to
          // the hex id.
          const rawRevision = page.revision as unknown;
          const latestRevisionId =
            rawRevision == null
              ? null
              : typeof rawRevision === 'object' && rawRevision !== null && '_id' in rawRevision
                ? toStringId((rawRevision as { _id: Types.ObjectId | string })._id)
                : toStringId(rawRevision as Types.ObjectId | string);

          let latestIds: Set<string> = new Set();
          const referencedByPast = new Map<
            string,
            Array<{ revisionId: string; createdAt: string; author: PopulatedUserPublic | Types.ObjectId | string | null }>
          >();

          for (const revision of revisions) {
            const ids = revision.body ? collectReferencedAttachmentIds(revision.body) : new Set<string>();
            const isLatest = latestRevisionId !== null && revision._id.toString() === latestRevisionId;
            if (isLatest) {
              latestIds = ids;
              continue;
            }
            for (const id of ids) {
              const list = referencedByPast.get(id) ?? [];
              list.push({
                revisionId: revision._id.toString(),
                createdAt: toISOStringOrNull(revision.createdAt) ?? new Date(0).toISOString(),
                author: revision.author ?? null,
              });
              referencedByPast.set(id, list);
            }
          }

          const attachments = (await Attachment.getListByPageId(new Types.ObjectId(pageId))) as AttachmentDocument[];

          const latest: AttachmentSchema[] = [];
          const past: Array<{
            attachment: AttachmentSchema;
            referencingRevisions: Array<{ revisionId: string; createdAt: string; author: UserPublic }>;
          }> = [];

          for (const att of attachments) {
            const attId = att._id.toString().toLowerCase();
            if (latestIds.has(attId)) {
              latest.push(attachmentToResponse(att, true));
              continue;
            }
            const refs = referencedByPast.get(attId) ?? [];
            past.push({
              attachment: attachmentToResponse(att, false),
              referencingRevisions: refs.map((r) => ({
                revisionId: r.revisionId,
                createdAt: r.createdAt,
                author: isPopulatedUser(r.author)
                  ? toUserPublic(r.author)
                  : toUserPublic({ _id: r.author ? toStringId(r.author as Types.ObjectId | string) : '' }),
              })),
            });
          }

          return c.json({ pagePath: page.path, latest, past }, 200);
        } catch (err) {
          debug('getAttachmentUsage error', err);
          return c.json(INTERNAL_ERROR_BODY, 500);
        }
      })
      // --------------------------------------------------------------
      // GET /pages/:pageId/attachments
      // --------------------------------------------------------------
      .openapi(listAttachmentsRoute, async (c) => {
        const user = c.get('user');
        const { pageId } = c.req.valid('param');

        const grant = await loadGrantedPage(Page, pageId, user);
        if ('error' in grant) {
          if (grant.error.status === 400) return c.json(INVALID_PAGE_ID_FOR_ATTACHMENT_BODY, 400);
          return c.json(PAGE_NOT_FOUND_FOR_ATTACHMENT_BODY, 404);
        }

        try {
          const attachments = (await Attachment.getListByPageId(new Types.ObjectId(pageId))) as AttachmentDocument[];

          // Phase 7 — derive `inUse` from the page's latest revision
          // body. The page is already loaded via `loadGrantedPage` (no
          // revisionId → `grant.page.revision` is the latest). Read just
          // the body and scan it once. Missing / empty revision falls
          // back to `inUse: true` for every attachment rather than
          // hiding files while reference state is undetermined.
          const revisionId = grant.page.revision;
          let referencedIds: Set<string> | null = null;
          if (revisionId) {
            const Revision = crowi.model('Revision');
            const revision = (await Revision.findById(revisionId).select('body')) as { body?: string } | null;
            if (revision?.body) {
              referencedIds = collectReferencedAttachmentIds(revision.body);
            }
          }

          return c.json(
            {
              attachments: attachments.map((a) => attachmentToResponse(a, referencedIds === null ? true : referencedIds.has(a._id.toString().toLowerCase()))),
            },
            200,
          );
        } catch (err) {
          debug('listAttachments error', err);
          return c.json(INTERNAL_ERROR_BODY, 500);
        }
      })
      // --------------------------------------------------------------
      // POST /pages/:pageId/attachments  (multipart/form-data)
      // --------------------------------------------------------------
      .openapi(addAttachmentRoute, async (c) => {
        const user = c.get('user');
        const { pageId } = c.req.valid('param');

        // Hard ceiling on the multipart body before `parseBody()` buffers
        // it. Mirrors the editor-upload precheck — without it, a logged-in
        // user posting a 2 GB body would OOM the api process.
        const contentLengthHeader = c.req.header('content-length');
        if (contentLengthHeader && Number.parseInt(contentLengthHeader, 10) > ADD_ATTACHMENT_MAX_BYTES) {
          return c.json(errorBody('FILE_MISSING', 'Request body exceeds 100 MB'), 413);
        }

        const grant = await loadGrantedPage(Page, pageId, user);
        if ('error' in grant) {
          if (grant.error.status === 400) return c.json(INVALID_PAGE_ID_FOR_ATTACHMENT_BODY, 400);
          return c.json(PAGE_NOT_FOUND_FOR_ATTACHMENT_BODY, 404);
        }
        const pageData: PageDocument = grant.page;

        let parsed: Record<string, string | File | (string | File)[]>;
        try {
          parsed = await c.req.parseBody();
        } catch (err) {
          debug('addAttachment parseBody error', err);
          return c.json(errorBody('FILE_MISSING', 'File upload error'), 400);
        }

        const file = pickFile(parsed, 'file');
        if (!file) {
          return c.json(errorBody('FILE_MISSING', 'No file provided'), 400);
        }

        let tmpPath: string | null = null;
        try {
          const persisted = await persistUploadToTmp(file, crowi.tmpDir);
          tmpPath = persisted.tmpPath;

          const originalName = persisted.originalname;
          // Mirror multer's `filename + originalname` shape so
          // `createAttachmentFilePath` infers the same key as before.
          const fileName = path.basename(persisted.tmpPath) + persisted.originalname;
          const fileType = persisted.mimetype;
          const fileSize = persisted.size;

          const filePath = Attachment.createAttachmentFilePath(pageData._id, fileName, fileType);
          const tmpFileStream = fs.createReadStream(persisted.tmpPath, { flags: 'r', autoClose: true });

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

          await created.populate('creator');

          cleanupTmp(tmpPath);
          tmpPath = null;

          // A freshly uploaded file is not yet referenced in the body,
          // so it starts `inUse: false`. The next `listAttachments`
          // recomputes from the latest revision.
          const responseBody = attachmentToResponse(created, false);
          return c.json({ attachment: responseBody, url: responseBody.url }, 200);
        } catch (err) {
          debug('addAttachment error', err);
          cleanupTmp(tmpPath);
          return c.json(errorBody('UPLOAD_FAILED', 'Failed to save attachment'), 500);
        }
      })
      // --------------------------------------------------------------
      // POST /attachments/upload  (multipart/form-data)
      // --------------------------------------------------------------
      .openapi(uploadAttachmentRoute, async (c) => {
        const user = c.get('user');

        // Content-Length precheck: reject obvious over-cap bodies
        // BEFORE invoking `parseBody()`. This reproduces multer's
        // `LIMIT_FILE_SIZE` early-reject posture without buffering.
        // We use the larger D&D ceiling (50 MB) here — the per-intent
        // paste cap (10 MB) is enforced post-parse against the actual
        // file size (the multipart envelope overhead would otherwise
        // make a 9.99 MB paste 413 prematurely).
        const contentLengthHeader = c.req.header('content-length');
        if (contentLengthHeader) {
          const parsedLen = Number.parseInt(contentLengthHeader, 10);
          if (Number.isFinite(parsedLen) && parsedLen > UPLOAD_PARSE_MAX_BYTES) {
            return c.json(uploadErrorBody('too_large', 'The file is too large to upload.', { maxBytes: UPLOAD_PARSE_MAX_BYTES }), 413);
          }
        }

        let parsed: Record<string, string | File | (string | File)[]>;
        try {
          parsed = await c.req.parseBody();
        } catch (err) {
          debug('uploadAttachment parseBody error', err);
          return c.json(uploadErrorBody('disallowed_type', 'File upload error.'), 400);
        }

        const file = pickFile(parsed, 'file');
        const pageId = pickString(parsed, 'pageId') ?? '';
        const intentField = pickString(parsed, 'intent');
        const intent: 'paste' | 'dnd' | null = intentField === 'paste' || intentField === 'dnd' ? intentField : null;

        if (!file) {
          return c.json(uploadErrorBody('disallowed_type', 'No file provided.'), 400);
        }
        if (!isValidObjectId(pageId)) {
          return c.json(uploadErrorBody('no_permission', 'A valid pageId is required.'), 400);
        }
        if (!intent) {
          return c.json(uploadErrorBody('disallowed_type', "The intent field must be 'paste' or 'dnd'."), 400);
        }

        // Intent-aware size + MIME enforcement (paste is held to 10 MB
        // even when the wire body fits the 50 MB D&D ceiling).
        const { maxBytes, allowedMime } = limitsForIntent(intent);
        if (file.size > maxBytes) {
          return c.json(uploadErrorBody('too_large', 'The file is too large to upload.', { maxBytes }), 413);
        }
        const fileType = file.type || 'application/octet-stream';
        if (!allowedMime.has(fileType)) {
          return c.json(uploadErrorBody('disallowed_type', `Files of type ${fileType} cannot be uploaded.`, { mimeType: fileType }), 415);
        }

        // Permission: a caller who can view the page can attach to it
        // (same posture as `addAttachment`). Grant failure → 403.
        const grant = await loadGrantedPage(Page, pageId, user);
        if ('error' in grant) {
          return c.json(uploadErrorBody('no_permission', 'You do not have permission to attach files to this page.'), 403);
        }
        const pageData: PageDocument = grant.page;

        let tmpPath: string | null = null;
        try {
          const persisted = await persistUploadToTmp(file, crowi.tmpDir);
          tmpPath = persisted.tmpPath;

          const originalName = persisted.originalname;
          const fileName = path.basename(persisted.tmpPath) + persisted.originalname;
          const fileSize = persisted.size;

          const filePath = Attachment.createAttachmentFilePath(pageData._id, fileName, fileType);
          const tmpFileStream = fs.createReadStream(persisted.tmpPath, { flags: 'r', autoClose: true });

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

          cleanupTmp(tmpPath);
          tmpPath = null;

          debug('editor upload ok', { intent, pageId, attachmentId: created._id.toString() });
          return c.json(
            {
              url: created.fileUrl,
              filename: originalName,
              mimeType: fileType,
              sizeBytes: fileSize,
            },
            200,
          );
        } catch (err) {
          debug('editor upload error', err);
          cleanupTmp(tmpPath);
          return c.json(INTERNAL_ERROR_BODY, 500);
        }
      })
      // --------------------------------------------------------------
      // GET /attachments/:id/meta
      // --------------------------------------------------------------
      .openapi(getAttachmentMetaRoute, async (c) => {
        const user = c.get('user');
        const { id } = c.req.valid('param');

        if (!isValidObjectId(id)) {
          return c.json(errorBody('INVALID_ATTACHMENT_ID', 'Invalid attachment id'), 400);
        }

        let attachment: AttachmentDocument | null;
        try {
          attachment = (await Attachment.findById(id).populate('creator')) as AttachmentDocument | null;
        } catch (err) {
          debug('getAttachmentMeta lookup error', err);
          return c.json(INTERNAL_ERROR_BODY, 500);
        }
        if (!attachment) {
          return c.json(ATTACHMENT_NOT_FOUND_BODY, 404);
        }

        const grant = await loadGrantedPage(Page, attachment.page.toString(), user);
        if ('error' in grant) {
          // Collapse INVALID_PAGE_ID + PAGE_NOT_FOUND alike to 404 —
          // the page id comes from the persisted attachment, and a
          // hidden page must not be distinguishable from a missing one.
          return c.json(ATTACHMENT_NOT_FOUND_BODY, 404);
        }

        return c.json(attachmentToMetaResponse(attachment), 200);
      })
      // --------------------------------------------------------------
      // DELETE /attachments/:id
      // --------------------------------------------------------------
      //
      // Wiki policy: any authenticated user who can view the owning
      // page may delete an attachment. The caller still has to pass
      // the page grant check (so an attachment on a page they cannot
      // see stays a 404).
      .openapi(removeAttachmentRoute, async (c) => {
        const user = c.get('user');
        const { id } = c.req.valid('param');

        if (!isValidObjectId(id)) {
          return c.json(errorBody('INVALID_ATTACHMENT_ID', 'Invalid attachment id'), 400);
        }

        let attachment: AttachmentDocument | null;
        try {
          attachment = (await Attachment.findById(id)) as AttachmentDocument | null;
        } catch (err) {
          debug('removeAttachment lookup error', err);
          return c.json(errorBody('REMOVE_FAILED', 'Failed to load attachment'), 500);
        }
        if (!attachment) {
          return c.json(ATTACHMENT_NOT_FOUND_BODY, 404);
        }

        const grant = await loadGrantedPage(Page, attachment.page.toString(), user);
        if ('error' in grant) {
          return c.json(ATTACHMENT_NOT_FOUND_BODY, 404);
        }

        try {
          await Attachment.removeAttachment(attachment);
          return c.json({ success: true as const }, 200);
        } catch (err) {
          debug('removeAttachment error', err);
          return c.json(errorBody('REMOVE_FAILED', 'Failed to delete attachment'), 500);
        }
      })
  );
};
