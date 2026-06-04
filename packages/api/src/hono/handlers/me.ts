/**
 * RFC-0006 Phase 4 Batch 2 — `me` resource Hono port.
 *
 * Replaces `packages/api/src/routes/ts-rest/me.ts`. Eight endpoints,
 * all behind `createJwtAuth(crowi)` applied broadly to `/me/*`:
 *
 *   GET    /me                       — profile
 *   PUT    /me                       — update profile
 *   POST   /me/picture               — upload picture (Hono-native multipart)
 *   DELETE /me/picture               — clear picture
 *   PUT    /me/password              — change password
 *   GET    /me/recently-viewed-pages — recently-viewed pages (capped at 5)
 *
 * Personal access token management (RFC-0010, replacing the legacy
 * `GET/POST /me/apiToken`) lives in `./access-token.ts`.
 *
 * Wire-format parity is preserved with the ts-rest era. Notable points:
 *
 *  - Picture upload uses `c.req.parseBody()` (no multer). Discovery doc
 *    §5 designated all 3 multipart endpoints as Hono-native; me/picture
 *    is the first to move. The temporary file is written to
 *    `crowi.tmpDir` so the existing `FileUploader` pipeline (streams
 *    from disk) remains unchanged. Size precheck via the
 *    `content-length` header is unnecessary here — profile pictures are
 *    typically <1 MB and the multipart parser already buffers them.
 *  - Password change preserves the legacy "6-character minimum on
 *    `oldPassword`" guard for backwards compatibility with users who
 *    set their password before the bcrypt migration; new-password
 *    validation lives in the Zod schema.
 *  - `recentlyViewedPages` reads `crowi.lru.get(userId, 6)` (6 entries
 *    to absorb at most one root-portal entry, then truncates to 5).
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, createWriteStream, createReadStream, unlink } from 'node:fs';
import path from 'node:path';

import {
  getProfileRoute,
  recentlyViewedPagesRoute,
  updatePasswordRoute,
  updateProfileRoute,
  uploadPictureRoute,
  deletePictureRoute,
} from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import Debug from 'debug';

import type Crowi from 'src/crowi';
import type { PageDocument } from 'src/models/page';
import type { UserDocument } from 'src/models/user';
import FileUploader from 'src/util/fileUploader';
import { mapDuplicateKeyError } from 'src/util/map-duplicate-key-error';
import { createMailTokenUtil } from 'src/util/mail-token';
import { pageToResponse } from 'src/util/page-response';

import type { CrowiHonoBindings } from '../app';
import { createJwtAuth } from '../middleware/auth';
import { applyScope } from '../middleware/require-scope';

const debug = Debug('crowi:hono:handlers:me');

// Profile schema declares `image: z.string().nullable()` (Mongoose
// `null | string`), so we forward `user.image` verbatim — no
// `toUserImage` coercion. Only token endpoints, where the schema is
// `z.string().optional()`, need `null → undefined`.
const userToProfileResponse = (user: UserDocument, hasPassword: boolean, emailChangePending?: boolean) => ({
  id: user._id.toString(),
  username: user.username,
  name: user.name,
  email: user.email,
  lang: user.lang,
  image: user.image,
  introduction: user.introduction || undefined,
  googleId: user.googleId,
  githubId: user.githubId,
  hasPassword,
  createdAt: user.createdAt.toISOString(),
  ...(emailChangePending ? { emailChangePending: true } : {}),
});

const extractMongooseErrors = (err: unknown, fallback: string): string[] => {
  const error = err as { errors?: Record<string, { message: string }> };
  if (error.errors) {
    const messages = Object.values(error.errors).map((e) => e.message);
    if (messages.length > 0) return messages;
  }
  return [fallback];
};

/**
 * Drain a Web `File` (returned by `c.req.parseBody()`) to a temp file on
 * disk. The legacy multer pipeline returns a path + mimetype the rest
 * of `FileUploader` consumes via a `fs.createReadStream`; mirror that
 * shape so the downstream code stays unchanged.
 */
