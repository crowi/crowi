import { z } from 'zod';

/**
 * RFC-0005 shared schemas for the page-presence feature ("who is
 * viewing this page right now").
 *
 * Two surfaces are described here:
 *
 *   - the HTTP `GET /api/v2/pages/:id/presence-token` response
 *     (`PresenceTokenResponseSchema` / `PresenceTokenPayloadSchema`),
 *   - the WebSocket `/presence/:pageId` message envelope
 *     (`PresenceClientMessageSchema` / `PresenceServerMessageSchema`).
 *
 * Kept disjoint from `collab.ts` because presence is its own
 * lightweight WebSocket channel — page viewers connect to `/presence`
 * without ever loading Yjs. The presence token is signed by a
 * *separate* issuer (`crowi-presence`) so a leaked collab wsToken can
 * never be replayed against the presence channel and vice versa.
 */

/**
 * Response body of `GET /api/v2/pages/:id/presence-token`.
 *
 *   - `token`      — short-lived JWT (5 min) the browser presents on
 *                    the `/presence/:pageId?token=` WebSocket connect.
 *   - `pageId`     — the page id this token is scoped to (mirrors the
 *                    request param; clients use it to detect misroute).
 *   - `selfUserId` — the requesting user's `_id`, so the client can
 *                    identify itself ("(you)") in the viewer list.
 *   - `expiresAt`  — ISO 8601 timestamp; clients refresh proactively
 *                    before the WebSocket would otherwise be torn down.
 */
export const PresenceTokenResponseSchema = z.object({
  token: z.string(),
  pageId: z.string(),
  selfUserId: z.string(),
  expiresAt: z.string(),
});
export type PresenceTokenResponse = z.infer<typeof PresenceTokenResponseSchema>;

/**
 * Decoded payload of the short-lived presence token JWT. The api signs
 * this with `WS_TOKEN_SECRET` (same secret as the collab wsToken, but a
 * distinct `iss` claim) and the `/presence` WebSocket handler verifies
 * it on connect.
 */
export const PresenceTokenPayloadSchema = z.object({
  userId: z.string(),
  pageId: z.string(),
  iat: z.number().int(),
  exp: z.number().int(),
});
export type PresenceTokenPayload = z.infer<typeof PresenceTokenPayloadSchema>;

/**
 * A single viewer entry in the server → client viewer-list broadcast.
 *
 *   - `isEditing` is NOT stored in the presence Redis hash — it is
 *     derived at broadcast time by joining the viewer set with the
 *     RFC-0003 editor-cap Set (`crowi:collab:editors:<pageId>`).
 *   - `joinedAt` is an epoch-millis timestamp; the client uses it for
 *     stable ordering of avatars.
 */
export const PresenceViewerSchema = z.object({
  userId: z.string(),
  username: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  isEditing: z.boolean(),
  joinedAt: z.number().int(),
});
export type PresenceViewer = z.infer<typeof PresenceViewerSchema>;

/**
 * Client → server message. The only message a presence client sends is
 * a periodic heartbeat (every 15s) that refreshes the Redis TTL for
 * its viewer entry.
 */
export const PresenceHeartbeatMessageSchema = z.object({
  type: z.literal('heartbeat'),
});
export type PresenceHeartbeatMessage = z.infer<typeof PresenceHeartbeatMessageSchema>;

export const PresenceClientMessageSchema = PresenceHeartbeatMessageSchema;
export type PresenceClientMessage = z.infer<typeof PresenceClientMessageSchema>;

/**
 * Server → client message: the full viewer list for the page. The
 * server pushes the complete list on every change (join / leave /
 * isEditing toggle); for typical sizes (< 50 viewers) full broadcasts
 * are cheaper than diffs and avoid state-sync bugs.
 */
export const PresenceViewersMessageSchema = z.object({
  type: z.literal('viewers'),
  viewers: z.array(PresenceViewerSchema),
});
export type PresenceViewersMessage = z.infer<typeof PresenceViewersMessageSchema>;

export const PresenceServerMessageSchema = PresenceViewersMessageSchema;
export type PresenceServerMessage = z.infer<typeof PresenceServerMessageSchema>;
