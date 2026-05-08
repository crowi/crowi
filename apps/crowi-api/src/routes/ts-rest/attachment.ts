import { createExpressEndpoints, initServer } from '@ts-rest/express';
import { apiContract, type Attachment as AttachmentSchema } from '@crowi/api-contract';
import Crowi from 'src/crowi';
import { Express, Request, Response, Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { Types } from 'mongoose';
import Debug from 'debug';
import FileUploader from 'src/util/fileUploader';
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
      res.status(404).json(errorBody('ATTACHMENT_NOT_FOUND', 'Attachment not found'));
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
      const e = err as { code?: string };
      if (e.code === 'ENOENT') {
        res.status(404).json(errorBody('ATTACHMENT_NOT_FOUND', 'File not found'));
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
     * DELETE /api/v2/attachments/:id
     *
     * Authorization (semantic change from legacy):
     *   - attachment.creator
     *   - user.admin
     *   - user is in page.grantedUsers
     * Anyone else → 403. The legacy `/_api/attachments.remove` allowed
     * anonymous deletion.
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

      // Resolve the page for grant + grantedUsers check.
      const grant = await loadGrantedPage(Page, attachment.page.toString(), user);
      if ('error' in grant) {
        return {
          status: 404 as const,
          body: errorBody('ATTACHMENT_NOT_FOUND', 'Attachment not found'),
        };
      }
      const page = grant.page;

      const isCreator = attachment.creator.toString() === user._id.toString();
      const isAdmin = user.admin === true;
      const isGrantedUser = (page.grantedUsers || []).some((gid) => gid.toString() === user._id.toString());

      if (!isCreator && !isAdmin && !isGrantedUser) {
        return {
          status: 403 as const,
          body: errorBody('FORBIDDEN_FOR_DELETE', 'You do not have permission to remove this attachment'),
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
