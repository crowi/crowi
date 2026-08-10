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
 *    broad `createJwtAuth(crowi)` apply — header-only, same as every other
 *    `/pages/*` route.
 *  - `/attachments/*` (meta / upload / remove, AND the raw-stream by-id /
 *    original / by-key delivery routes in `attachment-stream.ts`) is
 *    OUTSIDE that prefix so we install `createAttachmentAuth(crowi)` on
 *    `/attachments/*` ourselves (feature-auth-cookie-fallback-scope). It
 *    shares `createJwtAuth`'s core and is header-only for meta / upload /
 *    remove — only GET/HEAD on the by-id / original / by-key delivery
 *    routes accept the `crowi.accessToken` cookie fallback. This is the
 *    ONLY auth install for the whole `/attachments/*` subtree: this handler
 *    always registers before `attachment-stream.ts` (`hono/index.ts`), and
 *    that file deliberately installs no auth of its own to keep credential
 *    resolution to exactly one pass per request (see its top doc comment).
 *
 * Multipart (RFC-0006 discovery doc §5):
 *  - `addAttachment` + `uploadAttachment` use Hono-native
 *    `c.req.parseBody()`. multer is gone from this resource.
 *  - Both routes reject a `Content-Length` over the resolved upload size
 *    limit (one limit, not per-route/intent — see `registerAttachmentRoutes`)
 *    via `rejectOversizedContentLength`, installed as `method +
 *    routingPath`-scoped middleware BEFORE `.openapi(route, handler)` below
 *    (same `app.on(...)` pattern `applyScope` uses). This has to be
 *    middleware, not a check at the top of the handler: `.openapi()`
 *    installs `@hono/zod-openapi`'s generated multipart validator ahead of
 *    the handler for any route whose schema declares a `multipart/form-data`
 *    body, and that validator reads the ENTIRE request via
 *    `c.req.arrayBuffer()` to build the `FormData` it checks — a same-handler
 *    precheck would run only after that buffering, defeating the whole
 *    point of an early-reject OOM guard. The precheck compares
 *    `Content-Length` (the WHOLE multipart body: boundaries, part headers,
 *    any other form fields) against the limit plus a small fixed allowance
 *    for that framing overhead (`MULTIPART_OVERHEAD_ALLOWANCE_BYTES`) — a
 *    file sized exactly at the limit must not be rejected just because its
 *    envelope pushed `Content-Length` past the raw number. A request with no
 *    (or a malformed) `Content-Length` — e.g. chunked transfer — is rejected
 *    by the same precheck rather than let through, since its size cannot be
 *    bounded before `parseBody()` would buffer it. Both routes ALSO re-check
 *    the actual parsed `file.size` (no framing) against the exact limit
 *    after `parseBody()`, since `Content-Length` can be spoofed smaller than
 *    the real body.
 *
 * Rate limiting:
 *  - `uploadAttachment` only: 20 req/min/user, name
 *    `'attachment-upload'`. 429 envelope:
 *    `{ error: 'rate_limited', message, details: { retryAfterSeconds } }`
 *    (`UploadAttachmentErrorSchema`). Applied AFTER createAttachmentAuth on
 *    `/attachments/upload`.
 */
import { randomBytes } from 'node:crypto';
import fs, { mkdirSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  type AttachmentMeta,
  type Attachment as AttachmentSchema,
  addAttachmentRoute,
  getAttachmentMetaRoute,
  getAttachmentUsageRoute,
  getUploadPolicyRoute,
  listAttachmentsRoute,
  removeAttachmentRoute,
  UPLOAD_ALLOWED_MIME,
  type UploadAttachmentErrorCode,
  type UserPublic,
  uploadAttachmentRoute,
} from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import Debug from 'debug';
import { createMiddleware } from 'hono/factory';
import { Types } from 'mongoose';

import type Crowi from 'src/crowi';
import type { AttachmentDocument } from 'src/models/attachment';
import type { PageDocument } from 'src/models/page';
import FileUploader from 'src/util/file-uploader';
import { generateDisplayDerivativeForUpload } from 'src/util/image-display-derivative';
import { createRateLimiter } from 'src/util/rate-limit';
import { resolveRedisKeyspaceIfEnabled } from 'src/util/redis-keyspace';
import { resolveUploadMaxBytes } from 'src/util/upload-limit';
import {
  isPopulatedUser,
  isValidObjectId,
  loadGrantedPage,
  type PopulatedUserPublic,
  toISOStringOrNull,
  toStringId,
  toUserPublic,
} from 'src/util/ts-rest-helpers';