const persistUploadToTmp = async (file: File, tmpDir: string): Promise<{ tmpPath: string; mimetype: string; originalname: string }> => {
  mkdirSync(tmpDir, { recursive: true });
  // 32-hex-char random suffix; collision-resistant for concurrent uploads.
  const randomId = `${Date.now()}-${randomBytes(16).toString('hex')}`;
  const tmpPath = path.join(tmpDir, randomId);

  await new Promise<void>((resolve, reject) => {
    const stream = createWriteStream(tmpPath);
    stream.on('finish', () => resolve());
    stream.on('error', (err) => reject(err));
    Promise.resolve(file.arrayBuffer())
      .then((buf) => {
        stream.end(Buffer.from(buf));
      })
      .catch((err) => {
        stream.destroy(err as Error);
        reject(err);
      });
  });

  return {
    tmpPath,
    mimetype: file.type || 'application/octet-stream',
    originalname: file.name || randomId,
  };
};

const cleanupTmp = (tmpPath: string): void => {
  unlink(tmpPath, (err) => {
    if (err) debug('Error while deleting tmp file:', err);
  });
};

export const registerMeRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(app: E, crowi: Crowi) => {
  const User = crowi.model('User');
  const Page = crowi.model('Page');

  // Every `/me/*` endpoint requires auth. Install the middleware before
  // `.openapi(...)` so the path matcher sees the route (consistent with
  // Batch 1's per-path approach but applied broadly because every route
  // in this group needs the same guard).
  app.use('/me/*', createJwtAuth(crowi));

  // RFC-0010 — profile scopes. PAT management (`/me/access-tokens`) is
  // web-session only and registered in `./access-token.ts`, so it carries
  // no scope guard here.
  applyScope(app, getProfileRoute, 'profile:read');
  applyScope(app, recentlyViewedPagesRoute, 'profile:read');
  applyScope(app, updateProfileRoute, 'profile:write');
  applyScope(app, uploadPictureRoute, 'profile:write');
  applyScope(app, deletePictureRoute, 'profile:write');
  applyScope(app, updatePasswordRoute, 'profile:write');

  return app
    .openapi(getProfileRoute, async (c) => {
      const user = c.get('user');
      const userWithSecrets = await user.populateSecrets();
      const hasPassword = userWithSecrets.isPasswordSet();
      return c.json(userToProfileResponse(user, hasPassword), 200);
    })
    .openapi(updateProfileRoute, async (c) => {
      const user = c.get('user');
      const { name, email, lang } = c.req.valid('json').userForm;

      if (!User.isEmailValid(email)) {
        return c.json(
          {
            status: 'error' as const,
            code: 'EMAIL_NOT_ALLOWED' as const,
            message: "You can't update to that email address",
            errors: ["You can't update to that email address"],
          },
          400,
        );
      }

      const existing = await User.findOne({ email });
      if (existing && !existing._id.equals(user._id)) {
        debug('Email address was duplicated');
        return c.json(
          {
            status: 'error' as const,
            code: 'EMAIL_TAKEN' as const,
            message: 'It can not be changed to that mail address',
            errors: ['It can not be changed to that mail address'],
          },
          400,
        );
      }

      try {
        // Email changes are not applied immediately — they require the
        // user to confirm control of the new address via an emailed link.
        // Name / lang apply right away.
        const emailChangeRequested = email !== user.email;
        user.name = name;
        user.lang = lang;
        await user.save();

        if (emailChangeRequested) {
          const mailer = crowi.getMailer();
          const baseUrl = crowi.getBaseUrl() || '';
          // Bind the token to the CURRENT email so it is single-use: once
          // the address changes, a stale token (whose fromEmail no longer
          // matches) is rejected and cannot revert the address later.
          const { token } = createMailTokenUtil().signMailToken({ purpose: 'email-change', userId: user._id.toString(), email, fromEmail: user.email });
          const confirmUrl = `${baseUrl}/confirm-email?token=${token}`;
          // Fire-and-forget: do not block the profile response on SMTP.
          void mailer
            .send({ to: email, htmlTemplate: 'emailChange', lang: user.lang, vars: { ...mailer.brandVars(), confirmUrl, newEmail: email } })
            // Best-effort: the address simply stays unchanged on failure.
            .catch((err) => debug('failed to send email-change confirmation:', err));
        }

        const userWithSecrets = await user.populateSecrets();
        const hasPassword = userWithSecrets.isPasswordSet();
        return c.json(userToProfileResponse(user, hasPassword, emailChangeRequested), 200);
      } catch (err) {
        // The email findOne pre-check can be raced; the unique index is the
        // final defence. Map its E11000 to EMAIL_TAKEN (the same code the
        // pre-check returns) instead of a generic validation error.
        if (mapDuplicateKeyError(err) === 'EMAIL_TAKEN') {
          return c.json(
            {
              status: 'error' as const,
              code: 'EMAIL_TAKEN' as const,
              message: 'It can not be changed to that mail address',
              errors: ['It can not be changed to that mail address'],
            },
            400,
          );
        }
        const errors = extractMongooseErrors(err, 'Failed to update profile');
        return c.json({ status: 'error' as const, message: errors[0], errors }, 400);
      }
    })
    .openapi(uploadPictureRoute, async (c) => {
      const user = c.get('user');

      let parsed: Record<string, string | File | (string | File)[]>;
      try {
        parsed = await c.req.parseBody();
      } catch (err) {
        debug('parseBody error:', err);
        return c.json({ status: 'error' as const, message: 'File upload error.', errors: ['File upload error.'] }, 400);
      }

      const fileField = parsed['file'];
      const file =
        fileField instanceof File ? fileField : Array.isArray(fileField) ? fileField.find((entry): entry is File => entry instanceof File) : undefined;

      if (!file) {
        return c.json({ status: 'error' as const, message: 'No file provided.', errors: ['No file provided.'] }, 400);
      }

      if (!/^image\/.+/.test(file.type || '')) {
        return c.json(
          {
            status: 'error' as const,
            message: 'File type error. Only image files is allowed to set as user picture.',
            errors: ['File type error. Only image files is allowed to set as user picture.'],
          },
          400,
        );
      }

      const fileUploader = FileUploader(crowi);
      let tmpPath: string | null = null;

      try {
        const persisted = await persistUploadToTmp(file, crowi.tmpDir);
        tmpPath = persisted.tmpPath;

        // Match the legacy `tmpFile.filename + tmpFile.originalname` shape so
        // `createUserPictureFilePath` infers the same extension as before.
        const combined = path.basename(persisted.tmpPath) + persisted.originalname;
        const ext = combined.match(/(.*)(?:\.([^.]+$))/)?.[2] || '';
        const filePath = User.createUserPictureFilePath(user, ext);

        const tmpFileStream = createReadStream(persisted.tmpPath, {
          flags: 'r',
          mode: 0o666,
          autoClose: true,
        });

        await fileUploader.uploadFile(filePath, persisted.mimetype, tmpFileStream, {});
        // Persist the STABLE proxy URL, not a signed one: `user.image`
        // is stored in the DB and served verbatim, so a time-limited
        // S3 signed URL would 403 once its (5-minute) TTL elapsed.
        const imageUrl = fileUploader.persistentUrl(filePath);

        await new Promise<void>((resolve, reject) => {
          user.updateImage(imageUrl, (err: Error | null) => {
            if (err) reject(err);
            else resolve();
          });
        });

        cleanupTmp(persisted.tmpPath);
        tmpPath = null;

        return c.json({ status: true, url: imageUrl, message: '' }, 200);
      } catch (err) {
        debug('Uploading error:', err);
        if (tmpPath) cleanupTmp(tmpPath);
        return c.json(
          {
            status: 'error' as const,
            message: 'Error while uploading file',
            errors: ['Error while uploading file'],
          },
          400,
        );
      }
    })
    .openapi(deletePictureRoute, async (c) => {
      const user = c.get('user');

      return new Promise((resolve) => {
        // TODO: Also delete from S3/storage. Mirrors the ts-rest TODO.
        user.deleteImage((err: Error | null) => {
          if (err) {
            debug('Error deleting image:', err);
            resolve(
              c.json(
                {
                  status: 'error' as const,
                  message: 'Failed to delete profile picture',
                  errors: ['Failed to delete profile picture'],
                },
                400,
              ),
            );
            return;
          }
          resolve(c.json({ status: 'ok' as const, message: 'Deleted profile picture' }, 200));
        });
      });
    })
    .openapi(updatePasswordRoute, async (c) => {
      const user = c.get('user');
      const { oldPassword, newPassword } = c.req.valid('json');

      if (!user.isEmailSet()) {
        return c.json(
          {
            status: 'error' as const,
            message: 'Email must be set before setting password',
            errors: ['Email must be set before setting password'],
          },
          400,
        );
      }

      const userWithSecrets = await user.populateSecrets();
      const hasPassword = userWithSecrets.isPasswordSet();

      if (hasPassword) {
        if (!oldPassword) {
          return c.json(
            {
              status: 'error' as const,
              message: 'Current password is required',
              errors: ['Current password is required'],
            },
            400,
          );
        }
        if (oldPassword.length < 6) {
          return c.json(
            {
              status: 'error' as const,
              message: 'Current password must be at least 6 characters',
              errors: ['Current password must be at least 6 characters'],
            },
            400,
          );
        }
        if (!userWithSecrets.isPasswordValid(oldPassword)) {
          return c.json(
            {
              status: 'error' as const,
              message: 'Wrong current password',
              errors: ['Wrong current password'],
            },
            400,
          );
        }
      }

      return new Promise((resolve) => {
        userWithSecrets.updatePassword(newPassword, (err: Error | null) => {
          if (err) {
            debug('Error updating password:', err);
            const errors = extractMongooseErrors(err, 'Failed to update password');
            resolve(c.json({ status: 'error' as const, message: errors[0] || 'Failed to update password', errors }, 400));
            return;
          }
          // Security notification — best-effort, never fails the change.
          void crowi
            .getMailer()
            .sendPasswordChangedNotice(user.email, user.lang)
            .catch((mailErr) => debug('failed to send password-changed notice:', mailErr));
          resolve(c.json({ status: 'ok' as const, message: 'Password updated' }, 200));
        });
      });
    })
    .openapi(recentlyViewedPagesRoute, async (c) => {
      const user = c.get('user');
      try {
        // Read 6 to absorb at most one root-portal entry; the dropdown
        // shows 5. Same logic as the ts-rest handler.
        const ids: string[] = (await crowi.lru.get(user._id.toString(), 6)) ?? [];
        if (ids.length === 0) {
          return c.json({ pages: [] }, 200);
        }

        const found = (await Page.findPagesByIds(ids)) as PageDocument[];
        const byId = new Map<string, PageDocument>();
        for (const p of found) byId.set(p._id.toString(), p);

        const ordered: PageDocument[] = [];
        for (const id of ids) {
          const p = byId.get(id);
          if (!p || p.path === '/') continue;
          ordered.push(p);
          if (ordered.length >= 5) break;
        }

        return c.json({ pages: ordered.map((p) => pageToResponse(p)) }, 200);
      } catch (err) {
        debug('recentlyViewedPages: lru / populate failed: %s', (err as Error).message);
        // Legacy parity: surface lru/populate errors as an empty list
        // rather than a 5xx so the dropdown UI degrades gracefully.
        return c.json({ pages: [] }, 200);
      }
    });
};
