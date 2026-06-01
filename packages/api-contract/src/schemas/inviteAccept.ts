/**
 * Schemas for the public invite-acceptance flow. An admin invites a user
 * by email; the invitee receives a signed invite-token link and lands on
 * `(public)/invite/accept`, where they choose their own username / name /
 * password. On success the account flips from STATUS_INVITED to
 * STATUS_ACTIVE and the response carries login tokens (same shape as
 * `tokenAuth`), so the invitee is signed in immediately.
 */
import { z } from '@hono/zod-openapi';

export const InviteAcceptRequestSchema = z.object({
  token: z.string(),
  username: z.string().min(1),
  name: z.string().min(1),
  password: z.string().min(6),
});
export type InviteAcceptRequest = z.infer<typeof InviteAcceptRequestSchema>;

/** GET /invite/accept?token= — preview the invited email for the page header. */
export const InvitePreviewResponseSchema = z.object({
  email: z.string().email(),
});
export type InvitePreviewResponse = z.infer<typeof InvitePreviewResponseSchema>;