import type { CrowiHonoBindings } from '../app';
import { createAttachmentAuth } from '../middleware/auth';
import { withRateLimit } from '../middleware/rate-limit';
import { applyScope } from '../middleware/require-scope';

import { INTERNAL_ERROR_BODY } from './_helpers/errors';

const debug = Debug('crowi:hono:handlers:attachment');

/**
 * The single SIZE limit for every attachment upload route (attach button /
 * editor paste / editor drag-and-drop alike), independent of route or
 * client-declared intent.
 *
 * `registerAttachmentRoutes` resolves it once, from `crowi.getEnv()`
 * (`util/upload-limit.ts#resolveUploadMaxBytes`) — deliberately NOT at this
 * module's top level: `app.ts` imports this module (transitively, via
 * `src/crowi`) before it calls `dotenv.config()`, so a module-load-time
 * `process.env` read would always see the value from BEFORE `.env` was
 * loaded in production. Resolving inside `registerAttachmentRoutes` (called
 * from `crowi.start()`, well after `dotenv.config()` has run) reads the
 * real value. `crowi.getEnv()` rather than `process.env` directly so a test
 * harness that constructs `Crowi` with its own merged env object is
 * honoured too.
 *
 * The MIME check is intent-independent: `paste` / `dnd` / the general
 * `addAttachment` route all check the same `UPLOAD_ALLOWED_MIME` allow-list
 * (see that constant's doc comment in `@crowi/api-contract` for why). The
 * size cap is intent-independent too.
 */
const UPLOAD_MIME_SET = new Set<string>(UPLOAD_ALLOWED_MIME);

const isUploadAllowedMime = (mimeType: string): boolean => UPLOAD_MIME_SET.has(mimeType);

/**
 * Profile pictures (`me.ts`'s `POST /me/picture`) get their own, narrower
 * policy instead of the general
 * `UPLOAD_ALLOWED_MIME` allow-list: a finite list of image types (derived
 * from `UPLOAD_ALLOWED_MIME`, not a second hand-written list that could
 * drift from it) and a size cap. `PROFILE_PICTURE_MAX_BYTES` matches the
 * client-side crop-dialog's pre-crop size guard
 * (`packages/web/src/app/(auth)/me/profile-picture.tsx`) — the value first
 * becomes meaningful server-side here, because a browser upload never
 * reaches the api before that crop downscales it, but CLI / curl / MCP
 * uploads skip the crop entirely.
 */
export const PROFILE_PICTURE_MAX_BYTES = 5 * 1024 * 1024;
// Typed `readonly string[]`, not the narrower literal-union array
// `.filter()` would otherwise infer: `me.ts` checks membership against an
// arbitrary resolved MIME string, not one of `UPLOAD_ALLOWED_MIME`'s
// literals.
export const PROFILE_PICTURE_ALLOWED_MIME: readonly string[] = UPLOAD_ALLOWED_MIME.filter((mime) => mime.startsWith('image/'));

/** The multipart default when a client sends no `Content-Type` for a part at all. */
const DEFAULT_UPLOAD_MIME = 'application/octet-stream';

/**
 * feature-attachment-mime-fallback — extension → MIME used ONLY to backfill
 * an upload's declared type when the client didn't send one. A Web `File`
 * cannot distinguish "no `Content-Type` was sent" from an explicit
 * declaration of `application/octet-stream` (both surface as
 * `file.type === ''` → `DEFAULT_UPLOAD_MIME` at `persistUploadToTmp`'s call
 * site), so `resolveEffectiveUploadMime` treats that default value as
 * "undeclared" and fills it in from the filename. MCP / curl / third-party
 * scripts routinely skip declaring a `Content-Type`, which used to store and
 * serve e.g. an uploaded `pixel.png` as a plain download.
 *
 * Deliberately NOT shared with `attachment-stream.ts`'s `KEY_EXT_TO_MIME` /
 * `INLINE_SAFE_MIME`. Those answer a different, intentionally narrow
 * question — which STORED types may be served *inline* — as part of the
 * attachment XSS boundary (see that file's doc comments). This table answers
 * "what kind of file is this" and is meant to grow as new upload types are
 * allow-listed; sharing it would let a future addition here silently widen
 * what may be delivered inline.
 *
 * Initial entries mirror `packages/cli/src/lib/media-type.ts`'s
 * `EXT_TO_MEDIA_TYPE` (not shared code — the CLI is a separate package with
 * its own reasons to declare a type). Keep in sync manually if either grows.
 *
 * Exported as the `extensionHints` field of `GET /attachments/upload-policy`,
 * and consumed by `me.ts` (see `resolveEffectiveUploadMime` below) so
 * profile-picture uploads resolve an undeclared type the same way. Still not
 * shared with `KEY_EXT_TO_MIME` / `INLINE_SAFE_MIME` for the reason above.
 */
