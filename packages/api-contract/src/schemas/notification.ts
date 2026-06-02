import { z } from '@hono/zod-openapi';
import { PageSchema, PagerSchema } from './page';
import { UserPublicSchema } from './userPublic';

// Notification status enum - matches Notification model constants
// (packages/api/src/models/notification.ts)
export const NotificationStatusSchema = z.enum(['UNREAD', 'UNOPENED', 'OPENED']);
export const NotificationStatusEnum = {
  UNREAD: 'UNREAD',
  UNOPENED: 'UNOPENED',
  OPENED: 'OPENED',
} as const;
export type NotificationStatus = z.infer<typeof NotificationStatusSchema>;

// Notification action enum - matches activityDefine.ts
// COMMENT / LIKE / MENTION / UPDATE are wired on the server side
// (CREATE / MODIFY / DELETE are reserved but not yet emitted).
// MENTION is dispatched by RFC-0002 Phase 8 mention-dispatch listener.
// UPDATE is fanned out to watchers on a page body revision
// (feature-page-update-notification).
export const NotificationActionSchema = z.enum(['COMMENT', 'LIKE', 'MENTION', 'UPDATE']);
export const NotificationActionEnum = {
  COMMENT: 'COMMENT',
  LIKE: 'LIKE',
  MENTION: 'MENTION',
  UPDATE: 'UPDATE',
} as const;
export type NotificationAction = z.infer<typeof NotificationActionSchema>;

// Notification target model enum - currently only Page is supported
export const NotificationTargetModelSchema = z.enum(['Page']);
export const NotificationTargetModelEnum = {
  PAGE: 'Page',
} as const;
export type NotificationTargetModel = z.infer<typeof NotificationTargetModelSchema>;

// Lightweight Page reference for notification payloads.
// The legacy controller populates the full Page document, but the UI only needs
// _id / path / status to render the link. Sending the full Page schema would
// bloat list responses considerably, so we derive a minimal projection here.
export const PageRefSchema = PageSchema.pick({
  _id: true,
  path: true,
  status: true,
});
export type PageRef = z.infer<typeof PageRefSchema>;

// Notification schema - matches NotificationDocument shape with target populated
// to a lightweight PageRef and actionUsers virtual resolved to UserPublicSchema[].
export const NotificationSchema = z.object({
  _id: z.string(),
  user: z.string(),
  targetModel: NotificationTargetModelSchema,
  target: PageRefSchema,
  action: NotificationActionSchema,
  status: NotificationStatusSchema,
  actionUsers: z.array(UserPublicSchema),
  createdAt: z.string(),
});
export type Notification = z.infer<typeof NotificationSchema>;

// GET /notifications?limit&offset
export const ListNotificationsRequestSchema = z.object({
  limit: z.coerce.number().optional().default(10),
  offset: z.coerce.number().optional().default(0),
});
export type ListNotificationsRequest = z.infer<typeof ListNotificationsRequestSchema>;

// GET /notifications response - paginated list with bookmark-style pager
export const ListNotificationsResponseSchema = z.object({
  notifications: z.array(NotificationSchema),
  pager: PagerSchema,
});
export type ListNotificationsResponse = z.infer<typeof ListNotificationsResponseSchema>;

// POST /notifications/read
export const MarkAllAsReadResponseSchema = z.object({
  ok: z.literal(true),
});
export type MarkAllAsReadResponse = z.infer<typeof MarkAllAsReadResponseSchema>;

// POST /notifications/:id/open
export const OpenNotificationParamSchema = z.object({
  id: z.string(),
});
export type OpenNotificationParam = z.infer<typeof OpenNotificationParamSchema>;

export const OpenNotificationResponseSchema = z.object({
  notification: NotificationSchema,
});
export type OpenNotificationResponse = z.infer<typeof OpenNotificationResponseSchema>;

// GET /notifications/status
export const NotificationStatusResponseSchema = z.object({
  count: z.number(),
});
export type NotificationStatusResponse = z.infer<typeof NotificationStatusResponseSchema>;

// Errors specific to notification
export const NotificationNotFoundErrorSchema = z.object({
  error: z.object({
    code: z.literal('NOTIFICATION_NOT_FOUND'),
    message: z.literal('Notification not found'),
  }),
});
export type NotificationNotFoundError = z.infer<typeof NotificationNotFoundErrorSchema>;

/**
 * Response body of `GET /api/v2/notifications/token`.
 *
 * Used by the browser to authenticate the `/notifications/<userId>` WebSocket
 * handshake that fans out per-user notification invalidation signals
 * (the spec's "data is still fetched via REST, only the *invalidation
 * signal* is pushed" design). Same shape as `PresenceTokenResponse`
 * minus the page scoping — notifications are scoped to the requesting
 * user instead.
 *
 *   - `token`      — short-lived JWT (60s) the browser presents on the
 *                    WebSocket connect (`?token=<jwt>`).
 *   - `selfUserId` — the requesting user's `_id`. The handshake rejects
 *                    a token whose `selfUserId` does not match the
 *                    `/notifications/<userId>` path segment.
 *   - `expiresAt`  — ISO 8601 timestamp; clients refresh proactively
 *                    before the WebSocket would otherwise be torn down.
 */
export const NotificationsTokenResponseSchema = z.object({
  token: z.string(),
  selfUserId: z.string(),
  expiresAt: z.string(),
});
export type NotificationsTokenResponse = z.infer<typeof NotificationsTokenResponseSchema>;

/**
 * Decoded payload of the short-lived notifications token JWT. The api
 * signs this with `WS_TOKEN_SECRET` (shared with collab + presence) but
 * uses a distinct `iss` claim (`crowi-notifications`) so a leaked
 * collab/presence token can never be replayed against the notifications
 * channel and vice versa.
 */
export const NotificationsTokenPayloadSchema = z.object({
  selfUserId: z.string(),
  // Random UUID mixed into every signed token so two tokens minted
  // within the same second still produce byte-different JWT strings.
  // The browser uses the token as a React effect dependency to drive
  // the WebSocket reconnect — without `jti`, the iat/exp pair is
  // identical at second granularity and the dep stays stable.
  jti: z.string().uuid(),
  iat: z.number().int(),
  exp: z.number().int(),
});
export type NotificationsTokenPayload = z.infer<typeof NotificationsTokenPayloadSchema>;

/**
 * Server → client message on `/notifications/<userId>`. The only
 * message kind is a `changed` signal — the browser uses it to invalidate
 * its `notificationKeys.all` react-query cache, then re-fetches via the
 * existing REST endpoints. The payload itself carries no notification
 * data, keeping the message size constant regardless of unread count.
 */
export const NotificationsChangedMessageSchema = z.object({
  type: z.literal('changed'),
});
export type NotificationsChangedMessage = z.infer<typeof NotificationsChangedMessageSchema>;

export const NotificationsServerMessageSchema = NotificationsChangedMessageSchema;
export type NotificationsServerMessage = z.infer<typeof NotificationsServerMessageSchema>;
