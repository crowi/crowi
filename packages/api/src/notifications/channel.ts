import type { RedisKeyspace } from 'src/util/redis-keyspace';

/**
 * Redis pub/sub channel naming for per-user notification invalidation
 * signals. One channel per recipient so a publish only reaches instances
 * that actually have that user connected and the WebSocket fan-out stays
 * bounded.
 *
 * Kept as a standalone leaf module so the model-layer publisher
 * (`models/notification.ts`) and the WebSocket transport
 * (`notifications/attach.ts`) share the naming without the model
 * having to depend on the transport.
 *
 * `keyspace` is mandatory (feature-redis-key-prefix §1/§2 review round 3):
 * both production callers only ever invoke this once Redis is actually in
 * play (`models/notification.ts`'s publish, `notifications/attach.ts`'s
 * subscribe/unsubscribe — both gated on `crowi.redis` being non-null, at
 * which point `resolveRedisKeyspace(crowi)` always resolves), so there is
 * no legitimate call site that needs a legacy non-instance-scoped literal
 * — keeping one as a default parameter would leave a Redis cross-talk
 * regression reachable from this module regardless of whether any current
 * caller actually exercises it. Every channel this file names is therefore
 * `crowi:<slug>:notifications:user:<userId>`.
 */
export const channelForUser = (userId: string, keyspace: RedisKeyspace): string => keyspace.key('notifications', 'user', userId);