export const UPLOAD_EXT_TO_MIME: Record<string, string> = {
  // Raster images — the types attachment delivery will serve inline.
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  apng: 'image/apng',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  // Documents / text.
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  // Office.
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // Archives.
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  // Audio / video.
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
};

/**
 * Resolve the effective upload MIME for `file`: the client's declared
 * `file.type` when it is anything other than `DEFAULT_UPLOAD_MIME`, otherwise
 * a best-effort guess from `file.name`'s last extension. An unknown/absent
 * extension — or a filename ending in a bare dot — still resolves to
 * `DEFAULT_UPLOAD_MIME`, exactly as before this helper existed: this only
 * replaces a wrong default with a better one, it never changes what may be
 * uploaded or how a stored attachment is delivered.
 *
 * Exported so `me.ts`'s profile-picture upload resolves the same effective
 * MIME (an undeclared `file.type` no longer defeats the picture-type gate
 * there either).
 */
export const resolveEffectiveUploadMime = (file: File): string => {
  const declared = file.type || DEFAULT_UPLOAD_MIME;
  if (declared !== DEFAULT_UPLOAD_MIME) return declared;

  const name = file.name || '';
  const dot = name.lastIndexOf('.');
  if (dot < 1 || dot === name.length - 1) return DEFAULT_UPLOAD_MIME;
  const ext = name.slice(dot + 1).toLowerCase();
  // `Object.hasOwn`, not a plain lookup: the map inherits from
  // `Object.prototype`, so a filename like `foo.constructor` would
  // otherwise resolve to a function and be declared as the MIME type — same
  // safe-lookup posture as the CLI's `mediaTypeForFilename`.
  return Object.hasOwn(UPLOAD_EXT_TO_MIME, ext) ? UPLOAD_EXT_TO_MIME[ext] : DEFAULT_UPLOAD_MIME;
};

/** Shared rejection wording — every route uses the exact same phrase (feature-attachment-upload-policy AC "拒否時のエラーコードと文言が全経路で統一されている"). */
const disallowedMimeMessage = (mimeType: string): string => `Files of type ${mimeType} cannot be uploaded.`;

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
 * RFC-0004 Phase 7 — extract attachment ObjectId hex strings referenced
 * by a revision body. Matches the current `/api/attachments/<id>` (the
 * `fileUrl` virtual / stream route), the legacy (pre-`/api/v2` → `/api`
 * cutover) `/api/v2/attachments/<id>` form, and the v1 `/files/<id>` form —
 * all three still present in bodies saved before their respective
 * migration/cutover. This dual-/triple-accept is additive and permanent:
 * removing an alternative would flip un-migrated existing references to
 * `inUse: false`, hiding them from `attachment-list.tsx`'s footer and
 * exposing a delete affordance for an attachment still referenced by the
 * current revision.
 */
const ATTACHMENT_URI_RE = /(?:\/api\/v2\/attachments\/|\/api\/attachments\/|\/files\/)([0-9a-f]{24})/gi;

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
    // feature-image-derivative-optimization Phase 2 §5 — `url` (canonical)
    // now resolves display-priority with original fallback (attachment-stream.ts);
    // `originalUrl` is the explicit always-original escape hatch. Both are
    // derived from the same `fileUrl` virtual, never stored.
    url: obj.fileUrl,
    originalUrl: `${obj.fileUrl}/original`,
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
    // feature-attachment-mime-fallback — an undeclared (or, indistinguishably,
    // explicitly `application/octet-stream`) type is backfilled from the
    // filename's extension so an unlabelled upload (MCP / curl / third-party
    // scripts) isn't stored and delivered as a plain download.
    mimetype: resolveEffectiveUploadMime(file),
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

