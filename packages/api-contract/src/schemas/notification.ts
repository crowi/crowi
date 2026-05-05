import { z } from 'zod';
import { PageSchema, PagerSchema } from './page';
import { UserPublicSchema } from './userPublic';

// Notification status enum - matches Notification model constants
// (apps/crowi-api/src/models/notification.ts)
export const NotificationStatusSchema = z.enum(['UNREAD', 'UNOPENED', 'OPENED']);
export const NotificationStatusEnum = {
  UNREAD: 'UNREAD',
  UNOPENED: 'UNOPENED',
  OPENED: 'OPENED',
} as const;
export type NotificationStatus = z.infer<typeof NotificationStatusSchema>;

// Notification action enum - matches activityDefine.ts
// Currently only COMMENT and LIKE are supported on the server side
// (CREATE / MODIFY / DELETE are reserved but not yet wired up)
export const NotificationActionSchema = z.enum(['COMMENT', 'LIKE']);
export const NotificationActionEnum = {
  COMMENT: 'COMMENT',
  LIKE: 'LIKE',
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
