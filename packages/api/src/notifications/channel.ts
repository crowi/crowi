/**
 * Redis pub/sub channel naming for per-user notification invalidation
 * signals. One channel per recipient (`crowi:notifications:user:<userId>`)
 * so a publish only reaches instances that actually have that user
 * connected and the WebSocket fan-out stays bounded.
 *
 * Kept as a standalone leaf module so the model-layer publisher
 * (`models/notification.ts`) and the WebSocket transport
 * (`notifications/attach.ts`) share the naming without the model
 * having to depend on the transport.
 */
export const NOTIFICATIONS_CHANNEL_PREFIX = 'crowi:notifications:user:';

export const channelForUser = (userId: string): string => `${NOTIFICATIONS_CHANNEL_PREFIX}${userId}`;