/**
 * feature-image-derivative-optimization Phase 1 §8 — the single call site
 * both upload paths (footer add / editor paste-D&D) use to kick off
 * display-derivative generation, right after `Attachment.create` and
 * before the source tmp file is cleaned up. `oldFilePath` is always
 * `undefined` here: both callers just created a brand-new Attachment row,
 * so there is no prior `derivatives.display` to compare against.
 *
 * `generateDisplayDerivativeForUpload` is itself designed to never reject
 * (every failure mode — admission timeout, decode error, storage error,
 * anything unexpected — is classified, best-effort persisted as `mode:
 * 'failed'`, and swallowed). The `.catch()` here is defence-in-depth only,
 * so a bug in that guarantee can never turn into a failed upload response.
 */
const runDisplayDerivativeGeneration = async (crowi: Crowi, attachmentId: Types.ObjectId, pageId: Types.ObjectId, sourcePath: string): Promise<void> => {
  await generateDisplayDerivativeForUpload({ crowi, attachmentId, pageId, sourcePath, oldFilePath: undefined }).catch((err) => {
    debug('display derivative generation call failed unexpectedly', err);
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

/**
 * Bounded allowance added to the size limit when comparing against
 * `Content-Length`, which measures the WHOLE multipart body (boundary
 * delimiters, per-part headers, and any other form fields such as
 * `uploadAttachmentRoute`'s `pageId`) — not just the file payload the limit
 * is actually about. Without this, a file at EXACTLY the limit — which
 * `GET /attachments/upload-policy` told the client is allowed — would still
 * fail this precheck once framing pushes `Content-Length` past the raw
 * number. Deliberately generous relative to realistic multipart overhead
 * (a boundary string plus a handful of part headers is a few hundred bytes
 * at most) while staying negligible against a 50 MB memory budget: this
 * precheck only needs to reject requests that are unambiguously over
 * budget before `parseBody()` buffers them — the byte-exact enforcement is
 * the post-parse `file.size` check below, which never sees framing at all.
 */
const MULTIPART_OVERHEAD_ALLOWANCE_BYTES = 64 * 1024;

/**
 * Content-Length precheck as `method + routingPath`-scoped middleware,
 * installed via `app.on(...)` (the same pattern `applyScope` uses, see that
 * helper's doc comment) STRICTLY BEFORE `.openapi(route, handler)`
 * registers the route's generated multipart validator. That ordering is
 * load-bearing: `@hono/zod-openapi` installs a `zValidator('form', ...)`
 * ahead of the handler for any route whose schema declares a
 * `multipart/form-data` body, and that validator's underlying
 * `hono/validator` implementation calls `c.req.arrayBuffer()` — reading the
 * ENTIRE body into memory — before it ever runs the zod schema. A precheck
 * placed inside the handler itself would therefore only run AFTER the full
 * body had already been buffered, defeating the OOM guard entirely.
 * `tooLargeBody` is a thunk (not a plain value) so each call site can
 * supply its own route-specific error envelope.
 *
 * A request with no (or a malformed) `Content-Length` — e.g. chunked
 * transfer — is rejected too, not merely let through: this precheck exists
 * specifically to stop `parseBody()` from ever buffering an unbounded body,
 * and a request whose size cannot be bounded from its header is exactly
 * that. A real browser/CLI upload of a `File`/`Blob` always has a known
 * length and sends `Content-Length`; only a client deliberately avoiding it
 * hits this path.
 */
const rejectOversizedContentLength = (maxBytes: number, tooLargeBody: () => Record<string, unknown>) =>
  createMiddleware<CrowiHonoBindings>(async (c, next) => {
    const contentLengthHeader = c.req.header('content-length');
    const parsedLen = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : Number.NaN;
    if (!Number.isFinite(parsedLen) || parsedLen > maxBytes + MULTIPART_OVERHEAD_ALLOWANCE_BYTES) {
      return c.json(tooLargeBody(), 413);
    }
    await next();
  });

export const registerAttachmentRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(app: E, crowi: Crowi) => {
  const Attachment = crowi.model('Attachment');
  const Page = crowi.model('Page');
  const fileUploader = FileUploader(crowi);

  // Resolved here (not at module load, see the doc comment above
  // `UPLOAD_MIME_SET`) so `.env`-file operators actually take effect in
  // production. Read once per `registerAttachmentRoutes` call (once per
  // process in production) and closed over by every handler below.
  const uploadMaxBytes = resolveUploadMaxBytes(crowi.getEnv().CROWI_UPLOAD_MAX_BYTES);

  // One shared upload limiter per process.
  const uploadLimiter = createRateLimiter({
    name: 'attachment-upload',
    limit: UPLOAD_RATE_LIMIT,
    windowMs: UPLOAD_RATE_WINDOW_MS,
    redisClient: crowi.redis ?? null,
    keyspace: resolveRedisKeyspaceIfEnabled(crowi),
  });

  const uploadRateLimitMiddleware = withRateLimit({
    limiter: uploadLimiter,
    wireShape: 'attachment-upload-envelope',
    message: (retry) => `Upload limit reached. Try again in ${retry} seconds.`,
  });

  // `/attachments/*` is OUTSIDE the revision-owned `/pages/*` apply.
  // Install createAttachmentAuth broadly here; the rate limit is
  // per-endpoint (only `uploadAttachment` is throttled).
  app.use('/attachments/*', createAttachmentAuth(crowi));
  app.use('/attachments/upload', uploadRateLimitMiddleware);

  // RFC-0010 — attachment scopes.
  applyScope(app, getAttachmentUsageRoute, 'attachments:read');
  applyScope(app, listAttachmentsRoute, 'attachments:read');
  applyScope(app, getAttachmentMetaRoute, 'attachments:read');
  applyScope(app, addAttachmentRoute, 'attachments:write');
  applyScope(app, uploadAttachmentRoute, 'attachments:write');
  applyScope(app, removeAttachmentRoute, 'attachments:write');
  // Read-only, same scope as the other GET routes in this file
  // (`attachments:write` already implies it, so an upload-scoped CLI token
  // can read the policy it needs before uploading).
  applyScope(app, getUploadPolicyRoute, 'attachments:read');

  // Content-Length prechecks, installed the same way as the scope guards
  // above and for the same reason: they MUST run before `.openapi()`'s
  // generated multipart validator (see `rejectOversizedContentLength`'s doc
  // comment). The error envelope each route reports for a Content-Length
  // rejection matches the code its POST-PARSE size check reports
  // (`FILE_TOO_LARGE` / `too_large`) — the CLI and web clients key their
  // front-reverse-proxy discrimination off exactly that code, so both of a
  // route's 413 paths must agree on it.
  app.on(
    addAttachmentRoute.method,
    addAttachmentRoute.getRoutingPath(),
    rejectOversizedContentLength(uploadMaxBytes, () => errorBody('FILE_TOO_LARGE', `Request body exceeds the ${uploadMaxBytes}-byte upload limit`)),
  );
  app.on(
    uploadAttachmentRoute.method,
    uploadAttachmentRoute.getRoutingPath(),
    rejectOversizedContentLength(uploadMaxBytes, () => uploadErrorBody('too_large', 'The file is too large to upload.', { maxBytes: uploadMaxBytes })),
  );

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

        // The Content-Length hard ceiling runs BEFORE this handler, as
        // `rejectOversizedContentLength` middleware (registered above, in
        // `registerAttachmentRoutes`) — see its doc comment for why it
        // cannot live here (including why a missing/malformed
        // `Content-Length` is rejected there too, not just an over-limit
        // one).
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

        // Re-check the ACTUAL parsed size, not just the (spoofable smaller)
        // `Content-Length` header above.
        if (file.size > uploadMaxBytes) {
          return c.json(errorBody('FILE_TOO_LARGE', `File exceeds the ${uploadMaxBytes}-byte upload limit`), 413);
        }

        // feature-attachment-upload-policy — this route used to have NO
        // MIME check at all (only the editor's paste/dnd upload did),
        // which is exactly why the same file could upload here while
        // being rejected via drag-and-drop. Apply the same
        // `UPLOAD_ALLOWED_MIME` allow-list here so all three affordances
        // (attach button / paste / dnd) agree.
        // feature-attachment-mime-fallback — resolve the same effective MIME
        // the tmp-persist step below will independently compute for `file`
        // (pure/deterministic, so both calls agree), so the allow-list
        // decision and the value that ends up in `Attachment.fileFormat`
        // never diverge.
        const declaredType = resolveEffectiveUploadMime(file);
        if (!isUploadAllowedMime(declaredType)) {
          return c.json(errorBody('DISALLOWED_MIME', disallowedMimeMessage(declaredType)), 415);
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

          // Independent of each other — derivative generation writes to the
          // Attachment row via a separate `updateOne` (never mutates
          // `created` in memory) and `populate('creator')` only reads the
          // User collection, so running them concurrently shaves the
          // derivative-generation latency off the response without
          // changing what either produces.
          await Promise.all([runDisplayDerivativeGeneration(crowi, created._id, pageData._id, persisted.tmpPath), created.populate('creator')]);

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

        // The Content-Length precheck runs BEFORE this handler, as
        // `rejectOversizedContentLength` middleware (registered above, in
        // `registerAttachmentRoutes`) — see its doc comment for why it
        // cannot live here (including why a missing/malformed
        // `Content-Length` is rejected there too, not just an over-limit
        // one).
        let parsed: Record<string, string | File | (string | File)[]>;
        try {
          parsed = await c.req.parseBody();
        } catch (err) {
          debug('uploadAttachment parseBody error', err);
          return c.json(uploadErrorBody('disallowed_type', 'File upload error.'), 400);
        }

        // `intent` is not read: it is a client self-report, not a defence,
        // and the size cap is a single value regardless of it. Any `intent`
        // field an older client still sends is simply ignored (falls out of
        // `parsed` unread).
        const file = pickFile(parsed, 'file');
        const pageId = pickString(parsed, 'pageId') ?? '';

        if (!file) {
          return c.json(uploadErrorBody('disallowed_type', 'No file provided.'), 400);
        }
        if (!isValidObjectId(pageId)) {
          return c.json(uploadErrorBody('no_permission', 'A valid pageId is required.'), 400);
        }

        // The ACTUAL parsed size, checked against the single unified limit
        // regardless of intent (Content-Length can be spoofed smaller than
        // the real body — see the precheck above for the larger-body case).
        if (file.size > uploadMaxBytes) {
          return c.json(uploadErrorBody('too_large', 'The file is too large to upload.', { maxBytes: uploadMaxBytes }), 413);
        }
        // feature-attachment-mime-fallback — same helper as `addAttachment` /
        // `persistUploadToTmp`: an undeclared type is backfilled from the
        // filename so the allow-list check, the stored `fileFormat`, and the
        // response `mimeType` all agree.
        const fileType = resolveEffectiveUploadMime(file);
        if (!isUploadAllowedMime(fileType)) {
          // `DISALLOWED_MIME`, not the endpoint's usual lowercase
          // `disallowed_type` — a MIME-type rejection is required to carry
          // the SAME code and message as `addAttachment`'s 415 (cross-route
          // parity, feature-attachment-upload-policy). See the schema's
          // doc comment for why this one code intentionally breaks the
          // endpoint's own lowercase convention.
          return c.json(uploadErrorBody('DISALLOWED_MIME', disallowedMimeMessage(fileType), { mimeType: fileType }), 415);
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

          await runDisplayDerivativeGeneration(crowi, created._id, pageData._id, persisted.tmpPath);

          cleanupTmp(tmpPath);
          tmpPath = null;

          debug('editor upload ok', { pageId, attachmentId: created._id.toString() });
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
      // --------------------------------------------------------------
      // GET /attachments/upload-policy
      // --------------------------------------------------------------
      //
      // Every field below is READ from an existing constant, never
      // re-declared: copying a value here would recreate the
      // two-tables-that-must-agree problem this endpoint exists to remove.
      .openapi(getUploadPolicyRoute, async (c) => {
        return c.json(
          {
            allowedMimeTypes: [...UPLOAD_ALLOWED_MIME],
            extensionHints: { ...UPLOAD_EXT_TO_MIME },
            maxBytes: {
              attachment: uploadMaxBytes,
            },
            profilePicture: {
              allowedMimeTypes: [...PROFILE_PICTURE_ALLOWED_MIME],
              maxBytes: PROFILE_PICTURE_MAX_BYTES,
            },
          },
          200,
        );
      })
  );
};
