import { z } from 'zod';

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
  status: z.number().optional(),
});
export type UserPublic = z.infer<typeof UserPublicSchema>;
