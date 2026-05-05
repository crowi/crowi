import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import {
  ListNotificationsRequestSchema,
  ListNotificationsResponseSchema,
  MarkAllAsReadResponseSchema,
  OpenNotificationParamSchema,
  OpenNotificationResponseSchema,
  NotificationStatusResponseSchema,
  NotificationNotFoundErrorSchema,
} from '../schemas/notification';
import { AuthenticationRequiredErrorSchema, InternalServerErrorSchema } from '../schemas/common';

const c = initContract();

export const notificationContract = c.router({
  /**
   * List notifications for the current user (paginated).
   * Equivalent to legacy GET /_api/notification.list.
   */
  listNotifications: {
    method: 'GET',
    path: '/notifications',
    query: ListNotificationsRequestSchema,
    responses: {
      200: ListNotificationsResponseSchema,
      401: AuthenticationRequiredErrorSchema,
      500: InternalServerErrorSchema,
    },
    summary: 'List notifications for the current user (paginated)',
  },

  /**
   * Mark all UNREAD notifications of the current user as UNOPENED ("read").
   * Equivalent to legacy POST /_api/notification.read.
   */
  markAllAsRead: {
    method: 'POST',
    path: '/notifications/read',
    // Body is intentionally empty. We use z.unknown() rather than z.undefined()
    // because Express body-parser hydrates req.body to `{}` for empty POSTs,
    // which would fail z.undefined() validation upstream of the handler.
    body: z.unknown(),
    responses: {
      200: MarkAllAsReadResponseSchema,
      401: AuthenticationRequiredErrorSchema,
      500: InternalServerErrorSchema,
    },
    summary: 'Mark all unread notifications of the current user as read',
  },

  /**
   * Open a notification: transitions its status to OPENED.
   * Equivalent to legacy POST /_api/notification.open.
   */
  openNotification: {
    method: 'POST',
    path: '/notifications/:id/open',
    pathParams: OpenNotificationParamSchema,
    // See markAllAsRead for the rationale behind z.unknown().
    body: z.unknown(),
    responses: {
      200: OpenNotificationResponseSchema,
      401: AuthenticationRequiredErrorSchema,
      404: NotificationNotFoundErrorSchema,
      500: InternalServerErrorSchema,
    },
    summary: 'Open a notification (set its status to OPENED)',
  },

  /**
   * Get the unread notification count for the current user.
   * Equivalent to legacy GET /_api/notification.status.
   */
  getUnreadCount: {
    method: 'GET',
    path: '/notifications/status',
    responses: {
      200: NotificationStatusResponseSchema,
      401: AuthenticationRequiredErrorSchema,
      500: InternalServerErrorSchema,
    },
    summary: 'Get the unread notification count for the current user',
  },
});
