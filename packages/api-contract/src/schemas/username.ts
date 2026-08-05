import { z } from '@hono/zod-openapi';

/**
 * The single username syntax contract shared by every write path that can
 * set a `username`: self-registration (`TokenAuthRegisterRequestSchema`),
 * invite acceptance (`InviteAcceptRequestSchema`), first-admin creation
 * (`CreateAdminRequestSchema`), and the `User` Mongoose model's own field
 * validator (`packages/api/src/models/user.ts`). No `trim()`, case
 * folding, or Unicode normalization: any of those would silently rewrite
 * the stored value away from what the caller sent, which would disagree
 * with the existing case-insensitive unique collation
 * (`USER_UNIQUE_COLLATION`) and with already-stored data.
 *
 * The allowed set — ASCII `[A-Za-z0-9_-]`, 1-64 characters — matches the
 * mention renderer's `MENTION_RE` exactly
 * (`packages/api/src/renderer/core/mentions.ts`), so a stored username is
 * always a syntactically valid `@mention` target. `.` is deliberately not
 * allowed even though the installer's previous regex permitted it — that
 * was an existing inconsistency this contract removes.
 */
export const UsernameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'username may only contain letters, digits, hyphens, and underscores');

export type Username = z.infer<typeof UsernameSchema>;
