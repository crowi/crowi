import { z } from '@hono/zod-openapi';

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

/**
 * Server → client message: a new revision was saved for the page being
 * viewed (feature-live-page-content-sync, RFC-0003 §v2.1 read-side
 * soft-refresh). Rides the same `/presence/<pageId>` channel as the
 * viewer-list broadcast so no second WebSocket is opened.
 *
 * The payload deliberately carries only *identity* — `pageId`,
 * `revisionId`, and who saved it — never the body or `renderedAst`.
 * Shipping the body over the presence channel would leak a private
 * page's content to every connected viewer socket; instead the client
 * fetches the new revision from the permission-checked
 * `GET /pages/revisions/{id}` endpoint (404 when grant is missing), so
 * body access stays gated by the same authorization as a normal read.
 *
 *   - `revisionId`       — the newly-saved revision's `_id`; the client
 *                          fetches its body to swap the content in place.
 *   - `editorUserId`     — who saved. The client suppresses its own
 *                          saves (`editorUserId === selfUserId`).
 *   - `editorDisplayName`— shown in the "updated by …" banner.
 */
export const PresencePageUpdatedMessageSchema = z.object({
  type: z.literal('page-updated'),
  pageId: z.string(),
  revisionId: z.string(),
  editorUserId: z.string(),
  editorDisplayName: z.string(),
});
export type PresencePageUpdatedMessage = z.infer<typeof PresencePageUpdatedMessageSchema>;

/**
 * Discriminated union of every server → client presence frame. The
 * client parses inbound frames with this and switches on `type`:
 * `'viewers'` drives the live-presence row, `'page-updated'` drives the
 * read-side soft-refresh banner.
 */
export const PresenceServerMessageSchema = z.discriminatedUnion('type', [PresenceViewersMessageSchema, PresencePageUpdatedMessageSchema]);
export type PresenceServerMessage = z.infer<typeof PresenceServerMessageSchema>;

/**
 * RFC-0005 Phase 3 — `GET /api/v2/pages/:id/likers`.
 *
 * A single entry in the "liked by" list. Sourced from the page's
 * `liker` ObjectId array (the authoritative set of who liked the
 * page); the per-user `likedAt` is a best-effort enrichment from the
 * `ACTION_LIKE` Activity record and is `null` when no Activity row
 * exists (e.g. likes recorded before activity logging, or a stale
 * Activity row that was pruned).
 */
export const LikerSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  likedAt: z.string().nullable(),
});
export type Liker = z.infer<typeof LikerSchema>;

/**
 * Response body of `GET /api/v2/pages/:id/likers`.
 *
 *   - `users`      — the liker list, newest-liked first when `likedAt`
 *                    is known (entries without a timestamp sort last).
 *   - `totalCount` — the full size of `page.liker`, independent of the
 *                    `limit` cap so the chip count stays accurate.
 */
export const LikersResponseSchema = z.object({
  users: z.array(LikerSchema),
  totalCount: z.number().int().nonnegative(),
});
export type LikersResponse = z.infer<typeof LikersResponseSchema>;

/** Query schema of `GET /api/v2/pages/:id/likers`. */
export const GetLikersRequestSchema = z.object({
  // Optional cap on returned `users`. `totalCount` always reflects the
  // full count regardless of `limit`. Omit for the full list.
  limit: z.coerce.number().int().positive().optional(),
});
export type GetLikersRequest = z.infer<typeof GetLikersRequestSchema>;
