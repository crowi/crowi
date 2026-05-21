/**
 * RFC-0006 Phase 4 Batch 3 — `notification` resource ported to
 * `@hono/zod-openapi` route definitions. Four endpoints:
 *
 *   GET  /notifications            — paginated list for the current user
 *   POST /notifications/read       — mark all UNREAD as UNOPENED
 *   POST /notifications/{id}/open  — open one notification (set OPENED)
 *   GET  /notifications/status     — unread count for the current user
 *
 * All endpoints require JWT authentication. The Hono handler applies
 * `createJwtAuth(crowi)` broadly to `/notifications/*` so `c.get('user')`
 * is populated. `markAllAsRead` and `openNotification` accept an empty
 * body — we declare the schema as `z.unknown()` so Express body-parser's
 * `{}`-on-empty-POST hydration validates cleanly (legacy parity).
 *
 * `/notifications/status` is registered BEFORE `/notifications/{id}/open`
 * in the runtime handler chain so the literal `status` path wins over
 * the `{id}` template — same idiom as the revision routes.
 */
import { createRoute, z } from '@hono/zod-openapi';

import { AuthenticationRequiredErrorSchema, InternalServerErrorSchema } from '../schemas/common';
import {
  ListNotificationsRequestSchema,
  ListNotificationsResponseSchema,
  MarkAllAsReadResponseSchema,
  NotificationNotFoundErrorSchema,
  NotificationStatusResponseSchema,
  OpenNotificationParamSchema,
  OpenNotificationResponseSchema,
} from '../schemas/notification';

// 400 envelope for malformed notification id (parity with the ts-rest
// handler which returned `INVALID_REQUEST`). Declared inline because no
// other notification endpoint reuses this shape.
const NotificationInvalidRequestErrorSchema = z.object({
  error: z.object({
    code: z.literal('INVALID_REQUEST'),
    message: z.string(),
  }),
});

export const listNotificationsRoute = createRoute({
  method: 'get',
  path: '/notifications',
  tags: ['notification'],
  security: [{ bearerAuth: [] }],
  summary: 'List notifications for the current user (paginated)',
  request: {
    query: ListNotificationsRequestSchema,
  },
  responses: {
    200: {
      description: 'Paginated notification list (newest first)',
      content: { 'application/json': { schema: ListNotificationsResponseSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const markAllAsReadRoute = createRoute({
  method: 'post',
  path: '/notifications/read',
  tags: ['notification'],
  security: [{ bearerAuth: [] }],
  summary: 'Mark all unread notifications of the current user as read',
  request: {
    body: {
      content: { 'application/json': { schema: z.unknown() } },
    },
  },
  responses: {
    200: {
      description: 'All UNREAD notifications transitioned to UNOPENED',
      content: { 'application/json': { schema: MarkAllAsReadResponseSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const getUnreadCountRoute = createRoute({
  method: 'get',
  path: '/notifications/status',
  tags: ['notification'],
  security: [{ bearerAuth: [] }],
  summary: 'Get the unread notification count for the current user',
  responses: {
    200: {
      description: 'Unread notification count',
      content: { 'application/json': { schema: NotificationStatusResponseSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const openNotificationRoute = createRoute({
  method: 'post',
  path: '/notifications/{id}/open',
  tags: ['notification'],
  security: [{ bearerAuth: [] }],
  summary: 'Open a notification (set its status to OPENED)',
  request: {
    params: OpenNotificationParamSchema,
    body: {
      content: { 'application/json': { schema: z.unknown() } },
    },
  },
  responses: {
    200: {
      description: 'The opened notification (status=OPENED)',
      content: { 'application/json': { schema: OpenNotificationResponseSchema } },
    },
    400: {
      description: 'Invalid notification id (malformed ObjectId)',
      content: { 'application/json': { schema: NotificationInvalidRequestErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    404: {
      description: 'Notification not found or owned by another user',
      content: { 'application/json': { schema: NotificationNotFoundErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const notificationRoutes = {
  listNotificationsRoute,
  markAllAsReadRoute,
  // `/notifications/status` MUST be registered before `/notifications/{id}/open`
  // so the literal-path route matches first; see the file header.
  getUnreadCountRoute,
  openNotificationRoute,
};
