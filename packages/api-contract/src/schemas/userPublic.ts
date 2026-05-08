import { z } from 'zod';

/**
 * Mirror of the User model's status constants (`apps/crowi-api/src/models/user.ts`):
 *   1 REGISTERED, 2 ACTIVE, 3 SUSPENDED, 4 DELETED, 5 INVITED.
 *
 * Lives here (not in `./user`) to avoid a circular import with bookmark.ts.
 */
export const UserPublicStatus = {
  REGISTERED: 1,
  ACTIVE: 2,
  SUSPENDED: 3,
  DELETED: 4,
  INVITED: 5,
} as const;

const UserPublicStatusSchema = z.nativeEnum(UserPublicStatus);

// Public user schema - minimal user information for public display
// Based on UserDocument fields that are safe to expose publicly
// Extracted into its own file to avoid circular imports between
// user.ts and bookmark.ts (BookmarkSchema needs UserPublicSchema, and
// some user-scoped responses need BookmarkSchema).
export const UserPublicSchema = z.object({
  _id: z.string(),
  id: z.string().optional(), // for compatibility (virtual field)
  username: z.string(),
  name: z.string(),
  email: z.string().email(),
  image: z.string().nullable().optional(),
  introduction: z.string().optional(),
  createdAt: z.string(),
  admin: z.boolean().optional(),
  status: UserPublicStatusSchema.optional(),
});
export type UserPublic = z.infer<typeof UserPublicSchema>;
